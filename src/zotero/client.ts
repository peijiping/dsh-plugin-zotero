/**
 * Zotero 本地 API 客户端（只读）。
 *
 * 全部走 Node 全局 `fetch`；无鉴权（本地 API 的读端点不需要），
 * 失败统一归一化为 {@link ZoteroError}，由 router 转成 §6 的错误码。
 *
 * 实测要点（本机 Zotero 10.0.6 / Zotero-API-Version 3）：
 * - 列表端点的总数在响应头 `Total-Results` 里。
 * - 顶层条目本身可能是附件（直接导入的 PDF），此时 `itemType === 'attachment'`。
 * - 附件大小来自 `links.enclosure.length`（`data` 里没有 size）。
 * - `/collections/<key>/items?format=bib` 返回**空** csl-bib-body；
 *   要拿整目录引用必须走 `/items?itemKey=a,b&format=bib`（每批 ≤ 50）。
 * - `?include=bib` 会让响应**丢掉 `data`**，因此条目详情与 bib 必须分两次请求。
 */

import { stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

import { anchorAnnotations, type RawAnnotation } from './annotations.js'
import {
  getSettings,
  libraryBase,
  MCP_CALL_TIMEOUT_MS,
  zoteroProbeUrl,
} from './config.js'
import type {
  ApiErrorCode,
  ZoteroAnnotation,
  ZoteroAnnotationState,
  ZoteroAttachment,
  ZoteroAttachmentFile,
  ZoteroCollection,
  ZoteroFulltext,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemScope,
  ZoteroItemSummary,
  ZoteroNote,
  ZoteroNoteRaw,
  ZoteroTag,
  ZoteroTagRef,
  ZoteroTags,
} from './types.js'

/** 归一化后的 Zotero 访问错误。 */
export class ZoteroError extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.name = 'ZoteroError'
    this.code = code
  }
}

// ---- 原始响应形状（只声明用到的字段） --------------------------------------

interface RawCreator {
  name?: string
  firstName?: string
  lastName?: string
  creatorType?: string
}

interface RawTag {
  tag?: string
  /** 条目 `data.tags` 上的类型（0 自动标签，1 手动标签）；`/tags` 端点在 `meta.type`。 */
  type?: number
  meta?: {
    /** 0 自动标签，1 手动标签。 */
    type?: number
    numItems?: number
  }
}

interface RawItemData {
  itemType?: string
  /** 条目版本：写操作的并发前置条件。顶层 `raw.version` 的兜底来源。 */
  version?: number
  title?: string
  abstractNote?: string
  date?: string
  publicationTitle?: string
  url?: string
  DOI?: string
  creators?: RawCreator[]
  tags?: RawTag[]
  collections?: string[]
  contentType?: string
  filename?: string
  /** 笔记正文（HTML），仅 `itemType === 'note'` 有。 */
  note?: string
  /** 标注所属附件，仅 `itemType === 'annotation'` 有。 */
  parentItem?: string | false
  /** 附件最后阅读时间（Unix 秒）；本地 API 在附件 JSON 里直接给出。 */
  lastRead?: number
  annotationType?: string
  annotationText?: string
  annotationComment?: string
  annotationColor?: string
  annotationPageLabel?: string
  annotationSortIndex?: string
  /** JSON 字符串：`{pageIndex, rects}`；缺失或墨迹标注没有。 */
  annotationPosition?: string
  dateModified?: string
}

interface RawEnclosure {
  href?: string
  type?: string
  title?: string
  length?: number
}

interface RawItem {
  key: string
  version?: number
  meta?: {
    creatorSummary?: string
    parsedDate?: string
    numChildren?: number
    numItems?: number
  }
  links?: {
    enclosure?: RawEnclosure
  }
  data?: RawItemData
}

// ---- 底层请求 ---------------------------------------------------------------

function shortMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function request(url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(getSettings().requestTimeoutMs) })
  } catch (error) {
    throw new ZoteroError(
      'zotero_unreachable',
      `无法连接 Zotero 本地 API（${getSettings().zoteroBaseUrl}）：${shortMessage(error)}`,
    )
  }
  if (res.status === 403) {
    throw new ZoteroError(
      'zotero_disabled',
      'Zotero 本地 API 未开放：请在 Zotero「设置 → 高级 → 其他」中勾选「允许本机其他应用与 Zotero 通信」。',
    )
  }
  if (res.status === 404) {
    throw new ZoteroError('zotero_not_found', `Zotero 中找不到该资源（404）：${url}`)
  }
  if (!res.ok) {
    throw new ZoteroError('bad_request', `Zotero 本地 API 返回 ${res.status} ${res.statusText}`)
  }
  return res
}

async function requestJson<T>(url: string): Promise<{ body: T; total: number | null }> {
  const res = await request(url)
  const raw = (await res.json()) as T
  const totalHeader = res.headers.get('total-results')
  const total = totalHeader === null ? null : Number.parseInt(totalHeader, 10)
  return { body: raw, total: Number.isNaN(total as number) ? null : total }
}

