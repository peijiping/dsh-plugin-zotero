/**
 * 带评论标注的「便签」角标，对齐 Zotero PDF 阅读器的观感。
 *
 * Zotero 在高亮 / 划线**起点**叠一个小便签：色块填充取标注颜色、深色细描边、
 * 左下角折起一块浅色三角。纯展示——`pointer-events` 交给宿主容器关掉，不挂事件。
 *
 * 客户端 bundle 是 CJS，不能 import .svg，所以和项目里其它图标一样手写内联 JSX。
 * 快照 iframe 里的桥接脚本是独立 IIFE，够不到这个组件，那里另有一份同形状的 SVG。
 */

import type { ReactElement } from 'react'

interface Props {
  /** 标注颜色（十六进制），作为便签填充。传空串时调用方应先回退到默认色。 */
  color: string
  /** 边长（px），默认 13，与 12.5px 正文相称。 */
  size?: number
}

const OUTLINE = 'rgba(0,0,0,0.55)'
const FOLD = 'rgba(255,255,255,0.92)'

export function AnnotationCommentIcon({ color, size = 13 }: Props): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path
        d="M2.4 1.9 H13.6 V14.1 H6.3 L2.4 10.2 Z"
        fill={color}
        stroke={OUTLINE}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <path
        d="M2.4 10.2 H6.3 V14.1 Z"
        fill={FOLD}
        stroke={OUTLINE}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  )
}
