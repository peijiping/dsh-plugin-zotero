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

/** 单次写请求超时（笔记正文较大，比读请求宽松）。 */
export const WRITE_TIMEOUT_MS = 15_000

/**
 * 授权请求超时。
 *
 * `/api/local/authorize` 会挂住直到用户在 Zotero 弹窗里点按钮，因此这里等的是
 * 「人读完一句话并挪一次鼠标」的时间，不能用 {@link REQUEST_TIMEOUT_MS}。
 */
export const AUTHORIZE_TIMEOUT_MS = 5 * 60_000

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

/** PDF.js 静态资产路由；与 API 路由分开注册。 */
export const STATIC_ROUTE_MATCH = '/dsh-zotero/static'

/** 静态资产路由的剥离基准（带尾斜杠）。 */
export const STATIC_ROUTE_PREFIX = `${STATIC_ROUTE_MATCH}/`

/**
 * 网页快照路由，形如 `/dsh-zotero/snapshot/<附件key>/[子路径]`。
 *
 * 用**目录形** URL 而不是 `?key=`：iframe 的 `src` 指向带尾斜杠的目录，
 * 快照里的相对资源就会自然落到 `/snapshot/<key>/foo.png`，不需要改写 HTML。
 * 与 `/api/file` 分开是因为 HTML 要注入脚本、要一套自己的 CSP，且注入后字节数
 * 变了，和 PDF 的 Range 语义没法共存。
 */
export const SNAPSHOT_ROUTE_MATCH = '/dsh-zotero/snapshot'

/** 快照路由的剥离基准（带尾斜杠）。 */
export const SNAPSHOT_ROUTE_PREFIX = `${SNAPSHOT_ROUTE_MATCH}/`

/** 超过这个大小的快照不做注入（直接流式送出，高亮不可用）。 */
export const SNAPSHOT_INJECT_MAX_BYTES = 32 * 1024 * 1024

/**
 * 写端点要求的自定义请求头。
 *
 * 回环 + `sec-fetch-site` 只挡住「浏览器直接访问本机端口」，挡不住被诱发的表单
 * 式请求。带上自定义头后任何跨源写都成为非简单请求，必须先过 preflight ——
 * 而我们从不回应 CORS 预检，网页就驱动不了删除。头值内容无意义，存在即可。
 */
export const WRITE_HEADER = 'x-dsh-zotero-write'

/** 授权弹窗里展示给用户的应用名。 */
export const AUTHORIZE_APP_NAME = 'DSH Zotero 插件'

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
  /**
   * 写入总开关（默认关）。
   *
   * 同时是回滚开关：关掉后面板与模型侧的写端点一律拒绝，读能力不受影响。
   * 面板是只读的，但写路径一旦可达就可能被误操作，故显式开关比隐式可用安全。
   */
  writeEnabled: boolean
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
  writeEnabled: false,
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