async function requestText(url: string): Promise<{ body: string; total: number | null }> {
  const res = await request(url)
  const body = await res.text()
  const totalHeader = res.headers.get('total-results')
  const total = totalHeader === null ? null : Number.parseInt(totalHeader, 10)
  return { body, total: Number.isNaN(total as number) ? null : total }
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

// ---- 归一化辅助 -------------------------------------------------------------

function creatorName(creator: RawCreator): string {
  if (creator.name) return creator.name
  const parts = [creator.lastName, creator.firstName].filter(Boolean)
  return parts.join(', ')
}

function yearOf(meta: RawItem['meta'], data: RawItemData): string {
  const parsed = meta?.parsedDate
  if (parsed && /^\d{4}/.test(parsed)) return parsed.slice(0, 4)
  if (data.date && /^\d{4}/.test(data.date)) return data.date.slice(0, 4)
  return ''
}

function attachmentTitle(raw: RawItem): string {
  return raw.data?.title || raw.data?.filename || '(无标题附件)'
}

function toAttachment(raw: RawItem): ZoteroAttachment {
  return {
    key: raw.key,
    title: attachmentTitle(raw),
    filename: raw.data?.filename ?? '',
    contentType: raw.data?.contentType ?? '',
    // 本地 API 只在 links.enclosure.length 上暴露大小；缺失时记 0。
    size: raw.links?.enclosure?.length ?? 0,
  }
}

// ---- 笔记正文清洗 ------------------------------------------------------------

/**
 * 笔记正文清洗。
 *
 * Zotero 的笔记 HTML 里塞了大量冗余标记，必须处理后再交给前端渲染：
 * - `data-citation-items`：整份被引条目的 JSON（URL 编码），单条笔记能占几 KB；
 * - `data-pid` / `data-first-child` 等 ProseMirror 内部标记；
 * - `data-original-token` / `data-rawwidth` 等图片内部属性。
 *
 * 同时去掉脚本类标签与事件属性，避免正文里的原始 HTML 被直接注入 DOM。
 * 图片的 `src` 保留（外链图），并去掉 `data-original-token` 等冗余属性。
 */
const NOTE_BLOCKED_TAGS = /<(script|style|noscript|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/giu
/** 无闭合标签的阻塞元素（base / link / meta 等）。 */
const NOTE_BLOCKED_VOID = /<\/?(?:base|link|meta)\b[^>]*>/giu
const NOTE_EVENT_ATTR = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu
const NOTE_DATA_ATTR = /\s+data-[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu
const NOTE_JS_URL = /\s+(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/giu

/** 笔记正文最大字节数，超出截断。 */
const NOTE_MAX_BYTES = 200 * 1024

/** HTML 实体解码表（用字符码拼装，避免源码里直接写实体被二次解码）。 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: String.fromCharCode(38),
  lt: String.fromCharCode(60),
  gt: String.fromCharCode(62),
  quot: String.fromCharCode(34),
  apos: String.fromCharCode(39),
}

/** 解码 HTML 实体（命名实体 + 数字实体）。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** 去标签后取纯文本（用于笔记标题摘要）。 */
function toPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<[^>]*>/gu, ' ')
      .replace(/&nbsp;/giu, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 清洗笔记正文 HTML。 */
export function sanitizeNoteHtml(html: string): string {
  return html
    .replace(NOTE_BLOCKED_TAGS, '')
    .replace(NOTE_BLOCKED_VOID, '')
    .replace(NOTE_EVENT_ATTR, '')
    .replace(NOTE_JS_URL, '')
    .replace(NOTE_DATA_ATTR, '')
    // 笔记里的图是外链图，限宽避免撑破右栏。
    .replace(/<img\b([^>]*)>/giu, (match, attrs: string) =>
      attrs.includes('style=') ? match : `<img${attrs} style="max-width:100%;height:auto">`)
    .trim()
}

/** 笔记标题：正文纯文本的前 60 个字符（笔记条目本身没有 title 字段）。 */
function noteTitle(html: string): string {
  const text = toPlainText(html)
  if (text === '') return '(空笔记)'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * 条目版本。
 *
 * 写操作（PATCH / DELETE）缺它就直接 428，因此宁可给 0 也不要给 undefined：
 * 真拿 0 去写会被 Zotero 判成版本不符（412），比「静默盲写」安全。
 * 顶层 `version` 与 `data.version` 实测同时存在，取任一份即可。
 */
function versionOf(raw: RawItem): number {
  const version = raw.version ?? raw.data?.version
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 0
}

/** 父条目 key；顶层条目、独立笔记一律归一成空串。 */
function parentKeyOf(raw: RawItem): string {
  const parent = raw.data?.parentItem
  return typeof parent === 'string' ? parent : ''
}

/**
 * 正文里是否含 Zotero 的结构锚点。
 *
 * 引文（`class="citation"` / `data-citation-items`）与「添加至笔记」生成的标注反链
 * （`data-annotation`）都靠这些属性回指库里的对象。插件的编辑器读写的是**原始 HTML**
 * 且不做规范化，只要用户不动这些标签就完好；这个判定用来在编辑器里提示一句风险。
 */
const NOTE_ANCHOR = /\b(?:data-(?:citation|annotation|pid)\b|class="citation")/u

/**
 * 正文是否含 Zotero 的结构锚点。
 *
 * 导出给界面复用：判定口径只能有一处，不同地方各写一份正则，早晚会漂移。
 */
export function hasZoteroAnchors(html: string): boolean {
  return NOTE_ANCHOR.test(html)
}

function toNote(raw: RawItem): ZoteroNote {
  const source = raw.data?.note ?? ''
  const html = sanitizeNoteHtml(source)
  const maxBytes = NOTE_MAX_BYTES
  const truncated = html.length > maxBytes
  return {
    key: raw.key,
    title: noteTitle(html),
    html: truncated ? html.slice(0, maxBytes) : html,
    dateModified: raw.data?.dateModified ?? '',
    truncated,
    version: versionOf(raw),
    parentItem: parentKeyOf(raw),
    anchored: hasZoteroAnchors(source),
  }
}

/**
 * 笔记原始正文（编辑器取数用）。
 *
 * 与 {@link toNote} 的区别刻意为之：不清洗、不截断。清洗会剥掉 `data-*`，截断会腰斩
 * 标签，两者回写进 Zotero 都是数据损伤。
 */
export async function getNoteRaw(key: string): Promise<ZoteroNoteRaw> {
  const { body: raw } = await requestJson<RawItem>(`${libraryBase()}/items/${encode(key)}`)
  if (raw.data?.itemType !== 'note') {
    throw new ZoteroError('bad_request', '该条目不是笔记，无法按笔记编辑。')
  }
  return {
    key: raw.key,
    version: versionOf(raw),
    parentItem: parentKeyOf(raw),
    html: raw.data.note ?? '',
  }
}

/**
 * 标注的当前状态（写入前的核对用）。
 *
 * 只回校验用得着的字段：写侧需要确认「这确实是一条标注、而且是高亮/划线」，
 * 而不是把整条数据拉过来再丢掉。目标不存在时这里就抛 404，不会白跑一次 PATCH。
 */
export async function getAnnotationState(key: string): Promise<ZoteroAnnotationState> {
  const { body: raw } = await requestJson<RawItem>(`${libraryBase()}/items/${encode(key)}`)
  if (raw.data?.itemType !== 'annotation') {
    throw new ZoteroError('bad_request', '该条目不是标注，本插件的标注写入不会改动它。')
  }
  return {
    key: raw.key,
    version: versionOf(raw),
    parentItem: parentKeyOf(raw),
    type: raw.data.annotationType ?? '',
  }
}

/** 标注挂载点（父条目）的校验信息。 */
export interface AnnotationHostInfo {
  key: string
  /** Zotero 的条目类型，如 `attachment` / `journalArticle`。 */
  itemType: string
  /** 附件的 MIME；非附件为空串。 */
  contentType: string
  /** 磁盘文件名；MIME 不可靠时用它判扩展名（网页快照常给 `text/html`）。 */
  filename: string
  /** 文件名或条目标题，只用于错误文案。 */
  title: string
}

/**
 * 读一条「准备挂标注」的条目，回够校验用的几个字段。
 *
 * Zotero 只允许标注长在附件（PDF/EPUB）下面，把 key 递错成父条目时它那边报的是一句
 * 英文内部错误；与其让用户看见那种话，不如在这里挡住并说清该选哪一层。
 */
export async function getAnnotationHost(key: string): Promise<AnnotationHostInfo> {
  const { body: raw } = await requestJson<RawItem>(`${libraryBase()}/items/${encode(key)}`)
  return {
    key: raw.key,
    itemType: raw.data?.itemType ?? '',
    contentType: raw.data?.contentType ?? '',
    filename: raw.data?.filename ?? '',
    title: raw.data?.title ?? '',
  }
}

function toSummary(raw: RawItem, lastRead: number | null): ZoteroItemSummary {
  const data = raw.data ?? {}
  const itemType = data.itemType ?? ''
  const hasAttachment = itemType === 'attachment'
    ? true
    : itemType === 'note'
      ? false
      : (raw.meta?.numChildren ?? 0) > 0
  // 笔记没有 title 字段，用正文首段摘要当标题。
  const title = data.title
    || data.filename
    || (itemType === 'note' ? noteTitle(data.note ?? '') : '')
    || '(无标题)'
  return {
    key: raw.key,
    title,
    creators: raw.meta?.creatorSummary ?? '',
    year: yearOf(raw.meta, data),
    itemType,
    hasAttachment,
    lastRead,
  }
}

/** 附件自己的 `lastRead` 就在它的 JSON 里，笔记没有，其余条目去问子附件。 */
function lastReadOf(raw: RawItem): Promise<number | null> {
  const data = raw.data ?? {}
  if (data.itemType === 'attachment') {
    const value = data.lastRead
    return Promise.resolve(typeof value === 'number' && value > 0 ? value : null)
  }
  if (data.itemType === 'note') return Promise.resolve(null)
  return itemLastRead(raw.key)
}

/** 列表归一化：已读状态并发取，单条失败按未读（不拖垮整页）。 */
async function toSummaries(raws: RawItem[]): Promise<ZoteroItemSummary[]> {
  return Promise.all(raws.map(async (raw) => toSummary(raw, await lastReadOf(raw))))
}

/** 从库名 `library.name` 或条目数据里取文库名（缺省回退）。 */
function libraryNameOf(raw: RawItem[]): string {
  const first = raw[0] as (RawItem & { library?: { name?: string } }) | undefined
  return first?.library?.name || '我的文库'
}

// ---- 探活 -------------------------------------------------------------------

/** 探活 Zotero 本地 API，返回版本信息；不可达时 running=false。 */
export async function probe(): Promise<ZoteroHealth['zotero']> {
  try {
    const res = await fetch(zoteroProbeUrl(), { signal: AbortSignal.timeout(getSettings().requestTimeoutMs) })
    return {
      running: res.ok,
      apiVersion: res.headers.get('zotero-api-version'),
      serverId: res.headers.get('zotero-server-id'),
      schemaVersion: res.headers.get('zotero-schema-version'),
    }
  } catch {
    return { running: false, apiVersion: null, serverId: null, schemaVersion: null }
  }
}

/** 用 TCP 连接探活 Zotero 集成 MCP 端口（轻量、不建会话）。 */
export function probeMcp(): Promise<boolean> {
  const url = new URL(getSettings().mcpUrl)
  const port = Number.parseInt(url.port, 10)
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: url.hostname, port })
    const finish = (running: boolean): void => {
      socket.destroy()
      resolve(running)
    }
    socket.setTimeout(getSettings().mcpProbeTimeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// ---- 集成 MCP（只读 + 工具桥接） --------------------------------------------

/** 集成 MCP 暴露的一个工具。 */
export interface McpToolInfo {
  name: string
  description: string
  /** 上游 JSON Schema，直接作为 dsh 工具的参数声明。 */
  parameters: unknown
}

/** 集成 MCP 一次工具调用的结果。 */
export interface McpCallResult {
  content: unknown[]
  isError: boolean
}

interface RawMcpTool {
  name?: string
  description?: string
  inputSchema?: unknown
}

/**
 * 兼容 JSON 与 SSE 两种响应的 JSON-RPC 解析。
 *
 * 实测 Zotero 集成 MCP 对每个请求都直接回 `application/json`，但
 * Streamable HTTP 规范允许用 `text/event-stream` 逐帧下发，故两种都接。
 */
function parseMcpPayload(contentType: string, text: string): unknown {
  if (!contentType.includes('text/event-stream')) return JSON.parse(text) as unknown
  const line = text.split('\n').find((candidate) => candidate.startsWith('data:'))
  if (line === undefined) throw new Error('集成 MCP 返回了空的 SSE 响应')
  return JSON.parse(line.slice('data:'.length).trim()) as unknown
}

/**
 * 发一帧 JSON-RPC。
 *
 * 本机实测该服务**完全无状态**：`tools/list` 与 `tools/call` 都不要求先
 * `initialize`、也不校验 `Mcp-Session-Id`，因此无需维护会话，直接 POST 即可。
 */
async function mcpRpc(
  method: string,
  params: unknown,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const url = getSettings().mcpUrl
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal,
    })
  } catch (error) {
    throw new ZoteroError('zotero_unreachable', `无法连接集成 MCP（${url}）：${shortMessage(error)}`)
  }
  if (!res.ok) {
    throw new ZoteroError('bad_request', `集成 MCP 返回 ${res.status} ${res.statusText}`)
  }
  const payload = parseMcpPayload(res.headers.get('content-type') ?? '', await res.text()) as {
    result?: Record<string, unknown>
    error?: { message?: string }
  }
  if (payload.error) {
    throw new ZoteroError('bad_request', `集成 MCP 返回错误：${payload.error.message ?? '未知'}`)
  }
  return payload.result ?? {}
}

/** 拉取集成 MCP 的工具清单。 */
export async function listMcpTools(): Promise<McpToolInfo[]> {
  const result = await mcpRpc('tools/list', {}, { timeoutMs: getSettings().requestTimeoutMs })
  const tools = Array.isArray(result.tools) ? (result.tools as RawMcpTool[]) : []
  return tools
    .map((tool) => ({
      name: tool.name ?? '',
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    }))
    .filter((tool) => tool.name !== '')
}

/** 调用一个集成 MCP 工具（原始名，非 `mcp__zotero__*` 公开名）。 */
export async function callMcpTool(
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<McpCallResult> {
  const result = await mcpRpc(
    'tools/call',
    { name, arguments: args ?? {} },
    signal === undefined
      ? { timeoutMs: MCP_CALL_TIMEOUT_MS }
      : { timeoutMs: MCP_CALL_TIMEOUT_MS, signal },
  )
  return {
    content: Array.isArray(result.content) ? result.content : [],
    isError: result.isError === true,
  }
}

// ---- 文库 -------------------------------------------------------------------

/** 探测文库名（取一条分类或条目上的 `library.name`）。 */
export async function getLibraryName(): Promise<string> {
  const { body } = await requestJson<RawItem[]>(`${libraryBase()}/collections?limit=1`)
  return Array.isArray(body) && body.length > 0 ? libraryNameOf(body) : '我的文库'
}

/** 全量分类（扁平，含 parentCollection 与 numItems）。 */
export async function listCollections(): Promise<ZoteroCollection[]> {
  const { body } = await requestJson<RawItem[]>(`${libraryBase()}/collections?limit=1000`)
  if (!Array.isArray(body)) return []
  return body.map((raw) => {
    const data = (raw.data ?? {}) as RawItemData & { parentCollection?: string | false } & { name?: string }
    return {
      key: raw.key,
      name: data.name ?? '(未命名分类)',
      parentKey: data.parentCollection ?? false,
      itemCount: raw.meta?.numItems ?? 0,
    }
  })
}

/** 条目详情里解析分类路径用；60s 内复用，避免每开一条文献都多打一次 Zotero。 */
let collectionCache: { at: number; collections: ZoteroCollection[] } | null = null
const COLLECTION_CACHE_MS = 60_000

async function cachedCollections(): Promise<ZoteroCollection[]> {
  if (collectionCache !== null && Date.now() - collectionCache.at < COLLECTION_CACHE_MS) {
    return collectionCache.collections
  }
  const collections = await listCollections()
  collectionCache = { at: Date.now(), collections }
  return collections
}

/** 分类 key → 完整路径名（父分类在前，用 ` / ` 连接）。 */
function collectionPaths(collections: ZoteroCollection[], keys: string[]): string[] {
  const byKey = new Map(collections.map((collection) => [collection.key, collection] as const))
  const paths: string[] = []
  for (const key of keys) {
    const parts: string[] = []
    const seen = new Set<string>()
    let current = byKey.get(key)
    while (current !== undefined && !seen.has(current.key)) {
      seen.add(current.key)
      parts.unshift(current.name)
      current = current.parentKey === false ? undefined : byKey.get(current.parentKey)
    }
    if (parts.length > 0) paths.push(parts.join(' / '))
  }
  return paths
}

// ---- 标签 -------------------------------------------------------------------

/** 标签分页大小（本地 API 上限 1000）与总量上限。 */
const TAG_PAGE_SIZE = 1000
const TAG_MAX = 5000

/**
 * 文库级标签列表。
 *
 * 本地 API 没有「按分类的标签」端点（`/tags` 上的 `collectionKey` / `q` 实测被忽略），
 * 所以计数是**全库**的；范围用量另走 {@link listTagUsage}。
 * 按名称去重（同名标签只可能来自分页重复），`meta.type` / `numItems` 缺失时
 * 分别按手动标签与 0 处理，避免 UI 出现 `NaN`。
 */
export async function listTags(): Promise<ZoteroTags> {
  const seen = new Map<string, ZoteroTag>()
  let total = 0
  for (let start = 0; start < TAG_MAX; start += TAG_PAGE_SIZE) {
    const { body, total: pageTotal } = await requestJson<RawTag[]>(
      `${libraryBase()}/tags?limit=${TAG_PAGE_SIZE}&start=${start}`,
    )
    const page = Array.isArray(body) ? body : []
    if (pageTotal !== null) total = pageTotal
    for (const raw of page) {
      const name = raw.tag?.trim() ?? ''
      if (name === '' || seen.has(name)) continue
      seen.set(name, {
        name,
        count: raw.meta?.numItems ?? 0,
        type: raw.meta?.type ?? 1,
      })
    }
    if (page.length < TAG_PAGE_SIZE) break
    if (total > 0 && start + page.length >= total) break
  }
  return { total: total || seen.size, tags: [...seen.values()] }
}

/** 标签用量扫描的分页大小（本地 API 单页上限 100）与扫描条目上限。 */
const USAGE_PAGE_SIZE = 100
const USAGE_SCAN_MAX = 3000

export interface ListTagUsageOptions {
  /** 虚拟分类范围；缺省或 `library` 走真实分类/全库。 */
  scope?: ZoteroItemScope
  /**
   * 真实分类 key 列表（可含子目录）；空/缺省 = 全库。
   * 分类本身不含子分类条目，子树集合由调用方展开后传进来。
   */
  collectionKeys?: readonly string[]
  /** 与条目列表同一个搜索词，标签可用性才跟列表口径一致。 */
  q?: string
}

/**
 * 当前范围（分类 / 虚拟分类 + 搜索词）内的标签用量。
 *
 * 只能扫条目现算：逐页取范围内的顶层条目，读每条的 `data.tags` 累加计数。
 * 传多个 `collectionKeys` 时分目录扫描，并按条目 key 去重——同一篇条目可能
 * 同时挂在父分类与子分类里，不能重复计数。超过 `USAGE_SCAN_MAX` 条的大范围
 * 按前若干页截断，超大目录可能漏掉靠后的标签（本地 API 没有按分类列标签的端点）。
 */
export async function listTagUsage(options: ListTagUsageOptions): Promise<ZoteroTags> {
  const search = options.q?.trim() ?? ''
  const counts = new Map<string, ZoteroTag>()
  const seenItems = new Set<string>()

  const bases =
    options.scope === 'publications'
      ? [`${libraryBase()}/publications/items`]
      : options.scope === 'trash'
        ? [`${libraryBase()}/items/trash`]
        : (options.collectionKeys ?? []).length > 0
          ? options.collectionKeys!.map((key) => `${libraryBase()}/collections/${encode(key)}/items/top`)
          : [`${libraryBase()}/items/top`]

  let scanned = 0
  for (const base of bases) {
    for (let start = 0; scanned < USAGE_SCAN_MAX; start += USAGE_PAGE_SIZE) {
      const params = new URLSearchParams({ limit: String(USAGE_PAGE_SIZE), start: String(start) })
      if (search !== '') params.set('q', search)
      const { body } = await requestJson<RawItem[]>(`${base}?${params.toString()}`)
      const page = Array.isArray(body) ? body : []
      if (page.length === 0) break
      scanned += page.length
      for (const raw of page) {
        if (seenItems.has(raw.key)) continue
        seenItems.add(raw.key)
        // 「未分类条目」没有专用端点，与列表一样靠 data.collections 筛。
        if (options.scope === 'unfiled' && (raw.data?.collections ?? []).length > 0) continue
        for (const tag of raw.data?.tags ?? []) {
          const name = tag.tag?.trim() ?? ''
          if (name === '') continue
          const existing = counts.get(name)
          if (existing === undefined) counts.set(name, { name, count: 1, type: tag.type ?? 1 })
          else existing.count += 1
        }
      }
      if (page.length < USAGE_PAGE_SIZE) break
    }
    if (scanned >= USAGE_SCAN_MAX) break
  }

  const tags = [...counts.values()]
  return { total: tags.length, tags }
}

// ---- 条目 -------------------------------------------------------------------

export interface ListItemsOptions {
  /** 虚拟分类范围；缺省或 `library` 走真实分类/全库。 */
  scope?: ZoteroItemScope
  collectionKey?: string
  q?: string
  /** 标签过滤：AND（默认）逐个 `tag=`，OR 合并成 `tag=A || B`。 */
  tags?: readonly string[]
  tagMode?: 'all' | 'any'
  /** 排序字段；缺省用 Zotero 的原始顺序。 */
  sort?: 'title'
  direction?: 'asc' | 'desc'
  limit: number
  offset: number
}

/** 「未分类条目」推导时最多扫描的顶层条目数（避免超大口库长时间扫描）。 */
const UNFILED_SCAN_MAX = 1000

/** 一页扫描条数（本地 API 上限 100）。 */
const PAGE_SIZE = 100

// ---- 已读状态 ---------------------------------------------------------------

/** 已读状态缓存时长：`lastRead` 由 Zotero 阅读器写入，分钟级刷新足够。 */
const READ_STATE_TTL_MS = 60_000

/** 单条已读状态缓存的上限；超了就整体丢弃（重新查一遍即可）。 */
const READ_STATE_CACHE_MAX = 5000

interface ReadStateEntry {
  at: number
  lastRead: number | null
}

const readStateCache = new Map<string, ReadStateEntry>()

/**
 * 条目（父条目）的最晚阅读时间（Unix 秒），`null` 表示没读过。
 *
 * 已读状态只记在附件上，父条目要问它的子附件（原生 `getItemLastRead()` 同理）。
 * 按条目查而不是扫全库：单条约 6ms，只查当前列表里的条目，大口库也不会卡。
 * 取不到按未读处理——已读标志是附加信息，不能拖垮条目列表。
 */
async function itemLastRead(key: string): Promise<number | null> {
  const cached = readStateCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < READ_STATE_TTL_MS) return cached.lastRead
  try {
    const { body } = await requestJson<RawItem[]>(
      `${libraryBase()}/items/${encode(key)}/children?itemType=attachment`,
    )
    let lastRead: number | null = null
    for (const child of Array.isArray(body) ? body : []) {
      const value = child.data?.lastRead
      if (typeof value !== 'number' || value <= 0) continue
      if (lastRead === null || value > lastRead) lastRead = value
    }
    if (readStateCache.size >= READ_STATE_CACHE_MAX) readStateCache.clear()
    readStateCache.set(key, { at: Date.now(), lastRead })
    return lastRead
  } catch {
    return null
  }
}

/** 把 `q` 与标签过滤写进查询参数（列表与未分类扫描共用）。 */
function appendItemFilters(params: URLSearchParams, options: ListItemsOptions): void {
  if (options.q && options.q.trim() !== '') params.set('q', options.q.trim())
  const tags = (options.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '')
  if (tags.length === 0) return
  if (options.tagMode === 'any') {
    params.set('tag', tags.join(' || '))
  } else {
    for (const tag of tags) params.append('tag', tag)
  }
}

/** 把排序写进查询参数（本地 API 支持 `sort=title` + `direction=asc|desc`）。 */
function appendItemSort(params: URLSearchParams, options: ListItemsOptions): void {
  if (options.sort === undefined) return
  params.set('sort', options.sort)
  params.set('direction', options.direction === 'desc' ? 'desc' : 'asc')
}

/** 范围内的顶层条目端点基址（条目列表与标签用量共用同一套范围规则）。 */
function itemListBase(options: { scope?: ZoteroItemScope; collectionKey?: string }): string {
  return options.scope === 'publications'
    ? `${libraryBase()}/publications/items`
    : options.scope === 'trash'
      ? `${libraryBase()}/items/trash`
      : options.collectionKey
        ? `${libraryBase()}/collections/${encode(options.collectionKey)}/items/top`
        : `${libraryBase()}/items/top`
}

/** 把 options 折成「顶层条目」端点基址 + 查询参数。 */
function itemListQuery(options: ListItemsOptions): { base: string; params: URLSearchParams } {
  const params = new URLSearchParams({
    limit: String(options.limit),
    start: String(options.offset),
  })
  appendItemFilters(params, options)
  appendItemSort(params, options)
  return { base: itemListBase(options), params }
}

/**
 * 「未分类条目」：本地 API 没有专用端点，改为取顶层条目后筛掉已归类的
 * （`data.collections` 非空即已归类），分页在筛完后作用于结果集。
 */
async function listUnfiled(
  options: ListItemsOptions,
): Promise<{ total: number; items: ZoteroItemSummary[] }> {
  const all: RawItem[] = []
  for (let start = 0; start < UNFILED_SCAN_MAX; start += PAGE_SIZE) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), start: String(start) })
    appendItemFilters(params, options)
    // 排序也交给服务端：筛完再排会与分页对不上（扫描顺序决定筛后结果顺序）。
    appendItemSort(params, options)
    const { body } = await requestJson<RawItem[]>(
      `${libraryBase()}/items/top?${params.toString()}`,
    )
    if (!Array.isArray(body) || body.length === 0) break
    for (const raw of body) {
      if ((raw.data?.collections ?? []).length === 0) all.push(raw)
    }
    if (body.length < PAGE_SIZE) break
  }
  const page = all.slice(options.offset, options.offset + options.limit)
  return { total: all.length, items: await toSummaries(page) }
}

