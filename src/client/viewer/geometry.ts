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

/**
 * 视图坐标 → PDF 用户空间。
 *
 * {@link viewportBox} 的反向，换点方式与 Zotero 阅读器里的 `v2p()` 逐行同构（对角点
 * 分别 `convertToPdfPoint`，再取包围盒）：照抄它，插件建的标注才和 Zotero 自建的那
 * 条落在同一个矩形里。入参的 left/top 必须相对**页面元素**左上角，不是视口。
 */
export function pdfBox(
  viewport: PageViewport,
  box: ViewportBox,
): [number, number, number, number] {
  const first = viewport.convertToPdfPoint(box.left, box.top) as [number, number]
  const second = viewport.convertToPdfPoint(box.left + box.width, box.top + box.height) as [number, number]
  return [
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[0], second[0]),
    Math.max(first[1], second[1]),
  ]
}

/** Zotero 存位置时的精度（`roundPositionValues`：乘 1e3 四舍五入）。 */
export function roundPosition(value: number): number {
  return Math.round(value * 1e3) / 1e3
}
