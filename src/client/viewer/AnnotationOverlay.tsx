/**
 * 单页标注叠加层。
 *
 * Zotero 的 rect 是 PDF 用户空间（左下原点），`convertToViewportRectangle`
 * 负责处理缩放、旋转与 CropBox；这里只做归一化与按类型绘制。
 * 整层 `pointer-events: none`，点击命中由页面容器按坐标判断，避免抢走文本选区。
 */

import { Fragment, type ReactElement } from 'react'

import type { PageViewport } from 'pdfjs-dist'

import type { ZoteroAnnotation } from '../../zotero/types'
import { hasComment } from '../annotationComment'
import { annotationColor, tint } from '../annotationRuns'
import { AnnotationCommentIcon } from './AnnotationCommentIcon'
import { viewportBox, type ViewportBox } from './geometry'

/** 便签角标边长，与 12.5px 正文相称；压在首段高亮的左上角。 */
const BADGE_SIZE = 13

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
        const boxes = boxesOf(annotation, viewport)
        // 与 Zotero 一致：高亮 / 划线带评论时，在首段矩形左上角叠一个便签角标。
        const badge = hasComment(annotation.comment)
          && (annotation.type === 'highlight' || annotation.type === 'underline')
        return boxes.map((box, index) => {
          const key = `${annotation.key}-${index}`
          let mark: ReactElement
          if (annotation.type === 'underline') {
            mark = (
              <div
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
          } else if (annotation.type === 'highlight') {
            mark = (
              <div
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
          } else if (annotation.type === 'image') {
            mark = (
              <div
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
          } else {
            // note / text：rect 往往只有一个字符宽，画一个小圆点作为可点击标记。
            mark = (
              <div
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
          }
          return (
            <Fragment key={key}>
              {mark}
              {badge && index === 0 && (
                <div
                  className="dsh-zotero-ann-badge"
                  style={{
                    position: 'absolute',
                    left: box.left - 3,
                    top: box.top - 9,
                    pointerEvents: 'none',
                  }}
                >
                  <AnnotationCommentIcon color={color} size={BADGE_SIZE} />
                </div>
              )}
            </Fragment>
          )
        })
      })}
    </div>
  )
}
