/**
 * 插件里反复出现的动作图标：加入对话 / 复制 / 翻译。
 *
 * 与项目其余图标一致：手写内联 SVG（client bundle 不能 import .svg），
 * 描边取 `currentColor`，颜色跟着按钮文字走。
 */

import type { ReactElement } from 'react'

/**
 * 「加入对话」统一图标：聊天气泡。
 *
 * 条目右键菜单、详情页按钮、标注 / 笔记行、译文卡片、截图确认、选区浮条都引这一条
 * path，改这里就全站生效，不再各处手抄一份。
 */
export const CHAT_ICON_PATH =
  'M18 11h-7l-4 3v-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2Z'

export function ChatIcon({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={CHAT_ICON_PATH} />
    </svg>
  )
}

/** 复制：两张错开的纸。 */
export function CopyIcon({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="5.7" y="2.3" width="8.2" height="9.4" rx="1.5" />
      <path d="M3.4 5.6v6.7a1.4 1.4 0 0 0 1.4 1.4h6.4" />
    </svg>
  )
}

/** 翻译：地球 + 经线。 */
export function TranslateIcon({ size = 12 }: { size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <circle cx="8" cy="8" r="5.8" />
      <path d="M2.2 8h11.6" />
      <path d="M8 2.2c1.6 1.5 2.4 3.5 2.4 5.8s-.8 4.3-2.4 5.8c-1.6-1.5-2.4-3.5-2.4-5.8S6.4 3.7 8 2.2Z" />
    </svg>
  )
}
