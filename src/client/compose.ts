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
const COLLECTION_PREVIEW_LIMIT = 50

function line(t: Translate, key: string, value: string): string {
  return tpl(t(key), { value })
}

/** 单条目的引用文本。 */
export function itemText(t: Translate, detail: ZoteroItemDetail): string {
  const head = tpl(t('cmp.item.header'), { key: detail.key, title: detail.title })
  const lines = [head]
  if (detail.creators.length > 0) lines.push(line(t, 'cmp.item.creators', detail.creators.join('、')))
  if (detail.year !== '') lines.push(line(t, 'cmp.item.year', detail.year))
  if (detail.publicationTitle !== '') lines.push(line(t, 'cmp.item.source', detail.publicationTitle))
  if (detail.doi !== '') lines.push(line(t, 'cmp.item.doi', detail.doi))
  if (detail.url !== '') lines.push(line(t, 'cmp.item.url', detail.url))
  if (detail.tags.length > 0) lines.push(line(t, 'cmp.item.tags', detail.tags.join('、')))
  if (detail.abstract !== '') lines.push(line(t, 'cmp.item.abstract', detail.abstract))
  return lines.join('\n')
}

/** 选中片段的摘录文本。 */
export function excerptText(t: Translate, detail: ZoteroItemDetail, quote: string): string {
  const head = tpl(t('cmp.excerpt.header'), { title: detail.title, key: detail.key })
  const body = tpl(t('cmp.excerpt.quote'), { value: quote })
  return `${head}\n${body}`
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

/** 单条笔记的引用文本：所属条目 + 正文纯文本 + 截断提示 + 更新日期 + 笔记 key。 */
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
  const lines = preview.map((item) => {
    const meta = [item.creators, item.year].filter((part) => part !== '').join(', ')
    return tpl(t('cmp.collection.line'), { title: item.title, meta })
  })
  if (total > preview.length) {
    lines.push(tpl(t('cmp.collection.more'), { n: preview.length }))
  }
  return [head, ...lines].join('\n')
}
