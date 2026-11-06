/**
 * Client 侧调 Host 只读端点（同源 fetch，前缀见 config.ROUTE_PREFIX）。
 *
 * 响应信封由 Host 产出：`{ok:true,data}` / `{ok:false,error}`。
 */

import type {
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemScope,
  ZoteroItems,
  ZoteroTags,
  ZoteroTree,
} from '../zotero/types'

const BASE = '/dsh-zotero/api'

/** Host 返回的错误，携带 §6 的错误码。 */
export class ApiFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
  }
}

type QueryValue = string | number | readonly string[] | undefined
type Query = Record<string, QueryValue>

function buildUrl(action: string, query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== '') params.append(key, item)
      }
    } else {
      params.set(key, String(value))
    }
  }
  const search = params.toString()
  return `${BASE}/${action}${search === '' ? '' : `?${search}`}`
}

async function get<T>(action: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(buildUrl(action, query), { signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure('network_error', `无法访问 Host 端点：${message}`)
  }
  const payload = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
    | null
  if (payload === null) throw new ApiFailure('internal_error', `Host 返回了非 JSON 响应（HTTP ${res.status}）`)
  if (!payload.ok) throw new ApiFailure(payload.error.code, payload.error.message)
  return payload.data
}

export function fetchHealth(): Promise<ZoteroHealth> {
  return get<ZoteroHealth>('health')
}

export function fetchTree(signal?: AbortSignal): Promise<ZoteroTree> {
  return get<ZoteroTree>('tree', {}, signal)
}

export function fetchItems(
  query: {
    scope?: ZoteroItemScope
    collectionKey?: string
    q?: string
    tags?: readonly string[]
    tagMode?: 'all' | 'any'
    limit?: number
    offset?: number
  } = {},
  signal?: AbortSignal,
): Promise<ZoteroItems> {
  const { tags, ...rest } = query
  // Host 侧标签参数名是 `tag`（AND 靠重复出现，OR 由 Host 拼成 `A || B`）。
  return get<ZoteroItems>('items', { ...rest, ...(tags === undefined ? {} : { tag: tags }) }, signal)
}

export function fetchTags(signal?: AbortSignal): Promise<ZoteroTags> {
  return get<ZoteroTags>('tags', {}, signal)
}

/** 当前范围（分类子树 / 虚拟分类 + 搜索词）内的标签用量。 */
export function fetchTagUsage(
  query: {
    scope?: ZoteroItemScope
    collectionKeys?: readonly string[]
    q?: string
  } = {},
  signal?: AbortSignal,
): Promise<ZoteroTags> {
  const { collectionKeys, ...rest } = query
  // Host 侧参数名是 `collectionKey`（子树靠重复出现传多个 key）。
  return get<ZoteroTags>(
    'tag-usage',
    { ...rest, ...(collectionKeys === undefined ? {} : { collectionKey: collectionKeys }) },
    signal,
  )
}

export function fetchItem(key: string, style = 'apa', signal?: AbortSignal): Promise<ZoteroItemDetail> {
  return get<ZoteroItemDetail>('item', { key, style }, signal)
}

/** 附件文件地址；直接交给 PDF.js / Word 渲染器按 Range 取流。 */
export function fileUrl(key: string): string {
  return buildUrl('file', { key })
}

/** 用系统 Zotero 打开条目或附件页。 */
export async function openInZotero(
  input: { key: string; kind: 'item' | 'attachment'; page?: number },
): Promise<void> {
  let res: Response
  try {
    res = await fetch(buildUrl('open-in-zotero'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure('network_error', `无法访问 Host 端点：${message}`)
  }
  const payload = (await res.json().catch(() => null)) as
    | { ok: true }
    | { ok: false; error: { code: string; message: string } }
    | null
  if (payload === null) throw new ApiFailure('internal_error', `Host 返回了非 JSON 响应（HTTP ${res.status}）`)
  if (!payload.ok) throw new ApiFailure(payload.error.code, payload.error.message)
}
