/**
 * 右侧栏「开始」页 guide 卡片专用的插件图标。
 *
 * 宿主 `ui-sidebar-right` 的 EntryBox 用 `entry.icon ?? CubeGlyph` 渲染卡片图标，
 * 没传 icon 的插件一律显示灰色立方体占位；它**不读** `package.json` 的 `icon`。
 * 而 guide[].icon 要的是能接 `{size, className}` 的 React 组件，不是图片 URL，
 * 客户端 bundle 又不能 import `.svg` 文件，所以这里用内联 SVG 重写一份。
 *
 * 根 `icon.svg` 是 64×64 的完整版；guide 卡片只有 22 / 26px，等比缩会把
 * 2px 的文字线压成半像素条纹、Z 也糊成红点。这里用 32×32 紧凑版重排：
 * 保留「亮蓝圆角底 + 白色文档页 + 蓝标题条 + 三条灰蓝文字行 + 居中红 Z」
 * 的全部识别元素，只把笔画加粗、间距压紧，26px 下仍能读成一页文档。
 */

import { useId, type ReactElement } from 'react'

/** Zotero Z 的原始轮廓（0 基、18 × 17.5），与根 `icon.svg` 同一条 path。 */
const Z_PATH = 'M0.5 0H17L18 4.5L5.5 13H18V17.5H1L0 13L12.5 4.5H0.5Z'

/** 宿主在有 description 时传 26，否则 22。 */
export function GuideIcon({
  size = 26,
  className,
}: {
  size?: number
  className?: string
}): ReactElement {
  // 同一页面上可能挂多个实例，渐变 id 必须唯一；useId 带冒号，url(#...) 里去掉。
  const uid = useId().replace(/:/g, '')

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#359ff2" />
          <stop offset="1" stopColor="#279af2" />
        </linearGradient>
        <linearGradient id={`${uid}-z`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#ff5a4b" />
          <stop offset="1" stopColor="#df2030" />
        </linearGradient>
      </defs>

      {/* 亮蓝圆角底：色值取自用户给的色样（主色 #2e9df2，上亮下深）。
          根 icon.svg 用同一组色值，两处图标保持一致；自带底色，深浅主题都清晰。 */}
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${uid}-bg)`} />

      {/* 后层那张纸：小尺寸下只留露在白页右侧的一段白描边。 */}
      <path
        d="M20 6h5a2 2 0 0 1 2 2v15"
        fill="none"
        stroke="#ffffff"
        strokeOpacity=".6"
        strokeWidth="1.8"
        strokeLinecap="round"
      />

      {/* 白页用纯白：26px 下比渐变更干净，和亮蓝底的对比也更足。 */}
      <rect x="8" y="4.5" width="16" height="24" rx="2.4" fill="#ffffff" />
      <rect x="10.5" y="7.5" width="8.5" height="2" rx="1" fill="#4a86e8" />

      {/* 文字行：Z 上方一条、下方两条，页面才不会读成空卡片。 */}
      <g fill="#9db2ce">
        <rect x="10.5" y="11.6" width="10" height="1.5" rx="0.75" />
        <rect x="10.5" y="23.2" width="9" height="1.5" rx="0.75" />
        <rect x="10.5" y="25.9" width="6" height="1.5" rx="0.75" />
      </g>

      {/* 缩小的 Zotero Z，居中夹在文字行之间；斜切与红渐变沿用根图标。 */}
      <g transform="translate(12.3 14) scale(0.45) skewX(-5)">
        <path d={Z_PATH} fill={`url(#${uid}-z)`} />
      </g>
    </svg>
  )
}
