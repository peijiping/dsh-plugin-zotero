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

import { connect } from 'node:net'

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
  ZoteroAttachment,
  ZoteroCollection,
  ZoteroFulltext,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemScope,
  ZoteroItemSummary,
  ZoteroNote,
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
}

interface RawItemData {
  itemType?: string
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
  annotationType?: string
  annotationText?: string
  annotationComment?: string
  annotationColor?: string
  annotationPageLabel?: string
  annotationSortIndex?: string
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

function toNote(raw: RawItem): ZoteroNote {
  const html = sanitizeNoteHtml(raw.data?.note ?? '')
  const maxBytes = NOTE_MAX_BYTES
  const truncated = html.length > maxBytes
  return {
    key: raw.key,
    title: noteTitle(html),
    html: truncated ? html.slice(0, maxBytes) : html,
    dateModified: raw.data?.dateModified ?? '',
    truncated,
  }
}

function toSummary(raw: RawItem): ZoteroItemSummary {
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
  }
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

// ---- 条目 -------------------------------------------------------------------

export interface ListItemsOptions {
  /** 虚拟分类范围；缺省或 `library` 走真实分类/全库。 */
  scope?: ZoteroItemScope
  collectionKey?: string
  q?: string
  limit: number
  offset: number
}

/** 「未分类条目」推导时最多扫描的顶层条目数（避免超大口库长时间扫描）。 */
const UNFILED_SCAN_MAX = 1000

/** 一页扫描条数（本地 API 上限 100）。 */
const PAGE_SIZE = 100

/** 把 options 折成「顶层条目」端点基址 + 查询参数。 */
function itemListQuery(options: ListItemsOptions): { base: string; params: URLSearchParams } {
  const base =
    options.scope === 'publications'
      ? `${libraryBase()}/publications/items`
      : options.scope === 'trash'
        ? `${libraryBase()}/items/trash`
        : options.collectionKey
          ? `${libraryBase()}/collections/${encode(options.collectionKey)}/items/top`
          : `${libraryBase()}/items/top`
  const params = new URLSearchParams({
    limit: String(options.limit),
    start: String(options.offset),
  })
  if (options.q && options.q.trim() !== '') params.set('q', options.q.trim())
  return { base, params }
}

/**
 * 「未分类条目」：本地 API 没有专用端点，改为取顶层条目后筛掉已归类的
 * （`data.collections` 非空即已归类），分页在筛完后作用于结果集。
 */
async function listUnfiled(
  offset: number,
  limit: number,
): Promise<{ total: number; items: ZoteroItemSummary[] }> {
  const all: ZoteroItemSummary[] = []
  for (let start = 0; start < UNFILED_SCAN_MAX; start += PAGE_SIZE) {
    const { body } = await requestJson<RawItem[]>(
      `${libraryBase()}/items/top?limit=${PAGE_SIZE}&start=${start}`,
    )
    if (!Array.isArray(body) || body.length === 0) break
    for (const raw of body) {
      if ((raw.data?.collections ?? []).length === 0) all.push(toSummary(raw))
    }
    if (body.length < PAGE_SIZE) break
  }
  return { total: all.length, items: all.slice(offset, offset + limit) }
}

/** 顶层条目列表（按虚拟分类、真实分类、或全库，或关键字搜索）。 */
export async function listItems(
  options: ListItemsOptions,
): Promise<{ total: number; items: ZoteroItemSummary[] }> {
  if (options.scope === 'unfiled') return listUnfiled(options.offset, options.limit)

  const { base, params } = itemListQuery(options)
  const { body, total } = await requestJson<RawItem[]>(`${base}?${params.toString()}`)
  const items = Array.isArray(body) ? body.map(toSummary) : []
  return { total: total ?? items.length, items }
}

/** 子条目（附件 / 笔记）。 */
export async function getItemChildren(key: string): Promise<RawItem[]> {
  const { body } = await requestJson<RawItem[]>(`${libraryBase()}/items/${encode(key)}/children`)
  return Array.isArray(body) ? body : []
}

/** 展示的标注类型：高亮与划线（Zotero 支持两者互转）。 */
const ANNOTATION_TYPES = new Set(['highlight', 'underline'])

/** 标注分页大小（本地 API 单页上限 100）与总量上限。 */
const ANNOTATION_PAGE_SIZE = 100
const ANNOTATION_MAX = 1000

/** 原始标注 → 展示用标注；非高亮/划线返回 null。 */
function toAnnotation(raw: RawItem): RawAnnotation | null {
  const data = raw.data ?? {}
  const type = data.annotationType ?? ''
  if (!ANNOTATION_TYPES.has(type)) return null
  const parentItem = data.parentItem
  return {
    key: raw.key,
    attachmentKey: typeof parentItem === 'string' ? parentItem : '',
    type,
    text: data.annotationText ?? '',
    comment: data.annotationComment ?? '',
    color: data.annotationColor ?? '',
    pageLabel: data.annotationPageLabel ?? '',
    sortIndex: data.annotationSortIndex ?? '',
  }
}

/**
 * 条目下所有 PDF 附件上的高亮与划线。
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
  const [children, rawAnnotations] = await Promise.all([
    isAttachment ? Promise.resolve<RawItem[]>([]) : getItemChildren(key),
    itemType === 'note' ? Promise.resolve<RawAnnotation[]>([]) : getItemAnnotations(key),
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
    range: annotation.range,
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
    attachments,
    notes,
    annotations,
    fulltext,
    bib,
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
