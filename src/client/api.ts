/**
 * Client 侧调 Host 只读端点（同源 fetch，前缀见 config.ROUTE_PREFIX）。
 *
 * 响应信封由 Host 产出：`{ok:true,data}` / `{ok:false,error}`。
 */

import type {
  ZoteroCollectionBib,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItems,
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

type Query = Record<string, string | number | undefined>

function buildUrl(action: string, query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const search = params.toString()
  return `${BASE}/${action}${search === '' ? '' : `?${search}`}`
}

async function get<T>(action: string, query: Query = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(buildUrl(action, query))
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

export function fetchTree(): Promise<ZoteroTree> {
  return get<ZoteroTree>('tree')
}

export function fetchItems(
  query: { collectionKey?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<ZoteroItems> {
  return get<ZoteroItems>('items', query)
}

export function fetchItem(key: string, style = 'apa'): Promise<ZoteroItemDetail> {
  return get<ZoteroItemDetail>('item', { key, style })
}

export function fetchCollectionBib(key: string, style = 'apa'): Promise<ZoteroCollectionBib> {
  return get<ZoteroCollectionBib>('collection-bib', { key, style })
}
