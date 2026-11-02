/**
 * 条目「已读」标志。
 *
 * Zotero 原生只记录附件最后阅读时间（`lastRead`），没有页码或百分比进度。
 * 画法：标题前一个**始终占位**的 4px 圆点槽（未读留空，保证各行文字起点对齐），
 * 已读时点亮，标题略微淡化；hover 提示里补一行「最后阅读：…」。
 */

import type { CSSProperties, ReactElement } from 'react'

import type { ZoteroItemSummary } from '../zotero/types'
import { tpl, type Translate } from './locales'

/**
 * 已读圆点颜色：柔和的粉色。
 *
 * 不用主题蓝：蓝点在列表里很像「未读消息」徽标，粉色更接近 Zotero Style 的
 * 阅读进度条配色，读起来是「标记」而不是「待办」。
 */
const READ_DOT_COLOR = '#e8798d'

/** 已读条目标题的淡化程度：留一点提示，又不至于看成禁用态。 */
const READ_TITLE_OPACITY = 0.75

export function isRead(item: ZoteroItemSummary): boolean {
  return item.lastRead !== null
}

/** 圆点槽位：未读时透明但仍占宽，避免已读/未读行的标题起点错位。 */
export function ReadDot({ read }: { read: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      style={{
        width: 4,
        height: 4,
        borderRadius: '50%',
        flexShrink: 0,
        // 列表行有的按基线对齐（搜索结果），靠 alignSelf 让圆点始终居中。
        alignSelf: 'center',
        background: read ? READ_DOT_COLOR : 'transparent',
        opacity: read ? 0.9 : 0,
      }}
    />
  )
}

/** 已读条目的标题淡化；未读返回空对象，直接展开不影响原有样式。 */
export function readTitleStyle(read: boolean): CSSProperties {
  return read ? { opacity: READ_TITLE_OPACITY } : {}
}

/** 行内 hover 提示：读过的在标题后补一行最后阅读时间。 */
export function itemTooltip(t: Translate, item: ZoteroItemSummary): string {
  if (item.lastRead === null) return item.title
  const date = new Date(item.lastRead * 1000).toLocaleDateString()
  return `${item.title}\n${tpl(t('item.lastRead'), { date })}`
}
