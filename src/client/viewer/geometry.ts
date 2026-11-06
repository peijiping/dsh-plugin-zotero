/**
 * PDF 用户空间 → 视图坐标。
 *
 * PDF.js 6 的 `PageViewport` 只保留 `convertToViewportPoint`（旧版的
 * `convertToViewportRectangle` 已移除）。矩形两条对角点换算后取包围盒；
 * 90° 的整数倍旋转下，轴对齐矩形仍是轴对齐矩形，因此这个包围盒是精确的。
 */

import type { PageViewport } from 'pdfjs-dist'

export interface ViewportBox {
  left: number
  top: number
  width: number
  height: number
}

export function viewportBox(
  viewport: PageViewport,
  rect: readonly [number, number, number, number],
): ViewportBox {
  const first = viewport.convertToViewportPoint(rect[0], rect[1]) as [number, number]
  const second = viewport.convertToViewportPoint(rect[2], rect[3]) as [number, number]
  const left = Math.min(first[0], second[0])
  const top = Math.min(first[1], second[1])
  return {
    left,
    top,
    width: Math.abs(second[0] - first[0]),
    height: Math.abs(second[1] - first[1]),
  }
}
