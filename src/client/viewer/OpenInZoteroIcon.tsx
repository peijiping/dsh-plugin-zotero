/**
 * 「在 Zotero 中打开」按钮专用的跳转图标。
 *
 * 方框 + 从框里穿出去的箭头，表示「离开插件、在外部应用打开」。
 * 不用链条图标：那套符号的通用语义是「复制链接 / 建立关联」，放在这里
 * 会被读成点一下复制点什么，而不是跳出去。
 *
 * 纯 currentColor 描边，颜色跟着按钮文字走，深浅主题都不用另配一份；
 * 与工具条的 ZoomIcon / 列表的 SortIcon 是同一套路子。
 */

import type { ReactElement } from 'react'

/** 默认 12px，与 11.5px 字号的工具条 / 卡片小按钮相称。 */
export function OpenInZoteroIcon({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5 7.5 8.5" />
      <path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  )
}
