/**
 * Host 侧 HTTP 路由：`/dsh-zotero/api/<action>`。
 *
 * 统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`（设计方案 §6）。
 * 信任栅栏：拒绝 `sec-fetch-site: cross-site`，且 Host 头必须是回环地址
 * （防御 DNS rebinding）。读端点无需会话 cookie。
 *
 * 写端点（{@link WRITE_ACTIONS}）在此之上再加两道：必须带自定义头
 * `x-dsh-zotero-write` 且 `content-type: application/json`。跨源要凑出这两样就成了
 * 非简单请求，必须先过 CORS 预检 —— 而我们从不回应预检，于是任何网页都驱动不了
 * 本插件的写入与删除。
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import * as zotero from '../zotero/client.js'
import { ZoteroError } from '../zotero/client.js'
import { createAnnotations, deleteAnnotation, patchAnnotation } from '../zotero/annotation-writes.js'
import { DEFAULT_LIMIT, getSettings, ROUTE_PREFIX, WRITE_HEADER } from '../zotero/config.js'
import { createNote, deleteNote, updateNote } from '../zotero/notes.js'
import { loadPosition, savePosition } from '../zotero/read-position.js'
import { authorize, writeChannelStatus } from '../zotero/write.js'
import type {
  ApiEnvelope,
  ApiError,
  ApiErrorCode,
  ZoteroAuthResult,
  ZoteroAttachmentInfo,
  ZoteroCollectionBib,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemScope,
  ZoteroItems,
  ZoteroNoteRaw,
  ZoteroTags,
  ZoteroTree,
  ZoteroWriteRef,
  ZoteroWriteStatus,
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

/**
 * 会改动 Zotero 数据、或会触发 Zotero 弹窗的 action。
 *
 * 光靠回环 + `sec-fetch-site` 挡不住「本机上别的网页/内嵌视图诱导的表单式请求」；
 * 这批 action 额外要求 {@link hasWriteIntent}。
 */
const WRITE_ACTIONS = new Set([
  'open-in-zotero',
  'authorize',
  'note-create',
  'note-update',
  'note-delete',
  'annotation-patch',
  'annotation-delete',
  'annotation-create',
  'read-position-save',
])

/** 自定义写头 + JSON content-type：让任何跨源写都变成需要预检的非简单请求。 */
function hasWriteIntent(req: IncomingMessage): boolean {
  if (req.headers[WRITE_HEADER] !== '1') return false
  const type = req.headers['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
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

/**
 * 错误码 → 对外 HTTP 状态。
 *
 * 保持与旧行为一致（读端点的 unreachable/disabled 仍是 502），写通道新增的码按
 * Zotero 自己的语义透传，Client 据此区分「重新授权」与「刷新重试」。
 */
const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  zotero_unreachable: 502,
  zotero_disabled: 502,
  zotero_not_found: 404,
  bad_request: 400,
  internal_error: 500,
  zotero_need_auth: 401,
  zotero_denied: 403,
  zotero_stale: 412,
  zotero_conflict: 409,
  zotero_rate_limited: 429,
}

function toApiError(error: unknown): { status: number; error: ApiError } {
  if (error instanceof ZoteroError) {
    return { status: STATUS_BY_CODE[error.code] ?? 500, error: { code: error.code, message: error.message } }
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

/**
 * 写通道状态（开关 + 是否持有可复用的 key）。
 *
 * 只报状态、不碰 Zotero：配置卡每次展开都会读一次，不该为此发请求。key 的读取
 * 全在本机（本插件副本 / Zotero 密钥库），也不涉及网络。
 */
async function handleAuthStatus(res: ServerResponse): Promise<void> {
  const data: ZoteroWriteStatus = await writeChannelStatus()
  ok(res, data)
}

/**
 * 申请 Zotero 写权限。
 *
 * 这条请求会挂住直到用户在 Zotero 弹窗里点按钮（分钟级），因此前端必须在等待期
 * 间禁用按钮 —— 重复触发只会撞上 Zotero 的每分钟 5 次授权限流。
 */
async function handleAuthorize(res: ServerResponse): Promise<void> {
  const data: ZoteroAuthResult = await authorize()
  ok(res, data)
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
  // 排序：只认按标题，方向缺省正序；不认识的取值一律退回原始顺序。
  const sortDirection = params.get('direction') === 'desc' ? 'desc' : 'asc'
  const sort = params.get('sort') === 'title' ? 'title' as const : undefined
  const limit = clampLimit(params.get('limit'))
  const offset = parseOffset(params.get('offset'))
  const result = await zotero.listItems({
    scope: scopeParam === null ? undefined : scopeParam,
    collectionKey,
    q,
    tags,
    tagMode,
    sort,
    direction: sort === undefined ? undefined : sortDirection,
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
export const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u

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
  // `getAttachmentFile` 已经把 MIME 规范化过了（小写、无参数、缺失时按后缀兜底）。
  const contentType = file.contentType
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
  // 客户端中途关掉（关面板、pdf.js 放弃这次请求）就把文件句柄一起放掉，
  // 否则大 PDF 的读流会一直挂到进程结束。
  res.on('close', () => stream.destroy())
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * 附件可读性探测：只回答「这个附件的文件在不在、是什么、能不能预览」。
 *
 * 存在的唯一理由是**把 `/api/file` 的失败原因说清楚**。那条路径的响应体是
 * 二进制流，失败时 pdf.js 只能看到状态码，用户拿到的是
 * 「Unexpected server response (404) while retrieving PDF "dsh-app://…"」；
 * 前端在此之后调一次本端点，就能把「附件文件不存在：/path/xxx.pdf」
 * 这种能自己动手修的信息显示出来。
 */
async function handleAttachmentInfo(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const key = params.get('key') ?? ''
  if (!KEY_PATTERN.test(key)) {
    fail(res, 400, 'bad_request', '附件 key 格式不合法')
    return
  }
  const file = await zotero.getAttachmentFile(key)
  const data: ZoteroAttachmentInfo = {
    key: file.key,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    servable: SERVABLE_TYPES.has(file.contentType),
  }
  ok(res, data)
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
  const record = await readJsonBody(req, 4096)
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

// ---- 阅读位置 ---------------------------------------------------------------

/**
 * 某个附件在**本插件里**上次读到第几页；没记过时数据为 `null`。
 *
 * 与 Zotero 无关：不读它的数据目录、不读它的库文件（Zotero 运行期对
 * `zotero.sqlite` 持独占锁，而 `dataDir` 又可能是任意位置，靠不住）。
 */
async function handleReadPosition(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const key = params.get('key') ?? ''
  if (!KEY_PATTERN.test(key)) {
    fail(res, 400, 'bad_request', '附件 key 格式不合法')
    return
  }
  ok(res, await loadPosition(key))
}

/** 记下本插件读到第几页（0 基）。与 Zotero 不同步，只记在自己这儿。 */
async function handleReadPositionSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, 4096)
  const key = requireKey(record, 'key')
  const pageIndex = record.pageIndex
  if (
    typeof pageIndex !== 'number'
    || !Number.isInteger(pageIndex)
    || pageIndex < 0
    || pageIndex > 100_000
  ) {
    throw new ZoteroError('bad_request', 'pageIndex 必须是从 0 开始的整数页码')
  }
  ok(res, await savePosition(key, pageIndex))
}

// ---- 笔记读写 ---------------------------------------------------------------

/**
 * 笔记写请求的 body 上限。
 *
 * 正文本身另有一条 512 KB 的语义上限（在 `notes.ts` 里查），这里给的是 JSON 信封
 * 加转义后的宽松天花板——`"` 会变成 `\"`，按最坏情况留 4 倍余量。
 */
const NOTE_BODY_LIMIT = 2 * 1024 * 1024

/** 读取并解析 JSON 请求体；非对象一律按空对象处理，交给字段校验报错。 */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  let input: unknown
  try {
    input = JSON.parse(await readBody(req, limit))
  } catch (error) {
    if (error instanceof ZoteroError) throw error
    throw new ZoteroError('bad_request', '请求体不是合法 JSON')
  }
  return (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
}

/** 取一个合法的 Zotero key。 */
export function requireKey(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new ZoteroError('bad_request', `${field} 不是合法的 Zotero key`)
  }
  return value
}

/**
 * 取条目版本。
 *
 * 缺失就不发请求，而不是让 Zotero 收到一个 `NaN` / `0` 的前置条件：前者会被判 428，
 * 后者判 412，两种都要用户在错误文案里猜「我什么都没填，怎么就版本不符」。
 */
function requireVersion(record: Record<string, unknown>): number {
  const version = record.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    throw new ZoteroError('bad_request', '缺少 version：写入必须带上该条目当前的版本号。')
  }
  return version
}

function requireNoteBody(record: Record<string, unknown>): string {
  const note = record.note
  if (typeof note !== 'string') throw new ZoteroError('bad_request', 'note 必须是字符串')
  return note
}

/** 笔记原始正文：不经清洗、不截断，只给编辑器用。 */
async function handleNoteRaw(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const raw = params.get('key')
  if (raw === null || !KEY_PATTERN.test(raw)) {
    fail(res, 400, 'bad_request', '笔记 key 格式不合法')
    return
  }
  const data: ZoteroNoteRaw = await zotero.getNoteRaw(raw)
  ok(res, data)
}

async function handleNoteCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, NOTE_BODY_LIMIT)
  const data: ZoteroWriteRef = await createNote({
    parentItem: requireKey(record, 'parentItem'),
    note: requireNoteBody(record),
  })
  ok(res, data)
}

async function handleNoteUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, NOTE_BODY_LIMIT)
  const key = requireKey(record, 'key')
  await updateNote({ key, version: requireVersion(record), note: requireNoteBody(record) })
  // PATCH 回 204，没有条目版本可报；面板随后整份重取详情。
  ok(res, { key, version: null })
}

