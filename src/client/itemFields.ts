/**
 * 文献信息的字段顺序与文案（对齐 Zotero 信息栏）。
 *
 * 面板要「像 Zotero 那样」把条目有的字段全列出来：类型、作者、出版物、卷期页码、
 * 语言、版权、添加/修改时间……这些字段在 `ZoteroItemDetail.fields` 里已经原样
 * 到手（键 = Zotero 字段 id），这里只负责三件事：
 *
 * 1. **顺序**：按 Zotero 信息栏的次序排。Zotero 的次序本身按条目类型不同
 *    （图书是「出版社 → 地点 → 版次」，期刊是「卷次 → 期号 → 页码」），本地 API
 *    不暴露类型 schema，所以取一份「合并次序」：期刊文章那套打头，其余类型的
 *    专属字段插在语义相近的位置。空字段不渲染，合并次序在绝大多数条目上看不出差别。
 * 2. **文案**：`detail.field.<id>` 落在 locales 里，中英各一份。
 * 3. **格式**：只有时间戳需要处理（`dateAdded` / `dateModified` 是 ISO 串，
 *    Zotero 显示成 `2026/11/5 09:01:21`）。
 *
 * 这个文件不判断「显示不显示」之外的事：`fields` 里没有的键自然跳过，所以新增
 * 一个字段只要在这里插一行 + locales 加一条。
 */

import type { Translate } from './locales'

export interface ItemFieldRow {
  label: string
  value: string
}

/**
 * 字段顺序。
 *
 * 前半段严格照 Zotero 中文界面（截图核对过）：出版物 → 出版社 → 地点 → 日期 →
 * 卷次 → 期号 → 条文序号 → 分册号 → 分册标题 → 页码 → 系列 → 刊名简称 → DOI →
 * 网址 → 访问时间 → PMID → PMCID → ISSN → 档案 → 短标题 → 语言 → 文库编目 →
 * 索书号 → 版权 → 添加日期 → 修改日期。类型专属的字段（版次、会议名称、专利号…）
 * 插在相近语义处，只有对应类型的条目才会亮出来。
 */
const FIELD_ORDER: readonly string[] = [
  'publicationTitle',
  'publisher',
  'place',
  'edition',
  'date',
  'volume',
  'numberOfVolumes',
  'issue',
  'section',
  'partNumber',
  'partTitle',
  'pages',
  'numPages',
  'firstPage',
  'lastPage',
  'bookTitle',
  'proceedingsTitle',
  'conferenceName',
  'encyclopediaTitle',
  'dictionaryTitle',
  'websiteTitle',
  'blogTitle',
  'forumTitle',
  'programTitle',
  'episodeNumber',
  'series',
  'seriesTitle',
  'seriesText',
  'seriesNumber',
  'journalAbbreviation',
  'DOI',
  'url',
  'accessed',
  'PMID',
  'PMCID',
  'ISSN',
  'ISBN',
  'archive',
  'archiveLocation',
  'libraryCatalog',
  'callNumber',
  'shortTitle',
  'language',
  'rights',
  'reportNumber',
  'reportType',
  'institution',
  'university',
  'thesisType',
  'committee',
  'country',
  'assignee',
  'issuingAuthority',
  'patentNumber',
  'filingDate',
  'applicationNumber',
  'priorityNumbers',
  'issueDate',
  'legalStatus',
  'code',
  'number',
  'versionNumber',
  'artworkMedium',
  'artworkSize',
  'genre',
  'runningTime',
  'network',
  'studio',
  'label',
  'distributor',
  'videoRecordingFormat',
  'audioRecordingFormat',
  /*
   * 「其他」= Zotero 的 Extra，紧排在添加/修改日期之前（Zotero 里它也是最后一个
   * 正文字段）。整段原文照搬，多行保留换行 —— 万一和上面期刊指标卡里的胶囊重复
   * 也没关系：那块是摘要，这一行才是条目里真实存着的文本。
   * 紧随其后的引文键由 Better BibTeX 写入条目，装了 BBT 的库里才有。
   */
  'extra',
  'citationKey',
  'dateAdded',
  'dateModified',
]

/**
 * 时间戳人读化：`2026-11-24T07:17:01Z` → `2026/11/24 15:17:01`。
 *
 * API 给的是 **UTC**（Zotero 库里存 UTC，界面按本地时区渲染），所以要过一遍
 * `Date` 再用本地 getter —— 直接把字符串切开来显示会差出一个时区，用户对着
 * Zotero 信息栏看会以为插件记错了时间。
 *
 * 认不出格式就原样返回 —— 这类字段只是给「这条什么时候进的库」一个参照，
 * 不值得为它写一个容错解析器。
 */
function formatStamp(raw: string): string {
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return raw
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${String(at.getFullYear())}/${String(at.getMonth() + 1)}/${String(at.getDate())}`
  return `${date} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * 按 Zotero 的次序把字段摊成「标签 + 值」。
 *
 * `skip` 用来排除调用方自己渲染的字段（如「出版物」要单独放，好让期刊指标卡紧跟在
 * 它后面），避免一行出现两次。
 */
export function itemFieldRows(
  fields: Record<string, string>,
  t: Translate,
  skip: readonly string[] = [],
): ItemFieldRow[] {
  const rows: ItemFieldRow[] = []
  for (const id of FIELD_ORDER) {
    if (skip.includes(id)) continue
    const raw = fields[id]
    if (raw === undefined || raw.trim() === '') continue
    rows.push({
      label: t(`detail.field.${id}`),
      value: id === 'dateAdded' || id === 'dateModified' ? formatStamp(raw) : raw,
    })
  }
  return rows
}
