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
  /**
   * 子附件里最晚的阅读时间（Unix **秒**），与 Zotero 原生 `getItemLastRead()` 一致；
   * `null` 表示从未读过。Zotero 不记录读到第几页，只有这一个「读过没有」的信号。
   */
  lastRead: number | null
}

/** 条目下的一个附件。 */
export interface ZoteroAttachment {
  key: string
  title: string
  /** 磁盘文件名，如 `paper.pdf`；缺失时为空串。 */
  filename: string
  contentType: string
  size: number
}

/** Host 侧解析出的附件文件（路径只来自 Zotero 条目 JSON）。 */
export interface ZoteroAttachmentFile {
  key: string
  path: string
  size: number
  contentType: string
  filename: string
}

/**
 * 附件可读性探测（`/api/attachment-info`）。
 *
 * 存在的意义是**解释失败**：`/api/file` 的 4xx 只会被 pdf.js 回显成一句
 * 「Unexpected server response (404)」，真正的原因（文件不存在 / 无权限 /
 * 没有本地文件）在这个端点里以普通 JSON 给出，前端据此显示人话。
 */
export interface ZoteroAttachmentInfo {
  key: string
  filename: string
  /** 规范化后的 MIME：小写、不含参数；无法判断时为空串。 */
  contentType: string
  size: number
  /** 该类型能否由插件直接流式预览。 */
  servable: boolean
}

/** 条目上的一条标签（`data.tags` 的元素，标注与笔记同构）。 */
export interface ZoteroTagRef {
  tag: string
  /** 0 自动标签，1 手动标签。写入时一律给 1。 */
  type: number
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
  /** Zotero 条目版本：更新 / 删除要原样带回做并发前置条件。 */
  version: number
  /** 所属父条目 key；独立笔记（无父条目）为空串。 */
  parentItem: string
  /**
   * 正文是否含 Zotero 的结构锚点（引文 `data-citation`、标注反链 `data-annotation`）。
   *
   * 早期据此禁掉编辑按钮，现已放开：编辑器读的是**原始 HTML**、写回也原样落库，
   * 中间不做任何规范化，锚点只要没被手改就完好。这个标记现在只用于在编辑器里
   * 挂一句提醒（改动这些标签会让 Zotero 侧的引文失联）。
   */
  anchored: boolean
}

/**
 * 网页快照里的标注位置。
 *
 * Zotero 对 snapshot / EPUB 用 Web Annotation 的形态：
 * `{ type: 'CssSelector', value: 'p:nth-child(6)',
 *    refinedBy: { type: 'TextPositionSelector', start: 7, end: 69 } }`。
 * `selector` 定位到元素，`start`/`end` 是该元素 `textContent` 内的 UTF-16 区间。
 * 只在能被 iframe 里的 DOM 直接用时才有意义，所以和 PDF 的 `position` 分开存。
 */
export interface ZoteroWebPosition {
  selector: string
  start: number
  end: number
}

/**
 * 条目下的一条 PDF 标注（子条目 `itemType: "annotation"`）。
 *
 * 覆盖 Zotero 的六种标注类型；高亮与划线可互转，展示时以当前类型为准。
 */
export interface ZoteroAnnotation {
  key: string
  /** 所属附件 key；用于判断标注是否落在当前展示全文的那份 PDF 上。 */
  attachmentKey: string
  /** `highlight | underline | note | text | image | ink`。 */
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
  /**
   * PDF 中的位置：`pageIndex` 从 0 开始，`rects` 为 PDF 用户空间（左下原点）的
   * `[x1, y1, x2, y2]`。旧版 Zotero 未提供或墨迹标注时为 `null`。
   */
  position: { pageIndex: number; rects: [number, number, number, number][] } | null
  /**
   * 网页快照里的位置。PDF / EPUB 标注为 `null`；两个字段互斥，恰好一个非空。
   *
   * 单独开一个字段而不是把 `position` 改成判别联合：后者要同时改 PdfViewer、
   * AnnotationOverlay、AnnotationList、写入校验四处，而 web 标注的 `position`
   * 恒为 `null`，现有可选链天然跳过它。
   */
  webPosition: ZoteroWebPosition | null
  /** 在 `fulltext.content` 中的 UTF-16 区间；`null` 表示未能在全文里定位。 */
  range: { start: number; end: number } | null
  /** Zotero 条目版本：改色 / 改评论 / 删除要原样带回做并发前置条件。 */
  version: number
  /**
   * 原始 `annotationSortIndex`（`页码|字符偏移|顶端距` 零填充串）。
   *
   * 列表排序与「同页接续新建」都要用它；Zotero 老数据里可能为空串。
   * 网页标注的形态是 7 位纯数字（`0000549`），与 PDF 不同但同样可按字典序比较。
   */
  sortIndex: string
  /** 标注自身的标签。写入时整表替换（PATCH 对数组是替换而非追加）。 */
  tags: ZoteroTagRef[]
}

/**
 * 面板/模型想改的标注字段。
 *
 * 键名用我们自己的语义，Host 再翻译成 Zotero 的 `annotation*` 字段：这样写侧的
 * 校验规则（色值限色调板、类型限高亮/划线）有唯一的落点，调用方也传不出怪字段。
 * 至少给一个字段，空 patch 会被拒——发一个什么都不改的 PATCH 没有意义。
 */
export interface ZoteroAnnotationPatch {
  /** Zotero 调色板里的十六进制色，如 `#ff6666`。 */
  color?: string
  /** 评论：Zotero 的字面量标签文本。 */
  comment?: string
  /** 仅 `highlight` / `underline`，且只在两者之间互转。 */
  type?: string
  /** PDF 印刷页码标签；空串表示清除。 */
  pageLabel?: string
  /** 标注自身的标签，整表替换。 */
  tags?: ZoteroTagRef[]
}

/**
 * 面板从选区算出来、等着写进 Zotero 的一条标注。
 *
 * 字段名刻意贴住 Zotero 的 `annotation*`：这条是「要原样落库的东西」，不是展示契约。
 * 位置与排序键由客户端算（只有它手里有 viewport 和文本层），Host 只做校验和序列化。
 *
 * `position` 与 `webPosition` **恰好给一个**：PDF 走前者，网页快照走后者，
 * 由 Host 按附件类型校验后翻译成 Zotero 的 `annotationPosition`。
 */
export interface ZoteroAnnotationDraft {
  /** 仅 `highlight` / `underline`。 */
  annotationType: string
  /** 选中原文；换行按 Zotero 的惯例折成空格。 */
  annotationText: string
  /** Zotero 调色板里的十六进制色。 */
  annotationColor: string
  /** 印刷页码标签；算不出来时为空串（Zotero 自己会留空）。 */
  annotationPageLabel: string
  /** `00001|000220|00179` 形态（PDF）或 `0000549`（网页快照）的排序键。 */
  annotationSortIndex: string
  /** PDF 用户空间的位置；`rects` 数值已按 Zotero 的精度截到 3 位小数。 */
  position?: { pageIndex: number; rects: [number, number, number, number][] }
  /** 网页快照的位置；与 `position` 互斥。 */
  webPosition?: ZoteroWebPosition
  /** 可选评论（Zotero 的字面量标签文本）。 */
  annotationComment?: string
}

/** 写入前核对的标注现状。 */
export interface ZoteroAnnotationState {
  key: string
  /** Zotero 条目版本；只作参考，写请求仍带回调用方手里的那份。 */
  version: number
  /** 所属附件 key。 */
  parentItem: string
  /** `annotationType`，如 `highlight`。 */
  type: string
}

/** 未经清洗、未截断的笔记正文（编辑器的取数通道）。 */
export interface ZoteroNoteRaw {
  key: string
  version: number
  /** 所属父条目 key；独立笔记为空串。 */
  parentItem: string
  /** Zotero 里原样存着的 HTML，含 `data-citation` 等结构锚点。 */
  html: string
}

/** 一次写操作的回执。 */
export interface ZoteroWriteRef {
  key: string
  /** 写入后的条目版本；Zotero 未在响应里给出时为 `null`（面板随后整份重取）。 */
  version: number | null
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
  /** 所属分类的完整路径（如「博士论文 / 方法」），由 Host 解析好。 */
  collectionNames: string[]
  attachments: ZoteroAttachment[]
  /** 该条目下的笔记（子条目 `itemType: "note"`）。 */
  notes: ZoteroNote[]
  /** 该条目下的高亮与划线。 */
  annotations: ZoteroAnnotation[]
  fulltext: ZoteroFulltext | null
  bib: string | null
  /**
   * 写入总开关（配置项 `writeEnabled`）当前是否打开。
   *
   * 随详情一起下发，省掉面板每次渲染去问一次 `auth-status`。它只代表开关，
   * 不含授权状态：没 key 时写请求会带着「去哪点授权」的文案失败。
   */
  writeEnabled: boolean
}

/** 附件全文（仅附件条目可取）。 */
export interface ZoteroFulltext {
  attachmentKey: string
  content: string
  truncated: boolean
  /** 首选附件没有全文索引，正文取自同条目的其他附件。 */
  fallback: boolean
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

/** 文库级标签（计数是全库的）。 */
export interface ZoteroTag {
  name: string
  count: number
  /** 0 自动标签，1 手动标签。 */
  type: number
}

/** 标签列表数据。 */
export interface ZoteroTags {
  total: number
  tags: ZoteroTag[]
}

/** 分类引用导出数据。 */
export interface ZoteroCollectionBib {
  bib: string
  count: number
}

/**
 * 写通道状态（供配置卡渲染状态徽标 + 授权按钮）。
 *
 * key 只存在 Host 进程内存与本机 `0600` 文件里，因此这里只报「有没有」，绝不外泄
 * key 本体，也不把 key 的存储路径回传给客户端。
 */
export interface ZoteroWriteStatus {
  /** 写入总开关（`writeEnabled`）当前是否打开。 */
  enabled: boolean
  /** 是否持有可用的本地 API key（内存或本机已保存的授权）。 */
  hasKey: boolean
  /**
   * 当前 key 是否可复用；`false` 表示一次性，首个写请求即消耗。
   *
   * 从本机保存的授权恢复出来的一定是 `true`（只保存「始终允许」的 key）。
   */
  remembered: boolean
}

/** 一次授权请求的结果。 */
export interface ZoteroAuthResult {
  /** 用户是否点了「始终允许」。`false` 时 key 用一次就失效，需要再次授权。 */
  remembered: boolean
}

/**
 * 一篇文献在**本插件里**「读到哪」。
 *
 * 只存在插件自己的存储里，与 Zotero 的阅读位置互不相干：用户可能在两边各读一段，
 * 硬把 Zotero 的页码搬过来只会跳到别处。Zotero 的 `dataDir` 又可能是任意位置，
 * 插件拿不到可靠路径，所以干脆不读。
 */
export interface ZoteroReadPosition {
  key: string
  /** 0 基页码；Client 展示时要 +1。 */
  pageIndex: number
  /** 记录时间（ISO 8601）。 */
  updatedAt: string
}

/** 错误码。 */
export type ApiErrorCode =
  | 'zotero_unreachable'
  | 'zotero_disabled'
  | 'zotero_not_found'
  | 'bad_request'
  | 'internal_error'
  /** 写通道没有可用 key（未授权，或 key 已被一次性消耗）→ HTTP 401。 */
  | 'zotero_need_auth'
  /** 用户在 Zotero 弹窗里点了「拒绝」→ HTTP 403。 */
  | 'zotero_denied'
  /** 条目版本已变化（Zotero 侧改过），需重取后重试 → HTTP 412。 */
  | 'zotero_stale'
  /** 目标库被锁定（同步中）→ HTTP 409。 */
  | 'zotero_conflict'
  /** 授权弹窗过于频繁（每分钟 5 次上限）→ HTTP 429。 */
  | 'zotero_rate_limited'

/**
 * 可由页面一键执行的修复动作。
 *
 * `message` 只说「哪儿坏了」，这个字段说「点一下能去哪儿修」——像目录授权、
 * 链接附件基础目录这类问题，光给文字用户找不到入口。
 *
 * - `privacy-files`：macOS 的「隐私与安全性 → 文件与文件夹」面板；
 * - `zotero-settings`：Zotero 首选项（链接附件基础目录那一页）。
 */
export type ApiFix = 'privacy-files' | 'zotero-settings'

export interface ApiError {
  code: ApiErrorCode
  message: string
  /** 有值表示这个错误有「一键去哪儿修」的入口，前端据此出按钮。 */
  fix?: ApiFix
}

/** 统一响应信封。 */
export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError }
