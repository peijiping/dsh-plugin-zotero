/**
 * Host 侧只读 HTTP 路由：`GET /dsh-zotero/api/<action>`。
 *
 * 统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`（设计方案 §6）。
 * 信任栅栏：拒绝 `sec-fetch-site: cross-site`，且 Host 头必须是回环地址
 * （防御 DNS rebinding）。只读端点，无需会话 cookie。
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import * as zotero from '../zotero/client.js'
import { ZoteroError } from '../zotero/client.js'
import { DEFAULT_LIMIT, getSettings, ROUTE_PREFIX } from '../zotero/config.js'
import type {
  ApiEnvelope,
  ApiError,
  ApiErrorCode,
  ZoteroCollectionBib,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemScope,
  ZoteroItems,
  ZoteroTags,
  ZoteroTree,
} from '../zotero/types.js'

/** dsh `webServer` 的最小结构接口（类型不在已安装的 dsh 包里）。 */
export interface WebServerLike {
  register(options: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 路由可注入的钩子。 */
export interface HandlerDeps {
  /**
   * 读取工具清单时顺带重建注册（卡片打开/保存后调用），返回同一份清单。
   * 缺省时只读清单、不动注册。
   */
  syncTools?: () => Promise<zotero.McpToolInfo[]>
}

/** 单条条目列表的条数上限，防止 Client 拉爆宿主。 */
const MAX_LIMIT = 200

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const host = hostHeader.replace(/:\d+$/u, '').toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

export function isTrusted(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false
  return isLoopbackHost(req.headers.host)
}

function sendJson(res: ServerResponse, status: number, payload: ApiEnvelope<unknown>): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res: ServerResponse, status: number, code: ApiErrorCode, message: string): void {
  const error: ApiError = { code, message }
  sendJson(res, status, { ok: false, error })
}

function ok<T>(res: ServerResponse, data: T): void {
  sendJson(res, 200, { ok: true, data })
}

function toApiError(error: unknown): { status: number; error: ApiError } {
  if (error instanceof ZoteroError) {
    const status = error.code === 'zotero_not_found' ? 404 : error.code === 'bad_request' ? 400 : 502
    return { status, error: { code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, error: { code: 'internal_error', message } }
}

function clampLimit(raw: string | null): number {
  const fallback = Math.floor(getSettings().defaultLimit) || DEFAULT_LIMIT
  const parsed = raw === null ? fallback : Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, MAX_LIMIT)
}

function parseOffset(raw: string | null): number {
  const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed
}

async function handleHealth(res: ServerResponse): Promise<void> {
  const [zoteroInfo, mcpRunning, libraryName] = await Promise.all([
    zotero.probe(),
    zotero.probeMcp(),
    zotero.getLibraryName().catch(() => '我的文库'),
  ])
  const data: ZoteroHealth = {
    zotero: zoteroInfo,
    library: { id: 'users/0', name: libraryName },
    mcp: { running: mcpRunning },
  }
  ok(res, data)
}

/**
 * 集成 MCP 的工具清单（供插件页「MCP 设置」组渲染开关）。
 * 有 `syncTools` 时顺带按最新 `disabledMcpTools` 重建工具注册。
 */
async function handleMcpTools(res: ServerResponse, deps: HandlerDeps): Promise<void> {
  const tools = deps.syncTools ? await deps.syncTools() : await zotero.listMcpTools()
  ok(res, { tools })
}

async function handleTree(res: ServerResponse): Promise<void> {
  const [collections, libraryName] = await Promise.all([
    zotero.listCollections(),
    zotero.getLibraryName().catch(() => '我的文库'),
  ])
  const data: ZoteroTree = { collections, libraryName }
  ok(res, data)
}

/** 合法的条目列表范围（虚拟分类）。 */
const SCOPES = ['library', 'publications', 'unfiled', 'trash'] as const

function isScope(value: string): value is ZoteroItemScope {
  return (SCOPES as readonly string[]).includes(value)
}

async function handleItems(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const scopeParam = params.get('scope')
  if (scopeParam !== null && !isScope(scopeParam)) {
    fail(res, 400, 'bad_request', `未知 scope ${scopeParam}`)
    return
  }
  const collectionKey = params.get('collectionKey') ?? undefined
  const q = params.get('q') ?? undefined
  const tags = params.getAll('tag').map((tag) => tag.trim()).filter((tag) => tag !== '')
  const tagMode = params.get('tagMode') === 'any' ? 'any' : 'all'
  const limit = clampLimit(params.get('limit'))
  const offset = parseOffset(params.get('offset'))
  const result = await zotero.listItems({
    scope: scopeParam === null ? undefined : scopeParam,
    collectionKey,
    q,
    tags,
    tagMode,
    limit,
    offset,
  })
  const data: ZoteroItems = { total: result.total, items: result.items }
  ok(res, data)
}

async function handleTags(res: ServerResponse): Promise<void> {
  const data: ZoteroTags = await zotero.listTags()
  ok(res, data)
}

/** 当前范围内的标签用量（供标签面板列出范围标签）。 */
async function handleTagUsage(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const scopeParam = params.get('scope')
  if (scopeParam !== null && !isScope(scopeParam)) {
    fail(res, 400, 'bad_request', `未知 scope ${scopeParam}`)
    return
  }
  const collectionKeys = params.getAll('collectionKey')
    .map((key) => key.trim())
    .filter((key) => key !== '')
  const data: ZoteroTags = await zotero.listTagUsage({
    scope: scopeParam === null ? undefined : scopeParam,
    collectionKeys: collectionKeys.length === 0 ? undefined : collectionKeys,
    q: params.get('q') ?? undefined,
  })
  ok(res, data)
}

async function handleItem(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const key = params.get('key')
  if (!key) {
    fail(res, 400, 'bad_request', '缺少必填参数 key')
    return
  }
  const style = params.get('style') ?? 'apa'
  const data: ZoteroItemDetail = await zotero.getItemDetail(key, style)
  ok(res, data)
}

async function handleCollectionBib(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const key = params.get('key')
  if (!key) {
    fail(res, 400, 'bad_request', '缺少必填参数 key')
    return
  }
  const style = params.get('style') ?? 'apa'
  const data: ZoteroCollectionBib = await zotero.getCollectionBib(key, style)
  ok(res, data)
}

/** Zotero key：8 位，字母表排除了易混淆的 0 / 1 / O。 */
const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u

/** 允许直接流式读取的附件类型；后续加 Word 等格式只需在此追加。 */
const SERVABLE_TYPES = new Set(['application/pdf'])

interface ByteRange {
  start: number
  end: number
}

/** 只支持单段 Range；`null` 表示无 Range，`'invalid'` 表示应回 416。 */
function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (header === undefined || header.trim() === '') return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return 'invalid'
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart, 10)
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** RFC 5987 的 `filename*` 编码。 */
function encodeFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/gu, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function handleFile(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): Promise<void> {
  const key = params.get('key') ?? ''
  if (!KEY_PATTERN.test(key)) {
    fail(res, 400, 'bad_request', '附件 key 格式不合法')
    return
  }
  const file = await zotero.getAttachmentFile(key)
  const contentType = file.contentType.split(';')[0].trim().toLowerCase()
  if (!SERVABLE_TYPES.has(contentType)) {
    fail(res, 415, 'bad_request', `暂不支持预览 ${file.contentType || '该附件类型'}`)
    return
  }
  const range = parseRange(req.headers.range, file.size)
  if (range === 'invalid') {
    res.writeHead(416, {
      'content-range': `bytes */${file.size}`,
      'cache-control': 'no-store',
    })
    res.end()
    return
  }
  const headers: Record<string, string | number> = {
    'content-type': contentType,
    'content-disposition': `inline; filename*=UTF-8''${encodeFilename(file.filename)}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  let stream
  if (range === null) {
    headers['content-length'] = file.size
    res.writeHead(200, headers)
    stream = createReadStream(file.path)
  } else {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${file.size}`
    headers['content-length'] = range.end - range.start + 1
    res.writeHead(206, headers)
    stream = createReadStream(file.path, { start: range.start, end: range.end })
  }
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** 用系统默认处理器打开 `zotero://` URL；参数数组传递，不经过 shell。 */
function openExternal(url: string): Promise<void> {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'rundll32'
      : 'xdg-open'
  const args = process.platform === 'win32'
    ? ['url.dll,FileProtocolHandler', url]
    : [url]
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
    child.once('error', (error) => {
      reject(new ZoteroError('internal_error', `无法打开 Zotero：${error.message}`))
    })
  })
}

