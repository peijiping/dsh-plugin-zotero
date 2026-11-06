/**
 * 单页标注叠加层。
 *
 * Zotero 的 rect 是 PDF 用户空间（左下原点），`convertToViewportRectangle`
 * 负责处理缩放、旋转与 CropBox；这里只做归一化与按类型绘制。
 * 整层 `pointer-events: none`，点击命中由页面容器按坐标判断，避免抢走文本选区。
 */

import type { ReactElement } from 'react'

import type { PageViewport } from 'pdfjs-dist'

import type { ZoteroAnnotation } from '../../zotero/types'
import { annotationColor, tint } from '../annotationRuns'
import { viewportBox, type ViewportBox } from './geometry'

interface Props {
  annotations: ZoteroAnnotation[]
  viewport: PageViewport
  flashKey: string | null
}

function boxesOf(annotation: ZoteroAnnotation, viewport: PageViewport): ViewportBox[] {
  return (annotation.position?.rects ?? []).map((rect) => viewportBox(viewport, rect))
}

export function AnnotationOverlay({ annotations, viewport, flashKey }: Props): ReactElement {
  return (
    <div className="dsh-zotero-pdf-overlay">
      {annotations.map((annotation) => {
        const color = annotationColor(annotation)
        const flash = annotation.key === flashKey ? ' dsh-zotero-ann-flash' : ''
        return boxesOf(annotation, viewport).map((box, index) => {
          const key = `${annotation.key}-${index}`
          if (annotation.type === 'underline') {
            return (
              <div
                key={key}
                className={`dsh-zotero-ann${flash}`}
                style={{
                  position: 'absolute',
                  left: box.left,
                  top: box.top + Math.max(box.height - 2, 0),
                  width: box.width,
                  height: 2,
                  background: color,
                  borderRadius: 1,
                }}
              />
            )
          }
          if (annotation.type === 'highlight') {
            return (
              <div
                key={key}
                className={`dsh-zotero-ann${flash}`}
                style={{
                  position: 'absolute',
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  background: tint(color),
                  mixBlendMode: 'multiply',
                  borderRadius: 1,
                }}
              />
            )
          }
          if (annotation.type === 'image') {
            return (
              <div
                key={key}
                className={`dsh-zotero-ann${flash}`}
                style={{
                  position: 'absolute',
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  border: `1px dashed ${color}`,
                  borderRadius: 2,
                }}
              />
            )
          }
          // note / text：rect 往往只有一个字符宽，画一个小圆点作为可点击标记。
          return (
            <div
              key={key}
              className={`dsh-zotero-ann${flash}`}
              style={{
                position: 'absolute',
                left: box.left,
                top: box.top,
                width: Math.max(box.width, 12),
                height: Math.max(box.height, 12),
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
                }}
              />
            </div>
          )
        })
      })}
    </div>
  )
}