/** 顶层条目列表（按虚拟分类、真实分类、或全库，或关键字搜索）。 */
export async function listItems(
  options: ListItemsOptions,
): Promise<{ total: number; items: ZoteroItemSummary[] }> {
  if (options.scope === 'unfiled') return listUnfiled(options)

  const { base, params } = itemListQuery(options)
  const { body, total } = await requestJson<RawItem[]>(`${base}?${params.toString()}`)
  const raws = Array.isArray(body) ? body : []
  return { total: total ?? raws.length, items: await toSummaries(raws) }
}

/** 子条目（附件 / 笔记）。 */
export async function getItemChildren(key: string): Promise<RawItem[]> {
  const { body } = await requestJson<RawItem[]>(`${libraryBase()}/items/${encode(key)}/children`)
  return Array.isArray(body) ? body : []
}

/**
 * 展示的标注类型。`ink` 没有 rects，只能进列表；其余类型都可在 PDF 上叠加。
 */
const ANNOTATION_TYPES = new Set(['highlight', 'underline', 'note', 'text', 'image', 'ink'])

/** 标注分页大小（本地 API 单页上限 100）与总量上限。 */
const ANNOTATION_PAGE_SIZE = 100
const ANNOTATION_MAX = 1000

function isRect(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value)
    && value.length === 4
    && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

