/**
 * 条目「已读」标志。
 *
 * Zotero 原生只记录附件最后阅读时间（`lastRead`），没有页码或百分比进度。
 * 画法：已读条目的**类型图标转粉色**（见 `ItemTypeIcon` 的 `read` 参数），
 * 标题同时略微淡化；hover 提示里补一行「最后阅读：…」。
 */

import type { CSSProperties } from 'react'

import type { ZoteroItemSummary } from '../zotero/types'
import { itemTypeLabel } from './itemType'
import { tpl, type Translate } from './locales'

/** 已读条目标题的淡化程度：留一点提示，又不至于看成禁用态。 */
const READ_TITLE_OPACITY = 0.75

export function isRead(item: ZoteroItemSummary): boolean {
  return item.lastRead !== null
}

/** 已读条目的标题淡化；未读返回空对象，直接展开不影响原有样式。 */
export function readTitleStyle(read: boolean): CSSProperties {
  return read ? { opacity: READ_TITLE_OPACITY } : {}
}

/** 行内 hover 提示：类型、读过的补一行最后阅读时间。 */
export function itemTooltip(t: Translate, item: ZoteroItemSummary): string {
  const lines = [item.title]
  const type = itemTypeLabel(t, item.itemType)
  if (type !== '') lines.push(tpl(t('item.type'), { type }))
  if (item.lastRead !== null) {
    const date = new Date(item.lastRead * 1000).toLocaleDateString()
    lines.push(tpl(t('item.lastRead'), { date }))
  }
  return lines.join('\n')
}