/** 读取小请求体；超过上限直接拒绝，避免被大 body 拖住。 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > limit) throw new ZoteroError('bad_request', '请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function handleOpenInZotero(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let input: unknown
  try {
    input = JSON.parse(await readBody(req, 4096))
  } catch (error) {
    if (error instanceof ZoteroError) throw error
    fail(res, 400, 'bad_request', '请求体不是合法 JSON')
    return
  }
  const record = (typeof input === 'object' && input !== null ? input : {}) as {
    key?: unknown
    kind?: unknown
    page?: unknown
  }
  const key = typeof record.key === 'string' ? record.key : ''
  const kind = record.kind === 'item' || record.kind === 'attachment' ? record.kind : null
  if (!KEY_PATTERN.test(key) || kind === null) {
    fail(res, 400, 'bad_request', 'key 或 kind 不合法')
    return
  }
  let url = `zotero://select/library/items/${key}`
  if (kind === 'attachment') {
    if (
      record.page !== undefined
      && (typeof record.page !== 'number'
        || !Number.isInteger(record.page)
        || record.page < 1
        || record.page > 10000)
    ) {
      fail(res, 400, 'bad_request', 'page 必须是 1–10000 的整数')
      return
    }
    url = `zotero://open-pdf/library/items/${key}`
    if (record.page !== undefined) url += `?page=${record.page}`
  }
  await openExternal(url)
  ok(res, { opened: true })
}

/** 构造挂在 `webServer` 上的前缀路由处理器。 */
export function createHandler(
  deps: HandlerDeps = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!isTrusted(req)) {
      fail(res, 403, 'bad_request', '拒绝非回环来源的请求')
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      fail(res, 404, 'bad_request', `未知路由 ${url.pathname}`)
      return
    }
    const action = url.pathname.slice(ROUTE_PREFIX.length)
    const method = req.method ?? 'GET'
    const allowedMethod = action === 'open-in-zotero' ? 'POST' : 'GET'
    if (method !== allowedMethod) {
      fail(res, 405, 'bad_request', `该端点仅支持 ${allowedMethod}，收到 ${method}`)
      return
    }

    try {
      switch (action) {
        case 'health':
          await handleHealth(res)
          return
        case 'tree':
          await handleTree(res)
          return
        case 'items':
          await handleItems(res, url.searchParams)
          return
        case 'tags':
          await handleTags(res)
          return
        case 'tag-usage':
          await handleTagUsage(res, url.searchParams)
          return
        case 'item':
          await handleItem(res, url.searchParams)
          return
        case 'collection-bib':
          await handleCollectionBib(res, url.searchParams)
          return
        case 'file':
          await handleFile(req, res, url.searchParams)
          return
        case 'open-in-zotero':
          await handleOpenInZotero(req, res)
          return
        case 'mcp-tools':
          await handleMcpTools(res, deps)
          return
        default:
          fail(res, 404, 'bad_request', `未知 action ${action}`)
          return
      }
    } catch (error) {
      const { status, error: apiError } = toApiError(error)
      fail(res, status, apiError.code, apiError.message)
    }
  }
}