/** `annotationPosition` 是 JSON 字符串；结构不符按「无位置」处理。 */
function toPosition(value: unknown): RawAnnotation['position'] {
  if (typeof value !== 'string' || value === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { pageIndex, rects } = parsed as { pageIndex?: unknown; rects?: unknown }
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0) return null
  if (!Array.isArray(rects)) return null
  const valid = rects.filter(isRect)
  if (valid.length === 0) return null
  return { pageIndex, rects: valid }
}

/**
 * 解析网页快照的 `annotationPosition`。
 *
 * Zotero 对 snapshot / EPUB 写的是 Web Annotation 形态（`CssSelector` +
 * `refinedBy: TextPositionSelector`），没有 `pageIndex`/`rects`，所以
 * {@link toPosition} 对它返回 null —— 两个字段各解析各的。
 */
function toWebPosition(value: unknown): RawAnnotation['webPosition'] {
  if (typeof value !== 'string' || value === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { type?: unknown; value?: unknown; refinedBy?: unknown }
  if (record.type !== 'CssSelector') return null
  if (typeof record.value !== 'string' || record.value.trim() === '') return null
  // Zotero 各版本里 refinedBy 有时是对象、有时是数组，两种都收。
  const candidates = Array.isArray(record.refinedBy) ? record.refinedBy : [record.refinedBy]
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const selector = candidate as { type?: unknown; start?: unknown; end?: unknown }
    if (selector.type !== 'TextPositionSelector') continue
    const start = selector.start
    const end = selector.end
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) continue
    if (typeof end !== 'number' || !Number.isInteger(end) || end <= start) continue
    return { selector: record.value.trim(), start, end }
  }
  return null
}

/** 原始标注 → 展示用标注；未知类型返回 null。 */
function toAnnotation(raw: RawItem): RawAnnotation | null {
  const data = raw.data ?? {}
  const type = data.annotationType ?? ''
  if (!ANNOTATION_TYPES.has(type)) return null
  return {
    key: raw.key,
    attachmentKey: parentKeyOf(raw),
    type,
    text: data.annotationText ?? '',
    comment: data.annotationComment ?? '',
    color: data.annotationColor ?? '',
    pageLabel: data.annotationPageLabel ?? '',
    sortIndex: data.annotationSortIndex ?? '',
    position: toPosition(data.annotationPosition),
    webPosition: toWebPosition(data.annotationPosition),
    version: versionOf(raw),
    tags: (data.tags ?? [])
      .filter((tag) => typeof tag.tag === 'string' && tag.tag !== '')
      .map((tag) => ({ tag: tag.tag as string, type: tag.type ?? 1 })),
  }
}

/**
 * 条目下所有 PDF 附件上的标注。
 *
 * 必须显式带 `itemType=annotation`：实测 `/children` 不带参数时不返回标注。
 * 失败降级为空数组——标注是详情的附加信息，不能拖垮整个条目。
 */
export async function getItemAnnotations(key: string): Promise<RawAnnotation[]> {
  const out: RawAnnotation[] = []
  try {
    for (let start = 0; start < ANNOTATION_MAX; start += ANNOTATION_PAGE_SIZE) {
      const { body, total } = await requestJson<RawItem[]>(
        `${libraryBase()}/items/${encode(key)}/children`
        + `?itemType=annotation&limit=${ANNOTATION_PAGE_SIZE}&start=${start}`,
      )
      const page = Array.isArray(body) ? body : []
      for (const raw of page) {
        const annotation = toAnnotation(raw)
        if (annotation !== null) out.push(annotation)
      }
      if (page.length < ANNOTATION_PAGE_SIZE) break
      if (total !== null && start + page.length >= total) break
    }
  } catch {
    return out
  }
  return out
}

/** 附件全文；仅附件条目可用。 */
export async function getItemFulltext(attachmentKey: string): Promise<ZoteroFulltext | null> {
  let body: { content?: string } | null
  try {
    body = (await requestJson<{ content?: string }>(
      `${libraryBase()}/items/${encode(attachmentKey)}/fulltext`,
    )).body
  } catch (error) {
    // 该附件未索引 / 无全文时返回 404：视为「无全文」而不是错误。
    if (error instanceof ZoteroError && error.code === 'zotero_not_found') return null
    throw error
  }
  const content = body?.content ?? ''
  if (content === '') return null
  const maxBytes = getSettings().fulltextMaxBytes
  const truncated = content.length > maxBytes
  return {
    attachmentKey,
    content: truncated ? content.slice(0, maxBytes) : content,
    truncated,
    fallback: false,
  }
}

/** 按后缀兜底的 MIME（Zotero 记录里 `contentType` 偶尔为空）。 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'text/html',
  epub: 'application/epub+zip',
  txt: 'text/plain',
}

/**
 * 附件内容类型的规范形态：小写、去掉 `;` 之后的参数，缺失时按后缀兜底。
 *
 * 不规范化的后果是同一份 PDF 在有的库里能预览、有的库里被 415 挡掉——判断
 * 「能不能直接流出去」和「用哪个渲染器」都依赖这一个值。
 */
