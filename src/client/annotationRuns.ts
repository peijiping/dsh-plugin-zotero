/**
 * 把「全文纯文本 + 标注区间」切成互不重叠的渲染片段。
 *
 * 高亮与划线可以压在同一段文字上，所以不能一条标注一个元素；这里按所有
 * 区间端点切片，每段合并覆盖它的样式（底色 / 下划线可同时存在）。
 */

import type { ZoteroAnnotation } from '../zotero/types'

/** 无有效颜色时的黄底回退（带透明度，适配深浅主题）。 */
const FALLBACK_TINT = 'rgba(255,212,0,0.32)'

/** 标注没填颜色时的展示色（色块 / 下划线）。 */
export const DEFAULT_ANNOTATION_COLOR = '#aaaaaa'

export type AnnotationTypeFilter = 'all' | 'highlight' | 'underline'

export interface AnnotationFilter {
  type: AnnotationTypeFilter
  /** 小写十六进制；null = 全部颜色。 */
  color: string | null
}

export function annotationColor(annotation: ZoteroAnnotation): string {
  return annotation.color.trim().toLowerCase() || DEFAULT_ANNOTATION_COLOR
}

/**
 * 应用类型 + 颜色筛选（AND）。
 *
 * 颜色在当前类型下已不存在时视为「全部色」——切类型后不该留下筛选不到任何东西的残留状态。
 */
export function filterAnnotations(
  annotations: ZoteroAnnotation[],
  filter: AnnotationFilter,
): ZoteroAnnotation[] {
  const typed = annotations.filter((annotation) => filter.type === 'all' || annotation.type === filter.type)
  if (filter.color === null) return typed
  if (!typed.some((annotation) => annotationColor(annotation) === filter.color)) return typed
  return typed.filter((annotation) => annotationColor(annotation) === filter.color)
}

export interface Segment {
  kind: 'text' | 'marked'
  text: string
  /** 覆盖该段的全部标注 key，用于定位（`[data-ann~="key"]`）。 */
  owners: string[]
  /** 高亮底色（已带透明度）；无高亮覆盖时为 null。 */
  background: string | null
  /** 划线颜色；无划线覆盖时为 null。 */
  underline: string | null
}

/** Zotero 的颜色是三字节十六进制；补一个 alpha 通道做半透明底色。 */
export function tint(color: string): string {
  const hex = color.trim()
  return /^#[0-9a-f]{6}$/iu.test(hex) ? `${hex}55` : FALLBACK_TINT
}

interface Span {
  key: string
  type: string
  color: string
  start: number
  end: number
}

function spansOf(annotations: ZoteroAnnotation[]): Span[] {
  const spans: Span[] = []
  for (const annotation of annotations) {
    const range = annotation.range
    if (range === null || range.end <= range.start) continue
    spans.push({
      key: annotation.key,
      type: annotation.type,
      color: annotation.color,
      start: range.start,
      end: range.end,
    })
  }
  return spans
}

/** 切出渲染片段；相邻的同样式片段会合并，减少 DOM 节点。 */
export function buildSegments(content: string, annotations: ZoteroAnnotation[]): Segment[] {
  if (content === '') return []
  const spans = spansOf(annotations)
  if (spans.length === 0) {
    return [{ kind: 'text', text: content, owners: [], background: null, underline: null }]
  }

  const bounds = new Set<number>([0, content.length])
  for (const span of spans) {
    bounds.add(Math.max(0, span.start))
    bounds.add(Math.min(content.length, span.end))
  }
  const points = [...bounds].sort((a, b) => a - b)

  const segments: Segment[] = []
  const push = (segment: Segment): void => {
    const last = segments[segments.length - 1]
    if (
      last !== undefined
      && last.kind === segment.kind
      && last.background === segment.background
      && last.underline === segment.underline
    ) {
      last.text += segment.text
      for (const owner of segment.owners) if (!last.owners.includes(owner)) last.owners.push(owner)
      return
    }
    segments.push(segment)
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index] as number
    const end = points[index + 1] as number
    const text = content.slice(start, end)
    if (text === '') continue

    let background: string | null = null
    let underline: string | null = null
    const owners: string[] = []
    for (const span of spans) {
      if (span.start > start || span.end < end) continue
      owners.push(span.key)
      if (span.type === 'underline') {
        if (underline === null) underline = span.color.trim() === '' ? DEFAULT_ANNOTATION_COLOR : span.color.trim()
      } else if (background === null) {
        background = tint(span.color)
      }
    }

    if (background === null && underline === null) {
      push({ kind: 'text', text, owners: [], background: null, underline: null })
    } else {
      push({ kind: 'marked', text, owners, background, underline })
    }
  }

  return segments
}
