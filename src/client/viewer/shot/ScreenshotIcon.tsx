/**
 * 截图按钮图标：虚线取景框 + 四角把手。
 *
 * 与项目其余图标一致：纯 JSX 内联 SVG、`currentColor` 描边、16 viewBox。
 * client bundle 不能 import `.svg`，图标一律这样手写。
 */

import type { ReactElement } from 'react'

export function ScreenshotIcon({ size = 12 }: { size?: number }): ReactElement {
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
    >
      <rect x="2.2" y="3.6" width="11.6" height="9.2" rx="1.2" strokeDasharray="2.4 1.8" />
      <path d="M5.4 3.6V2.3M10.6 3.6V2.3M5.4 13.7v1.1M10.6 13.7v1.1" />
      <circle cx="8" cy="8.2" r="1.9" strokeWidth="1.1" />
    </svg>
  )
}