async function handleNoteDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, 4096)
  const key = requireKey(record, 'key')
  await deleteNote({ key, version: requireVersion(record) })
  ok(res, { key, version: null })
}

// ---- 标注写 -----------------------------------------------------------------

/**
 * 标注写请求的 body 上限。
 *
 * 标注只有短字段（评论、页码、标签），64 KB 已经是「把整段论文粘进评论」的量级；
 * 真正的语义上限（评论 16 KB）在 `annotation-writes.ts` 里查。
 */
const ANNOTATION_BODY_LIMIT = 64 * 1024

async function handleAnnotationPatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, ANNOTATION_BODY_LIMIT)
  const key = requireKey(record, 'key')
  // `patch` 的字段白名单与取值规则都在 annotation-writes 里查：面板和模型工具共用同一套。
  await patchAnnotation({ key, version: requireVersion(record), patch: record.patch })
  ok(res, { key, version: null })
}

async function handleAnnotationDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, 4096)
  const key = requireKey(record, 'key')
  await deleteAnnotation({ key, version: requireVersion(record) })
  ok(res, { key, version: null })
}

/**
 * 新建标注的 body 上限。
 *
 * 比改字段宽得多：一条 drafts 里带着选中原文，整段跨页选区能有几万字。真正的条数与
 * 长度上限在 `annotation-writes.ts` 里查。
 */
const ANNOTATION_CREATE_BODY_LIMIT = 512 * 1024

async function handleAnnotationCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = await readJsonBody(req, ANNOTATION_CREATE_BODY_LIMIT)
  const created = await createAnnotations({
    parentItem: requireKey(record, 'parentItem'),
    annotations: record.annotations,
  })
  ok(res, created)
}

/**
 * action → 允许的 HTTP 方法。
 *
 * 写 action 一律走 `POST /<verb>` 形态（真实 Zotero 动词由 write.ts 决定），这样
 * 面板侧只需一个 `post()` 助手，方法白名单也只有一 GET / POST 两种，好核对。
 * 用 Map 而非对象字面量：`action` 来自 URL，`constructor` 之类的名字不该命中原型链。
 */
const ROUTE_METHODS = new Map<string, 'GET' | 'POST'>([
  ['health', 'GET'],
  ['tree', 'GET'],
  ['items', 'GET'],
  ['tags', 'GET'],
  ['tag-usage', 'GET'],
  ['item', 'GET'],
  ['collection-bib', 'GET'],
  ['file', 'GET'],
  ['attachment-info', 'GET'],
  ['mcp-tools', 'GET'],
  ['auth-status', 'GET'],
  ['read-position', 'GET'],
  ['note-raw', 'GET'],
  ['open-in-zotero', 'POST'],
  ['authorize', 'POST'],
  ['note-create', 'POST'],
  ['note-update', 'POST'],
  ['note-delete', 'POST'],
  ['annotation-patch', 'POST'],
  ['annotation-delete', 'POST'],
  ['annotation-create', 'POST'],
  ['read-position-save', 'POST'],
])

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
    const allowedMethod = ROUTE_METHODS.get(action)
    if (allowedMethod === undefined) {
      fail(res, 404, 'bad_request', `未知 action ${action}`)
      return
    }
    if (method !== allowedMethod) {
      fail(res, 405, 'bad_request', `该端点仅支持 ${allowedMethod}，收到 ${method}`)
      return
    }
    if (WRITE_ACTIONS.has(action) && !hasWriteIntent(req)) {
      fail(res, 403, 'bad_request', '拒绝未带写标记的请求')
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
        case 'attachment-info':
          await handleAttachmentInfo(res, url.searchParams)
          return
        case 'open-in-zotero':
          await handleOpenInZotero(req, res)
          return
        case 'mcp-tools':
          await handleMcpTools(res, deps)
          return
        case 'auth-status':
          await handleAuthStatus(res)
          return
        case 'read-position':
          await handleReadPosition(res, url.searchParams)
          return
        case 'authorize':
          await handleAuthorize(res)
          return
        case 'note-raw':
          await handleNoteRaw(res, url.searchParams)
          return
        case 'note-create':
          await handleNoteCreate(req, res)
          return
        case 'note-update':
          await handleNoteUpdate(req, res)
          return
        case 'note-delete':
          await handleNoteDelete(req, res)
          return
        case 'annotation-patch':
          await handleAnnotationPatch(req, res)
          return
        case 'annotation-delete':
          await handleAnnotationDelete(req, res)
          return
        case 'annotation-create':
          await handleAnnotationCreate(req, res)
          return
        case 'read-position-save':
          await handleReadPositionSave(req, res)
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
