/**
 * 插入草稿的文本模板（见设计方案 §3）。
 *
 * 每段文本都带稳定标识（`itemKey` / `collectionKey`），方便模型接着用
 * `mcp__zotero__*` 工具跟进。
 */

import type { Translate } from './locales'
import { tpl } from './locales'
import { commentPlain } from './annotationComment'
import type {
  ZoteroAnnotation,
  ZoteroCollection,
  ZoteroItemDetail,
  ZoteroItemSummary,
  ZoteroNote,
} from '../zotero/types'

/** 整目录插入时最多列出多少条（完整清单交给模型的 MCP 工具）。 */
export const COLLECTION_PREVIEW_LIMIT = 50

function line(t: Translate, key: string, value: string): string {
  return tpl(t(key), { value })
}

/**
 * 单条目的引用文本。
 *
 * 不含摘要与标签：一次选中多条时这两段会把草稿撑得很长，模型拿着 itemKey
 * 就能取回全文元数据，不必在引用里重复。
 */
export function itemText(t: Translate, detail: ZoteroItemDetail): string {
  const head = tpl(t('cmp.item.header'), { key: detail.key, title: detail.title })
  const lines = [head]
  if (detail.creators.length > 0) lines.push(line(t, 'cmp.item.creators', detail.creators.join('、')))
  if (detail.year !== '') lines.push(line(t, 'cmp.item.year', detail.year))
  if (detail.publicationTitle !== '') lines.push(line(t, 'cmp.item.source', detail.publicationTitle))
  if (detail.doi !== '') lines.push(line(t, 'cmp.item.doi', detail.doi))
  if (detail.url !== '') lines.push(line(t, 'cmp.item.url', detail.url))
  return lines.join('\n')
}

/**
 * 选中片段的摘录文本。
 *
 * 只需要 key 与标题：提交时 codec 从摘录 chip 的 ref 里取回这两段，不再重新
 * 请求 Zotero，所以参数放宽到 {@link ZoteroItemDetail} 的最小子集。
 */
export function excerptText(
  t: Translate,
  detail: Pick<ZoteroItemDetail, 'key' | 'title'>,
  quote: string,
): string {
  const head = tpl(t('cmp.excerpt.header'), { title: detail.title, key: detail.key })
  const body = tpl(t('cmp.excerpt.quote'), { value: quote })
  return `${head}\n${body}`
}

/**
 * 摘录 chip 的标签：只放原文开头，胶囊自己会省略过长部分。
 *
 * PDF 抽取会在汉字之间插空格，标签里顺手清掉（展开给模型的原文不动）。
 */
export function excerptChipLabel(t: Translate, quote: string): string {
  return tpl(t('cmp.excerpt.chipLabel'), { value: summarize(quote) })
}

/**
 * 一段「原文 + 译文」的引用文本。
 *
 * 与纯摘录不同，这里把译文单独成段：模型读到的是对照文本，不需要自己再翻一遍。
 */
export function translationText(
  t: Translate,
  detail: Pick<ZoteroItemDetail, 'key' | 'title'>,
  quote: string,
  translated: string,
): string {
  const head = tpl(t('cmp.translation.header'), { title: detail.title, key: detail.key })
  const source = tpl(t('cmp.translation.quote'), { value: quote })
  const target = tpl(t('cmp.translation.translated'), { value: translated })
  return `${head}\n${source}\n${target}`
}

/** 翻译 chip 的标签：用译文开头，比原文更能说明这块内容是什么。 */
export function translationChipLabel(t: Translate, translated: string): string {
  return tpl(t('cmp.translation.chipLabel'), { value: summarize(translated) })
}

/** 截到 chip 能显示的长度；胶囊自己还会再省略，这里只是让 ref 前的标签短一点。 */
function summarize(text: string): string {
  const source = tidyAnnotation(text)
  const chars = Array.from(source)
  return chars.length > CHIP_LABEL_LIMIT ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…` : source
}

/**
 * PDF 抽取会在汉字之间插空格（`硫 化 氢`），展示与插入时去掉；
 * 只处理汉字与汉字之间的空格，避免动到西文词距。
 */
export function tidyAnnotation(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '')
    .trim()
}

/** 一条标注的引用文本：原文 + 类型 + 页码 + 评论 + 标注 key。 */
export function annotationText(
  t: Translate,
  detail: ZoteroItemDetail,
  annotation: ZoteroAnnotation,
): string {
  const comment = commentPlain(annotation.comment)
  const quote = tidyAnnotation(annotation.text) || comment
  const type = annotation.type === 'underline' ? t('annotation.type.underline') : t('annotation.type.highlight')
  const lines = [
    excerptText(t, detail, quote),
    tpl(t('cmp.annotation.type'), { value: type }),
  ]
  if (annotation.pageLabel !== '') lines.push(tpl(t('cmp.annotation.page'), { value: annotation.pageLabel }))
  if (comment !== '' && quote !== comment) lines.push(tpl(t('cmp.annotation.comment'), { value: comment }))
  lines.push(tpl(t('cmp.annotation.key'), { value: annotation.key }))
  return lines.join('\n')
}

/** chip 标签里原文摘要的长度上限（字符，非字节）。 */
const CHIP_LABEL_LIMIT = 40

/**
 * 标注 chip 的标签：原文摘要 + 页码。
 *
 * 标注没有标题字段，最能代表它的就是高亮那段原文；纯评论型标注退到评论。
 * 两者都空时返回空串，由 chip 构造处兜底成标注 key。
 */
export function annotationChipLabel(t: Translate, annotation: ZoteroAnnotation): string {
  const source = tidyAnnotation(annotation.text) || commentPlain(annotation.comment)
  if (source === '') return ''
  const chars = Array.from(source)
  const summary = chars.length > CHIP_LABEL_LIMIT
    ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…`
    : source
  return annotation.pageLabel === ''
    ? summary
    : `${summary}${tpl(t('cmp.annotation.pageTag'), { value: annotation.pageLabel })}`
}

