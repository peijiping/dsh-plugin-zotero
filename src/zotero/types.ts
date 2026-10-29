/**
 * Host ↔ Client 的数据契约（见设计方案 §6）。
 *
 * Host 只回原始数据，文案拼接留给 Client。
 */

/**
 * 条目列表范围。
 *
 * `library` 为真实分类/全库（默认），其余三项是 Zotero 左侧栏的「虚拟分类」
 * （我的出版物 / 未分类条目 / 回收站），由对应端点直接支撑或推导得出。
 */
export type ZoteroItemScope = 'library' | 'publications' | 'unfiled' | 'trash'

/** 分类节点（扁平，Client 依 parentKey 建树）。 */
export interface ZoteroCollection {
  key: string
  name: string
  /** `false` 表示顶层分类。 */
  parentKey: string | false
  /** 条目数；虚拟分类在展开前未知，故可选。 */
  itemCount?: number
  /** 虚拟分类的范围；真实分类为空。 */
  scope?: ZoteroItemScope
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

/** 条目下的一条笔记（子条目 `itemType: "note"`）。 */
export interface ZoteroNote {
  key: string
  /** 笔记标题：取正文首段纯文本摘要（笔记本身无标题字段）。 */
  title: string
  /** 清洗后的正文 HTML（已剥离引用数据属性等，仅保留排版与图片）。 */
  html: string
  dateModified: string
  /** 正文超长被截断时为 true。 */
  truncated: boolean
}

/**
 * 条目下的一条 PDF 标注（子条目 `itemType: "annotation"`）。
 *
 * 只取高亮与划线：Zotero 支持两者互转，展示时以当前类型为准。
 */
export interface ZoteroAnnotation {
  key: string
  /** 所属附件 key；用于判断标注是否落在当前展示全文的那份 PDF 上。 */
  attachmentKey: string
  /** `highlight` 或 `underline`。 */
  type: string
  /** PDF 中选中的原文。 */
  text: string
  /**
   * 评论：Zotero 的富文本字面量（`<b>` / `<i>` / `<sub>` / `<sup>` / `<br>` / `<div>`
   * 以文本形式存储，不是可注入的 HTML），由 Client 按白名单解析。
   */
  comment: string
  /** Zotero 十六进制色，如 `#ffd400`；可能为空串。 */
  color: string
  /** PDF 印刷页码标签；可能为空串。 */
  pageLabel: string
  /** 在 `fulltext.content` 中的 UTF-16 区间；`null` 表示未能在全文里定位。 */
  range: { start: number; end: number } | null
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
  /** 该条目下的笔记（子条目 `itemType: "note"`）。 */
  notes: ZoteroNote[]
  /** 该条目下的高亮与划线。 */
  annotations: ZoteroAnnotation[]
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
