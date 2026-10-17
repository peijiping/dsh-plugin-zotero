/**
 * Host 侧只读 HTTP 路由：`GET /dsh-zotero/api/<action>`。
 *
 * 统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`（设计方案 §6）。
 * 信任栅栏：拒绝 `sec-fetch-site: cross-site`，且 Host 头必须是回环地址
 * （防御 DNS rebinding）。只读端点，无需会话 cookie。
 */

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
  ZoteroItems,
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

function isTrusted(req: IncomingMessage): boolean {
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

async function handleItems(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const collectionKey = params.get('collectionKey') ?? undefined
  const q = params.get('q') ?? undefined
  const limit = clampLimit(params.get('limit'))
  const offset = parseOffset(params.get('offset'))
  const result = await zotero.listItems({ collectionKey, q, limit, offset })
  const data: ZoteroItems = { total: result.total, items: result.items }
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

/** 构造挂在 `webServer` 上的前缀路由处理器。 */
export function createHandler(
  deps: HandlerDeps = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      fail(res, 405, 'bad_request', `仅支持 GET，收到 ${req.method ?? '未知'}`)
      return
    }
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
        case 'item':
          await handleItem(res, url.searchParams)
          return
        case 'collection-bib':
          await handleCollectionBib(res, url.searchParams)
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
