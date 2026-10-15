/**
 * 插入草稿的文本模板（见设计方案 §3）。
 *
 * 每段文本都带稳定标识（`itemKey` / `collectionKey`），方便模型接着用
 * `mcp__zotero__*` 工具跟进。
 */

import type { Translate } from './locales'
import { tpl } from './locales'
import type { ZoteroCollection, ZoteroItemDetail, ZoteroItemSummary } from '../zotero/types'

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