export function normalizeContentType(contentType: string, filename: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase()
  if (base !== '') return base
  const ext = /\.([a-z0-9]+)$/iu.exec(filename)?.[1]?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? ''
}

/** 读不到文件时的**人话**原因：用户据此能自己判断该去哪修。 */
function unreadableReason(error: unknown, path: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (code === 'ENOENT' || code === 'ENOTDIR') return `附件文件不存在：${path}`
  if (code === 'EACCES' || code === 'EPERM') return `没有权限读取附件文件：${path}`
  if (code === 'ELOOP') return `附件文件是失效的符号链接：${path}`
  const detail = error instanceof Error ? error.message : String(error)
  return `无法读取附件文件：${path}（${code === '' ? detail : code}）`
}

/**
 * 解析附件在磁盘上的真实路径。
 *
 * 路径只来自 Zotero 条目 JSON 的 `links.enclosure.href`（`file://` URL），
 * 客户端传来的任何路径都不接受。用 `stat` 而不是 `lstat`：把大文件放外置盘、
 * storage 里留软链是很常见的用法，`lstat` 会把这种附件当成「不是普通文件」拒掉。
 * 链接附件（`linkMode: linked_file`）同样走这里，不限制必须在 storage 下。
 */
export async function getAttachmentFile(key: string): Promise<ZoteroAttachmentFile> {
  const { body: raw } = await requestJson<RawItem>(`${libraryBase()}/items/${encode(key)}`)
  const data = raw.data ?? {}
  if (data.itemType !== 'attachment') {
    throw new ZoteroError('bad_request', `条目 ${key} 不是附件`)
  }
  const href = raw.links?.enclosure?.href ?? ''
  if (href === '') {
    // 没有 enclosure：附件记录在，但 Zotero 那边没有对应的本地文件（未下载、
    // 只同步了元数据、或网页链接型附件）。这是「打不开 PDF」最常见的一种。
    throw new ZoteroError('zotero_not_found', `附件 ${key} 没有本地文件（Zotero 里可能尚未下载）`)
  }
  let path: string
  try {
    path = fileURLToPath(href)
  } catch {
    const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(href)?.[1] ?? ''
    throw new ZoteroError(
      'zotero_not_found',
      scheme === '' || scheme === 'file'
        ? `附件 ${key} 的文件地址无法解析：${href}`
        : `附件 ${key} 不是本地文件（${scheme}:）`,
    )
  }
  let stats
  try {
    stats = await stat(path)
  } catch (error) {
    throw new ZoteroError('zotero_not_found', unreadableReason(error, path))
  }
  if (!stats.isFile()) {
    throw new ZoteroError('zotero_not_found', `附件路径不是文件：${path}`)
  }
  const filename = data.filename ?? attachmentTitle(raw)
  return {
    key,
    path,
    size: stats.size,
    contentType: normalizeContentType(data.contentType ?? '', filename),
    filename,
  }
}

/**
 * 依次尝试候选附件的全文，返回第一份可用的。
 *
 * 条目常同时挂原文与中文译本：译本若尚未建索引（`/fulltext` 404），
 * 不能直接判定整条无全文，应回退到原文等其他附件。
 */
async function getFirstFulltext(candidates: RawItem[]): Promise<ZoteroFulltext | null> {
  const preferredKey = candidates[0]?.key ?? ''
  for (const attachment of candidates) {
    const fulltext = await getItemFulltext(attachment.key)
    if (fulltext !== null) return { ...fulltext, fallback: attachment.key !== preferredKey }
  }
  return null
}

/** 单条条目的 CSL HTML（`format=bib`）；失败返回 null。 */
export async function getItemBib(key: string, style: string): Promise<string | null> {
  try {
    const { body } = await requestText(
      `${libraryBase()}/items/${encode(key)}?format=bib&style=${encode(style)}`,
    )
    return body.trim() === '' ? null : body
  } catch {
    return null
  }
}

/** 条目详情：元数据 + 附件 + 笔记 + 标注 + 首个可读附件全文 + CSL。 */
export async function getItemDetail(key: string, style: string): Promise<ZoteroItemDetail> {
  const { body: raw } = await requestJson<RawItem>(`${libraryBase()}/items/${encode(key)}`)
  const data = raw.data ?? {}
  const itemType = data.itemType ?? ''
  const isAttachment = itemType === 'attachment'

  // 顶层条目可能是附件本身（直接导入的 PDF），此时把自己也算作附件。
  const [children, rawAnnotations, collections] = await Promise.all([
    isAttachment ? Promise.resolve<RawItem[]>([]) : getItemChildren(key),
    itemType === 'note' ? Promise.resolve<RawAnnotation[]>([]) : getItemAnnotations(key),
    cachedCollections().catch(() => [] as ZoteroCollection[]),
  ])
  const childAttachments = children.filter((c) => c.data?.itemType === 'attachment')
  const attachments =
    isAttachment ? [toAttachment(raw), ...childAttachments.map(toAttachment)] : childAttachments.map(toAttachment)

  // 笔记是子条目（itemType=note）；条目本身就是笔记时（独立笔记），正文即自身。
  const childNotes = children.filter((c) => c.data?.itemType === 'note')
  const notes = (itemType === 'note' ? [raw] : childNotes).map(toNote)

  // 候选顺序：PDF 优先，其余附件随后；逐份尝试直到拿到全文。
  const candidates =
    isAttachment
      ? [raw]
      : [
          ...childAttachments.filter((c) => c.data?.contentType === 'application/pdf'),
          ...childAttachments.filter((c) => c.data?.contentType !== 'application/pdf'),
        ]

  const [fulltext, bib] = await Promise.all([
    getFirstFulltext(candidates),
    getItemBib(key, style),
  ])

  // 展示顺序：当前附件的标注排前，同附件内按 PDF 位置（annotationSortIndex 零填充，可字典序比较）。
  const rank = new Map(attachments.map((attachment, index) => [attachment.key, index] as const))
  rawAnnotations.sort((a, b) =>
    (rank.get(a.attachmentKey) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(b.attachmentKey) ?? Number.MAX_SAFE_INTEGER)
    || (a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0))

  const annotations: ZoteroAnnotation[] = anchorAnnotations(rawAnnotations, fulltext).map((annotation) => ({
    key: annotation.key,
    attachmentKey: annotation.attachmentKey,
    type: annotation.type,
    text: annotation.text,
    comment: annotation.comment,
    color: annotation.color,
    pageLabel: annotation.pageLabel,
    position: annotation.position,
    webPosition: annotation.webPosition,
    range: annotation.range,
    version: annotation.version,
    sortIndex: annotation.sortIndex,
    tags: annotation.tags,
  }))

  return {
    key: raw.key,
    itemType,
    title: data.title || data.filename || (itemType === 'note' ? notes[0]?.title ?? '(无标题)' : '(无标题)'),
    creators: (data.creators ?? []).map(creatorName).filter((n) => n !== ''),
    year: yearOf(raw.meta, data),
    publicationTitle: data.publicationTitle ?? '',
    url: data.url ?? '',
    doi: data.DOI ?? '',
    abstract: data.abstractNote ?? '',
    tags: (data.tags ?? []).map((tag) => tag.tag ?? '').filter((tag) => tag !== ''),
    collections: data.collections ?? [],
    collectionNames: collectionPaths(collections, data.collections ?? []),
    attachments,
    notes,
    annotations,
    fulltext,
    bib,
    writeEnabled: getSettings().writeEnabled,
  }
}

// ---- 整目录引用 -------------------------------------------------------------

/** 单批 itemKey 数量上限（Zotero 本地 API 要求 ≤ 50）。 */
const BIB_BATCH = 50

/** 一个目录最多导出多少条引用。 */
const BIB_MAX_ITEMS = 200

function stripBibWrapper(html: string): string {
  return html
    .replace(/^\s*<div class="csl-bib-body"[^>]*>\s*/u, '')
    .replace(/\s*<\/div>\s*$/u, '')
    .trim()
}

function pageCount(html: string): number {
  const matches = html.match(/class="csl-entry"/gu)
  return matches ? matches.length : 0
}

/**
 * 整目录参考文献列表。
 *
 * 实测 `/collections/<key>/items?format=bib` 返回空 body，因此改为
 * 「先取条目标题 key，再按 ≤50 一批走 `/items?itemKey=` 取 bib」。
 */
export async function getCollectionBib(
  collectionKey: string,
  style: string,
): Promise<{ bib: string; count: number }> {
  const keys: string[] = []
  let offset = 0

  while (keys.length < BIB_MAX_ITEMS) {
    const { body } = await requestJson<RawItem[]>(
      `${libraryBase()}/collections/${encode(collectionKey)}/items/top?limit=100&start=${offset}`,
    )
    if (!Array.isArray(body) || body.length === 0) break
    for (const raw of body) keys.push(raw.key)
    offset += body.length
    if (body.length < 100) break
  }

  const parts: string[] = []
  for (let i = 0; i < keys.length; i += BIB_BATCH) {
    const batch = keys.slice(i, i + BIB_BATCH)
    const { body } = await requestText(
      `${libraryBase()}/items?itemKey=${batch.map(encode).join(',')}&format=bib&style=${encode(style)}`,
    )
    const inner = stripBibWrapper(body)
    if (inner !== '') parts.push(inner)
  }

  const inner = parts.join('\n')
  // 注意：附件类条目（无元数据的裸 PDF）不产生 csl-entry，因此 count 是
  // 「实际导出到的条目数」，可能小于目录的条目总数。
  const bib =
    inner === ''
      ? ''
      : `<div class="csl-bib-body" style="line-height: 2; margin-left: 2em; text-indent:-2em;">\n${inner}\n</div>`
  return { bib, count: pageCount(inner) }
}
