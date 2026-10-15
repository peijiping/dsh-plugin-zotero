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

import {
  FULLTEXT_MAX_BYTES,
  LIBRARY_PREFIX,
  MCP_PROBE_TIMEOUT_MS,
  MCP_URL,
  REQUEST_TIMEOUT_MS,
  ZOTERO_BASE,
  ZOTERO_PROBE_URL,
} from './config.js'
import type {
  ApiErrorCode,
  ZoteroAttachment,
  ZoteroCollection,
  ZoteroFulltext,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemSummary,
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

/** 文库端点的绝对前缀（Node 的 fetch 需要绝对 URL，不接受相对路径）。 */
const LIB = `${ZOTERO_BASE}${LIBRARY_PREFIX}`

function shortMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function request(url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new ZoteroError(
      'zotero_unreachable',
      `无法连接 Zotero 本地 API（${ZOTERO_BASE}）：${shortMessage(error)}`,
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

function toSummary(raw: RawItem): ZoteroItemSummary {
  const data = raw.data ?? {}
  const itemType = data.itemType ?? ''
  const hasAttachment = itemType === 'attachment'
    ? true
    : itemType === 'note'
      ? false
      : (raw.meta?.numChildren ?? 0) > 0
  return {
    key: raw.key,
    title: data.title || data.filename || '(无标题)',
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
    const res = await fetch(ZOTERO_PROBE_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
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
  const url = new URL(MCP_URL)
  const port = Number.parseInt(url.port, 10)
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: url.hostname, port })
    const finish = (running: boolean): void => {
      socket.destroy()
      resolve(running)
    }
    socket.setTimeout(MCP_PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

// ---- 文库 -------------------------------------------------------------------

/** 探测文库名（取一条分类或条目上的 `library.name`）。 */
export async function getLibraryName(): Promise<string> {
  const { body } = await requestJson<RawItem[]>(`${LIB}/collections?limit=1`)
  return Array.isArray(body) && body.length > 0 ? libraryNameOf(body) : '我的文库'
}

/** 全量分类（扁平，含 parentCollection 与 numItems）。 */
export async function listCollections(): Promise<ZoteroCollection[]> {
  const { body } = await requestJson<RawItem[]>(`${LIB}/collections?limit=1000`)
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
  collectionKey?: string
  q?: string
  limit: number
  offset: number
}

/** 顶层条目列表（按分类、或全库、或关键字搜索）。 */
export async function listItems(
  options: ListItemsOptions,
): Promise<{ total: number; items: ZoteroItemSummary[] }> {
  const base = options.collectionKey
    ? `${LIB}/collections/${encode(options.collectionKey)}/items/top`
    : `${LIB}/items/top`
  const params = new URLSearchParams({
    limit: String(options.limit),
    start: String(options.offset),
  })
  if (options.q && options.q.trim() !== '') params.set('q', options.q.trim())

  const { body, total } = await requestJson<RawItem[]>(`${base}?${params.toString()}`)
  const items = Array.isArray(body) ? body.map(toSummary) : []
  return { total: total ?? items.length, items }
}

/** 子条目（附件 / 笔记）。 */
export async function getItemChildren(key: string): Promise<RawItem[]> {
  const { body } = await requestJson<RawItem[]>(`${LIB}/items/${encode(key)}/children`)
  return Array.isArray(body) ? body : []
}

/** 附件全文；仅附件条目可用。 */
export async function getItemFulltext(attachmentKey: string): Promise<ZoteroFulltext | null> {
  let body: { content?: string } | null
  try {
    body = (await requestJson<{ content?: string }>(
      `${LIB}/items/${encode(attachmentKey)}/fulltext`,
    )).body
  } catch (error) {
    // 该附件未索引 / 无全文时返回 404：视为「无全文」而不是错误。
    if (error instanceof ZoteroError && error.code === 'zotero_not_found') return null
    throw error
  }
  const content = body?.content ?? ''
  if (content === '') return null
  const truncated = content.length > FULLTEXT_MAX_BYTES
  return {
    attachmentKey,
    content: truncated ? content.slice(0, FULLTEXT_MAX_BYTES) : content,
    truncated,
  }
}

/** 单条条目的 CSL HTML（`format=bib`）；失败返回 null。 */
export async function getItemBib(key: string, style: string): Promise<string | null> {
  try {
    const { body } = await requestText(
      `${LIB}/items/${encode(key)}?format=bib&style=${encode(style)}`,
    )
    return body.trim() === '' ? null : body
  } catch {
    return null
  }
}

/** 条目详情：元数据 + 附件 + 首个可读附件全文 + CSL。 */
export async function getItemDetail(key: string, style: string): Promise<ZoteroItemDetail> {
  const { body: raw } = await requestJson<RawItem>(`${LIB}/items/${encode(key)}`)
  const data = raw.data ?? {}
  const itemType = data.itemType ?? ''

  // 顶层条目可能是附件本身（直接导入的 PDF），此时把自己也算作附件。
  const children = itemType === 'attachment' ? [] : await getItemChildren(key)
  const childAttachments = children.filter((c) => c.data?.itemType === 'attachment')
  const attachments =
    itemType === 'attachment' ? [toAttachment(raw), ...childAttachments.map(toAttachment)] : childAttachments.map(toAttachment)

  const readable =
    itemType === 'attachment'
      ? raw
      : childAttachments.find((c) => c.data?.contentType === 'application/pdf') ?? childAttachments[0]
  const fulltext = readable ? await getItemFulltext(readable.key) : null

  const bib = await getItemBib(key, style)

  return {
    key: raw.key,
    itemType,
    title: data.title || data.filename || '(无标题)',
    creators: (data.creators ?? []).map(creatorName).filter((n) => n !== ''),
    year: yearOf(raw.meta, data),
    publicationTitle: data.publicationTitle ?? '',
    url: data.url ?? '',
    doi: data.DOI ?? '',
    abstract: data.abstractNote ?? '',
    tags: (data.tags ?? []).map((tag) => tag.tag ?? '').filter((tag) => tag !== ''),
    collections: data.collections ?? [],
    attachments,
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
      `${LIB}/collections/${encode(collectionKey)}/items/top?limit=100&start=${offset}`,
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
      `${LIB}/items?itemKey=${batch.map(encode).join(',')}&format=bib&style=${encode(style)}`,
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