/** 命名实体的最小集合（与 Host 清洗后的笔记 HTML 对齐）。 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: String.fromCharCode(38),
  lt: String.fromCharCode(60),
  gt: String.fromCharCode(62),
  quot: String.fromCharCode(34),
  apos: String.fromCharCode(39),
}

/** 解码 HTML 实体；未识别的实体原样保留。 */
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

/**
 * 笔记 HTML → 纯文本：块级标签转换行、列表项加 `- `，剥标签后解码实体。
 *
 * 只保留段落与列表结构，图片等没有文本的可选内容自然消失。
 */
export function noteHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/(?:p|div|h[1-6]|blockquote|li|tr|ul|ol|table|figure|figcaption|pre)>/giu, '\n')
      .replace(/<li\b[^>]*>/giu, '- ')
      .replace(/<[^>]*>/gu, ''),
  )
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    // `<li>` 里常包着 `<p>`，块级换行会把列表标记顶成单独一行，这里并回去。
    .replace(/(^|\n)- *\n/gu, '$1- ')
    .replace(/\n{2,}(?=- )/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * 单条笔记的引用文本：所属条目 + 正文纯文本 + 截断提示 + 更新日期 + 笔记 key。
 */
export function noteText(t: Translate, detail: ZoteroItemDetail, note: ZoteroNote): string {
  const head = tpl(t('cmp.note.header'), { title: detail.title, key: detail.key })
  const body = noteHtmlToText(note.html)
  const lines = [head]
  if (body !== '') lines.push(body)
  if (note.truncated) lines.push(t('cmp.note.truncated'))
  const date = note.dateModified.slice(0, 10)
  if (date !== '') lines.push(tpl(t('cmp.note.date'), { value: date }))
  lines.push(tpl(t('cmp.note.key'), { value: note.key }))
  return lines.join('\n')
}

/** 条目清单里的一行（目录引用与标签引用共用）。 */
function itemLine(t: Translate, item: ZoteroItemSummary): string {
  const meta = [item.creators, item.year].filter((part) => part !== '').join(', ')
  return tpl(t('cmp.collection.line'), { title: item.title, meta })
}

/** 整目录的引用文本（标题清单 + 稳定标识）。 */
export function collectionText(
  t: Translate,
  collection: ZoteroCollection,
  items: ZoteroItemSummary[],
  total: number,
): string {
  const head = tpl(t('cmp.collection.header'), {
    name: collection.name,
    key: collection.key,
    n: total,
  })
  const preview = items.slice(0, COLLECTION_PREVIEW_LIMIT)
  const lines = preview.map((item) => itemLine(t, item))
  if (total > preview.length) {
    lines.push(tpl(t('cmp.collection.more'), { n: preview.length }))
  }
  return [head, ...lines].join('\n')
}

/** 标签名的展示形式。 */
const TAG_JOINER = '、'

/** 模式文案（全部 / 任一）。 */
function tagModeLabel(t: Translate, mode: 'all' | 'any'): string {
  return t(mode === 'any' ? 'tags.matchAny' : 'tags.matchAll')
}

/** 单个标签的引用文本：标签头 + 全库该标签下的条目清单。 */
export function tagText(
  t: Translate,
  name: string,
  items: ZoteroItemSummary[],
  total: number,
): string {
  const head = tpl(t('cmp.tag.header'), { name, n: total })
  const preview = items.slice(0, COLLECTION_PREVIEW_LIMIT)
  const lines = preview.map((item) => itemLine(t, item))
  if (total > preview.length) lines.push(tpl(t('cmp.tag.more'), { n: preview.length }))
  return [head, ...lines].join('\n')
}

/**
 * 多个标签的引用文本：标签头（含模式）+ 每个标签的计数 + 条目清单 + 缺失提示。
 *
 * `counts` 只含文库里仍存在的标签；`missing` 单列一行，不阻断其余内容。
 */
export function tagSetText(
  t: Translate,
  names: readonly string[],
  mode: 'all' | 'any',
  counts: ReadonlyMap<string, number>,
  missing: readonly string[],
  items: ZoteroItemSummary[],
  total: number,
): string {
  const head = tpl(t('cmp.tagSet.header'), {
    tags: names.join(TAG_JOINER),
    mode: tagModeLabel(t, mode),
    n: total,
  })
  const lines = [head]
  for (const name of names) {
    const count = counts.get(name)
    if (count !== undefined) lines.push(tpl(t('cmp.tagSet.tags'), { name, n: count }))
  }
  if (missing.length > 0) {
    lines.push(tpl(t('cmp.tagSet.missingSome'), { names: missing.join(TAG_JOINER) }))
  }
  const preview = items.slice(0, COLLECTION_PREVIEW_LIMIT)
  for (const item of preview) lines.push(itemLine(t, item))
  if (total > preview.length) lines.push(tpl(t('cmp.tagSet.more'), { n: preview.length }))
  return lines.join('\n')
}

/**
 * 标签组 chip 的标签：`标签：A、B（全部）`，过长时截断。
 *
 * chip 宽度有限，标签多时只保留开头，完整清单在提交后的展开文本里。
 */
export function tagSetChipLabel(t: Translate, names: readonly string[], mode: 'all' | 'any'): string {
  const label = tpl(t('cmp.tagSet.label'), {
    tags: names.join(TAG_JOINER),
    mode: tagModeLabel(t, mode),
  })
  const chars = Array.from(label)
  return chars.length > CHIP_LABEL_LIMIT
    ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…`
    : label
}
