/**
 * 「设置」对话框左侧导航项专用的 Z 字图标。
 *
 * 这是**第三套**图标机制，和另外两套互不相通：
 *   - `package.json.icon`（根 icon.svg）由 dsh-app-boot 读成 data URL，只服务
 *     插件市场卡片 / 插件列表 / 设置页详情；
 *   - `guide[].icon` 是右侧栏「开始」页卡片的 React 组件（GuideIcon.tsx）；
 *   - 这里的 `settings.section.icon` 由 ui-settings-general 的外壳按 section id
 *     渲染（`renderSlot(..., {size:16, active}, {only: row.id, fallback: 齿轮})`），
 *     注册 id 必须等于 `settings.section` 的 id，否则不渲染。它同样只收 React
 *     组件，客户端 bundle 是 CJS，不能 import `.svg`。
 *
 * 造型按外壳原生图标（IconSettingsOutlineMedium 等）的规矩来：16×16 viewBox、
 * 单色 `currentColor` 描边、圆角线帽、无填充。选中态的颜色由外壳的 navCell
 * 决定，用 currentColor 自动跟随，不需要为 active 另画一份。
 *
 * 故意不用根 icon.svg 那枚彩色圆角徽章：16px 导航格里它会变成一块蓝方块，
 * 红 Z 缩成一个点，而且和并排的单色线性图标不同调。也别把 Zotero Z 的实心
 * 轮廓直接缩到 16px —— 空心双线会糊成一团，实心又比邻居重一档。这里只保留
 * Z 这个识别符号，用一条略粗的折线写成，和「模型 / 通用设置」的笔画重量相称。
 */

import type { ReactElement } from 'react'

/** 外壳传给图标席位的属性（contract/slots.ts 的 SettingsSectionIconOwnerProps）。 */
export interface SettingsNavIconProps {
  /** 正方形边长，设置导航固定传 16。 */
  size?: number
  /** 该分区当前是否选中；颜色由 currentColor 跟随外壳，图形不随状态变化。 */
  active?: boolean
}

export function SettingsNavIcon({ size = 16 }: SettingsNavIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* 上横 → 斜线 → 下横，一笔连成的斜体 Z；端点留出 3.7px 边距，与邻居对齐。 */}
      <path d="M3.7 3.4h8.6L3.7 12.6h8.6" />
    </svg>
  )
}
