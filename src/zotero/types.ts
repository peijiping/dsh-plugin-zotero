/**
 * Host ↔ Client 的数据契约（见设计方案 §6）。
 *
 * Host 只回原始数据，文案拼接留给 Client。
 */

/** 分类节点（扁平，Client 依 parentKey 建树）。 */
export interface ZoteroCollection {
  key: string
  name: string
  /** `false` 表示顶层分类。 */
  parentKey: string | false
  itemCount: number
}

/** 列表行用的条目摘要。 */
export interface ZoteroItemSummary {
  key: string
  title: string
  /** Zotero 生成的作者摘要，如「Zhang, Li」。 */
  creators: string
  year: string
  itemType: string
  /** 是否有可读附件（决定详情里能否取全文）。 */
  hasAttachment: boolean
}

/** 条目下的一个附件。 */
export interface ZoteroAttachment {
  key: string
  title: string
  contentType: string
  size: number
}

/** 详情页数据。 */
export interface ZoteroItemDetail {
  key: string
  itemType: string
  title: string
  creators: string[]
  year: string
  publicationTitle: string
  url: string
  doi: string
  abstract: string
  tags: string[]
  /** 所属分类 key 列表。 */
  collections: string[]
  attachments: ZoteroAttachment[]
  fulltext: ZoteroFulltext | null
  bib: string | null
}

/** 附件全文（仅附件条目可取）。 */
export interface ZoteroFulltext {
  attachmentKey: string
  content: string
  truncated: boolean
}

/** 探活结果。 */
export interface ZoteroHealth {
  zotero: {
    running: boolean
    apiVersion: string | null
    serverId: string | null
    schemaVersion: string | null
  }
  library: {
    id: string
    name: string
  }
  /** 模型侧通道是否可用（由 Host 侧 TCP 探活 23120 得出）。 */
  mcp: {
    running: boolean
  }
}

/** 分类树数据。 */
export interface ZoteroTree {
  collections: ZoteroCollection[]
  libraryName: string
}

/** 条目列表数据。 */
export interface ZoteroItems {
  total: number
  items: ZoteroItemSummary[]
}

/** 分类引用导出数据。 */
export interface ZoteroCollectionBib {
  bib: string
  count: number
}

/** 错误码。 */
export type ApiErrorCode =
  | 'zotero_unreachable'
  | 'zotero_disabled'
  | 'zotero_not_found'
  | 'bad_request'
  | 'internal_error'

export interface ApiError {
  code: ApiErrorCode
  message: string
}

/** 统一响应信封。 */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError }
