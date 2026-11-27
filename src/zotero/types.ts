/**
 * Host ↔ Client 的数据契约（见设计方案 §6）。
 *
 * Host 只回原始数据，文案拼接留给 Client。
 */

/**
 * 条目列表范围。
 *
 * `library` 为真实分类/全库（默认），其余是左侧栏的「虚拟分类」：
 * 我的出版物 / 未分类条目 / 回收站由 Zotero 端点直接支撑或推导；
 * `recent` 是**本插件自己的**最近阅读（数据来自阅读进度记录，Zotero 本地 API 不提供）。
 */
export type ZoteroItemScope = 'library' | 'publications' | 'unfiled' | 'trash' | 'recent'

/**
 * 快速搜索口径，对应 Zotero 搜索框左侧的三档（本地 API 的 `qmode`）。
 *
 * - `titleCreatorYear`：标题 / 出版物 / 年份 / 作者等元数据
 * - `fields`：所有字段与标签（含笔记、标注），**不含**全文
 * - `everything`：在 `fields` 基础上再加附件全文索引
 */
export type ZoteroSearchMode = 'titleCreatorYear' | 'fields' | 'everything'

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
  /**
   * 所属文库：缺省 = 用户文库，`group:<id>` = 群组文库。
   *
   * 群组与用户文库的分类 key 不在同一命名空间，选中身份必须带上它。
   */
  library?: string
  /** 已保存搜索的 key；仅「已保存搜索」节点有值。 */
  searchKey?: string
}

/** 群组文库（本地 API 只给识别信息，成员与权限不暴露）。 */
export interface ZoteroGroup {
  /** 群组数字 id（路径里用）。 */
  id: string
  name: string
  /** 组内条目数；取不到时为 undefined。 */
  itemCount?: number
}

/** 已保存搜索（只有名字与 key，条件由 Zotero 自己执行）。 */
export interface ZoteroSavedSearch {
  key: string
  name: string
}

/**
 * 条目列表里「附件形态」的判定结果。
 *
 * 同时用于展开行的子项和顶层裸附件条目（直接导进库的 PDF / 快照等）。
 * Host 从 `itemType` / `contentType` / `linkMode` / 文件名判定，Client 只按它挑图标；
 * 笔记也在内（`note`），虽然 Zotero 严格意义上不把它算作附件。
 */
export type ZoteroChildKind = 'pdf' | 'snapshot' | 'webpage' | 'note' | 'file'

/** 列表展开行里的子项（附件与笔记，只够渲染一行）。 */
export interface ZoteroChildAttachment {
  key: string
  title: string
  kind: ZoteroChildKind
}

/** 列表行用的条目摘要。 */
export interface ZoteroItemSummary {
  key: string
  title: string
  /** Zotero 生成的作者摘要，如「Zhang, Li」。 */
  creators: string
  year: string
  itemType: string
  /** 条目自身的形态；`itemType === 'attachment'` 时据此画具体图标而非纸夹。 */
  kind: ZoteroChildKind
  /** 子项（附件 + 子笔记）；空数组表示没有可展开内容。 */
  attachments: ZoteroChildAttachment[]
  /**
   * 子附件里最晚的阅读时间（Unix **秒**），与 Zotero 原生 `getItemLastRead()` 一致；
   * `null` 表示从未读过。Zotero 不记录读到第几页，只有这一个「读过没有」的信号。
   */
  lastRead: number | null
  /**
   * 列表行直接可画的期刊标签；`null` 表示当前还没有可用数据（未命中留空）。
   *
   * 由 Host 从「Style 结果 → 插件本地缓存」同步带出，**列表渲染不发任何请求**。
   */
  journalTags?: JournalTags | null
}

/* ── 期刊标签（三源归一） ────────────────────────────────────────── */

/**
 * easyScholar `/open/getPublicationRank` 的返回值（Host 侧只保留这些字段）。
 *
 * `casBase` 是中科院**基础版**分区（Style 的 `sciBase`），与升级版 `casUp`
 * 口径不同，两者不能互相顶替 —— 用户看到的 Style 列用的是基础版。
 */
export interface JournalRank {
  impactFactor: string
  jcrQuartile: string
  fiveYearIf: string
  casUp: string
  casUpSmall: string
  casUpTop: string
  casBase: string
  casWarn: string
  xr: string
  xrTop: string
  ccf: string
  pku: string
  cssci: string
  /** Style 的 `eii`（EI 收录）；easyScholar 侧字段名可能是 `ei` / `eii`。 */
  ei: string
  /** Style 的 `zhongguokejihexin`（中国科技核心期刊，即「科核」）。 */
  zhongguokejihexin: string
}

export type JournalRankOutcome =
  | { status: 'ok'; rank: JournalRank }
  | { status: 'no_key' }
  | { status: 'miss' }
  | { status: 'failed'; message: string }

/**
 * 按 Zotero Style「期刊标签」列配置生成的一枚胶囊。
 *
 * `label` / `value` 已经走完 Style 的字段显示名与 Map 规则，Client 只管画。
 * 用数组而不是固定字段，是为了让「Zotero 配了哪些字段、按什么顺序显示」完全
 * 由用户自己的配置决定 —— 我们不再维护第二套字段白名单。
 */
export interface JournalTagEntry {
  label: string
  value: string
}

/**
 * 归一后的期刊标签。
 *
 * `impactFactor` / `jcrQuartile` / `casQuartile` 等仍保留，供详情来源说明与旧
 * Host 数据兼容；**实际显示以 `mirrored` 为准**。mirrored 为空表示按 Style 的
 * Fields 配置这一屏没有可显示的项，跟 Zotero 那列留空是同一语义。
 *
 * `source` 只用于详情面板的来源说明，列表不显示。
 */
export interface JournalTags {
  impactFactor: string
  jcrQuartile: string
  casQuartile: string
  /** 原样值 `EI`；空串表示未收录。 */
  ei: string
  /** 原样值 `1`；空串表示非北大核心。 */
  pku: string
  /** 原样值「中国科技核心期刊」；空串表示非科技核心。 */
  zhongguokejihexin: string
  /**
   * 按 Style 有效配置镜像出的胶囊；缺失表示旧 Host 数据，Client 走兼容渲染。
   */
  mirrored?: JournalTagEntry[]
  source: 'style' | 'cache' | 'api'
}

export type JournalTagsOutcome =
  | { status: 'ok'; tags: JournalTags }
  | { status: 'no_key' }
  | { status: 'miss' }
  | { status: 'failed'; message: string }

/** 条目下的一个附件。 */
export interface ZoteroAttachment {
  key: string
  title: string
  /** 磁盘文件名，如 `paper.pdf`；缺失时为空串。 */
  filename: string
  contentType: string
  size: number
}

/**
 * 「相关」区里的一条：Zotero `data.relations` 的 `dc:relation` 指向的条目。
 *
 * 只给识别信息 —— 面板里是一行标题，点开才取那条的整份详情，不需要在这里
 * 把元数据一起搬过来。
 */
export interface ZoteroRelatedItem {
  key: string
  /** 标题；笔记与无标题附件由 Host 从正文 / 文件名兜底。 */
  title: string
  itemType: string
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
  /**
   * 期刊 ISSN（原始串，多值以空格分隔）。
   *
   * 期刊指标检索的唯一可靠锚点：刊名会缩写、会改名、会有同名刊，ISSN 不会。
   * Zotero 里这一栏经常是空的（实测本机 100 条期刊论文只有 12 条填了），
   * 所以读取方必须准备好回落到刊名。
   */
  issn: string
  /** 期刊缩写（如 `J. Am. Chem. Soc.`），同样常为空。 */
  journalAbbreviation: string
  /**
   * `extra` 原始文本。
   *
   * Zotero 官方 schema 没有任何评价性字段（影响因子、分区、被引），社区插件的
   * 通行做法就是往这里塞 `键: 值` 行 —— Zotero Citation Counts Manager 的
   * README 原话是「Zotero doesn't have any special field for the number of
   * citations, so they are stored in the Extra field」。
   *
   * 本插件只读不写：解析见 `client/journalMetrics.ts`，回写会污染用户文库，
   * 且要承担数据错误的责任。
   */
  extra: string
  url: string
  doi: string
  abstract: string
  /**
   * 除结构化字段外的全部标量字段：键 = Zotero 字段 id（`publisher` / `pages` /
   * `PMID` / `dateAdded` …），值已 trim、空值不出现。
   *
   * 单独给一份而不是把每个字段都写进这个接口：Zotero 的字段集按条目类型有几十个，
   * 逐字段声明既写不完，也会让「面板要不要显示」这种展示决策渗进 Host。顺序与文案
   * 全在 `client/itemFields.ts`。
   *
   * 可选：只重建 client 没重启 Host 时这份字段还不存在，读取方一律 `?? {}`。
   */
  fields?: Record<string, string>
  tags: string[]
  /**
   * 「相关」条目（`data.relations` 的 `dc:relation`），按 Zotero 信息栏的次序。
   *
   * 可选：只重建 client 没重启 Host 时这份数据还不存在，读取方一律 `?? []`。
   * 只在当前文库能解析到的条目才在列表里（别库 / 已删除的关联静默跳过）。
   */
  related?: ZoteroRelatedItem[]
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
  /** Identity of the indexed text and the applied length limit. */
  revision?: string
  content: string
  truncated: boolean
  /**
   * 截断**之前**全文的字符数。
   *
   * `content.length` 被上限削过之后，就没法再说「缺了多少」——面板与展开文本都
   * 需要真实总量才能报出「原文共 X 字，本次只含前 Y 字」。未截断时等于
   * `content.length`。
   *
   * 可选：只重建了 client 还没重启 Host 时，这条字段还不存在（旧 Host 只会给
   * 上面三个字段）。读取方一律写 `?? content.length`，别拿 undefined 去做算术。
   */
  totalChars?: number
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
  /** 「最近阅读」当前可列出的条数（上限见 `view-state.RECENT_LIMIT`）。 */
  recentCount: number
  /** 当前文库的已保存搜索（群组文库同样有自己的搜索）。 */
  searches?: ZoteroSavedSearch[]
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

/** 浮层左上角坐标（视口坐标，单位 px）。 */
export interface ZoteroPanelPos {
  left: number
  top: number
}

/** 浮层尺寸（px）。 */
export interface ZoteroPanelSize {
  width: number
  height: number
}

/**
 * 一类浮层在某条目上记住的几何。
 *
 * `pos` / `size` **各自独立**：只拖过位置就只存 `pos`，下次打开高度仍随内容走。
 */
export interface ZoteroPanelBox {
  pos?: ZoteroPanelPos
  size?: ZoteroPanelSize
  /** 最近改动时间（毫秒时间戳），条目超上限时按它淘汰。 */
  at: number
}

/** 会记几何的浮层：目录、信息。 */
export type ZoteroPanelKind = 'outline' | 'info'

/** 一个条目下的各浮层几何。 */
export interface ZoteroItemBoxes {
  outline?: ZoteroPanelBox
  info?: ZoteroPanelBox
}

/**
 * 本插件的「视图状态」。
 *
 * 和 `read-positions.json` 时代一样，全部本地留存、与 Zotero 无关：`sections` 是
 * 信息浮层各区块的开合（全局一份），`boxes` 是每个条目上浮层被拖到哪、拉多大。
 */
export interface ZoteroViewState {
  sections: Record<string, boolean>
  boxes: Record<string, ZoteroItemBoxes>
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
  /** 翻译服务返回失败或网络不通 → HTTP 502。 */
  | 'translate_failed'
  /** 翻译服务不可用（没接上宿主模型且免密钥端点也失败）→ HTTP 503。 */
  | 'translate_unavailable'

/**
 * 可由页面一键执行的修复动作。
 *
 * `message` 只说「哪儿坏了」，这个字段说「点一下能去哪儿修」——像目录授权这类
 * 问题，光给文字用户找不到入口。目前只有 macOS 的「文件与文件夹」授权面板
 * 有稳定可用的 URL scheme，其余情况仍走纯文案。
 */
export type ApiFix = 'privacy-files'

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
