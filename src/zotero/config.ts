/**
 * Zotero 侧常量：本地 API 端点、文库前缀、超时与截断阈值。
 *
 * 全部端点均为回环地址：这既是安全边界（不对外暴露），也是硬限制
 * （异机 / 容器内不可用）。
 */

/** Zotero 本地 API 根地址。 */
export const ZOTERO_BASE = 'http://127.0.0.1:23119'

/** 探活端点（响应头带 Zotero-API-Version / Server-ID / Schema-Version）。 */
export const ZOTERO_PROBE_URL = `${ZOTERO_BASE}/api/`

/** 当前用户文库前缀（群组文库不在 v1 范围）。 */
export const LIBRARY_PREFIX = '/api/users/0'

/** Zotero 集成 MCP 的 Streamable HTTP 端点。 */
export const MCP_URL = 'http://127.0.0.1:23120/mcp'

/** 单次本地 API 请求超时。 */
export const REQUEST_TIMEOUT_MS = 5000

/** 探活 MCP 端口的 TCP 连接超时。 */
export const MCP_PROBE_TIMEOUT_MS = 800

/** 单次集成 MCP 工具调用的超时（精读 PDF 可能很慢）。 */
export const MCP_CALL_TIMEOUT_MS = 120_000

/** 全文单条最大返回字节数，超出则以 truncated 标记。 */
export const FULLTEXT_MAX_BYTES = 200 * 1024

/** Client 默认取条目数上限。 */
export const DEFAULT_LIMIT = 50

/** Host 路由前缀（Client 的 fetch 路径与 handler 的剥离基准）。 */
export const ROUTE_PREFIX = '/dsh-zotero/api/'

/**
 * 注册到 `webServer` 的 prefix 路径。
 *
 * 必须**不带尾斜杠**：宿主按 `pathname === prefix || pathname.startsWith(prefix + '/')`
 * 匹配，带尾斜杠会变成 `.../api//health`，永远匹配不上。
 */
export const ROUTE_MATCH = '/dsh-zotero/api'

// ---- 运行时设置（可由插件页配置覆盖） ---------------------------------------

/** 可在 dsh「插件」页里编辑的字段；默认值即上面的常量。 */
export interface ZoteroSettings {
  zoteroBaseUrl: string
  mcpUrl: string
  requestTimeoutMs: number
  mcpProbeTimeoutMs: number
  fulltextMaxBytes: number
  defaultLimit: number
  /** 被用户关闭的集成 MCP 工具**原始名**（模型侧据此过滤）。 */
  disabledMcpTools: string[]
}

/** 默认读取器：入口未注入时回落到常量。 */
let readSettings = (): ZoteroSettings => ({
  zoteroBaseUrl: ZOTERO_BASE,
  mcpUrl: MCP_URL,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  mcpProbeTimeoutMs: MCP_PROBE_TIMEOUT_MS,
  fulltextMaxBytes: FULLTEXT_MAX_BYTES,
  defaultLimit: DEFAULT_LIMIT,
  disabledMcpTools: [],
})

/**
 * 由插件入口在 `apply` 时注入。
 *
 * 回调内部逐次读取 volatile 引用，因此用户保存配置后**无需重启**即取到新值。
 */
export function setSettingsReader(reader: () => ZoteroSettings): void {
  readSettings = reader
}

/** 读取当前生效的设置。 */
export function getSettings(): ZoteroSettings {
  return readSettings()
}

/** 探活 URL（由 `zoteroBaseUrl` 派生）。 */
export function zoteroProbeUrl(): string {
  return `${getSettings().zoteroBaseUrl}/api/`
}

/** 文库端点前缀（由 `zoteroBaseUrl` 派生）。 */
export function libraryBase(): string {
  return `${getSettings().zoteroBaseUrl}${LIBRARY_PREFIX}`
}
