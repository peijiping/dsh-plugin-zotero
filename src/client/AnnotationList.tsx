/**
 * 条目详情里的标注列表（高亮 / 划线 / 笔记 / 文本 / 截图 / 墨迹）。
 *
 * 标注是 PDF 附件的子条目（`itemType: "annotation"`）。是否可定位看两处：
 * PDF 叠加视图用 `position`，文本兜底用 Host 在全文上算好的 `range`；
 * 两者都没有时行会置灰，但仍可加入会话。
 *
 * 顶部两行筛选：类型与颜色，两者 AND 组合。类型按当前条目的实际种类生成，
 * 不会出现空分类。
 */

import { Fragment, type ReactElement, type ReactNode } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroAnnotation } from '../zotero/types'
import { hasComment, parseComment } from './annotationComment'
import { annotationColor, filterAnnotations, type AnnotationFilter } from './annotationRuns'
import { tpl, type Translate } from './locales'

interface Props {
  t: Translate
  annotations: ZoteroAnnotation[]
  /** 是否有全文（决定未锚定时的提示文案）。 */
  hasFulltext: boolean
  /** 全文是否被截断。 */
  truncated: boolean
  /** 类型 + 颜色筛选；由详情持有，正文内联跟着一起过滤。 */
  filter: AnnotationFilter
  onFilterChange(filter: AnnotationFilter): void
  onLocate(annotation: ZoteroAnnotation): void
  onInsert(annotation: ZoteroAnnotation): void
}

/** 类型 chip 的固定顺序；未出现的类型不渲染。 */
const TYPE_ORDER = ['highlight', 'underline', 'note', 'text', 'image', 'ink'] as const

interface ColorChip {
  hex: string
  count: number
}

function typeLabel(t: Translate, type: string): string {
  const key = `annotation.type.${type}`
  const label = t(key)
  return label === key ? type : label
}

/** 行首标记：高亮实心、划线横线、截图虚线框，其余为小圆点。 */
function Swatch({ color, type }: { color: string; type: string }): ReactElement {
  if (type === 'underline') {
    return (
      <span style={{ width: 10, height: 10, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ width: 10, height: 2, borderRadius: 1, background: color }} />
      </span>
    )
  }
  if (type === 'image') {
    return (
      <span
        style={{
          width: 10,
          height: 10,
          flexShrink: 0,
          borderRadius: 2,
          border: `1px dashed ${color}`,
        }}
      />
    )
  }
  if (type !== 'highlight') {
    return (
      <span style={{ width: 10, height: 10, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      </span>
    )
  }
  return (
    <span
      style={{
        width: 10,
        height: 10,
        flexShrink: 0,
        borderRadius: 2,
        background: color,
        boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.3)',
      }}
    />
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        padding: '0 6px',
        fontSize: 11,
        lineHeight: 1.2,
        borderRadius: 10,
        color: 'inherit',
        background: active ? 'rgba(80,140,255,0.18)' : 'transparent',
        border: `1px solid ${active ? 'rgba(80,140,255,0.65)' : 'rgba(127,127,127,0.3)'}`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

/** 评论正文：按白名单渲染加粗 / 斜体 / 上下标与换行，不注入 HTML。 */
function CommentBody({ comment }: { comment: string }): ReactElement {
  return (
    <div style={commentStyle}>
      {parseComment(comment).map((token, index) => {
        if (token.kind === 'break') return <br key={index} />
        let node: ReactNode = token.text
        if (token.sup) node = <sup>{node}</sup>
        if (token.sub) node = <sub>{node}</sub>
        if (token.italic) node = <i>{node}</i>
        if (token.bold) node = <b>{node}</b>
        return <Fragment key={index}>{node}</Fragment>
      })}
    </div>
  )
}

export function AnnotationList({
  t,
  annotations,
  hasFulltext,
  truncated,
  filter,
  onFilterChange,
  onLocate,
  onInsert,
}: Props): ReactElement | null {
  if (annotations.length === 0) return null

  const counts = new Map<string, number>()
  for (const annotation of annotations) {
    counts.set(annotation.type, (counts.get(annotation.type) ?? 0) + 1)
  }
  const types: string[] = TYPE_ORDER.filter((type) => (counts.get(type) ?? 0) > 0)
  for (const type of counts.keys()) if (!types.includes(type)) types.push(type)

  const byType = annotations.filter((annotation) => filter.type === 'all' || annotation.type === filter.type)
  const colors: ColorChip[] = []
  for (const annotation of byType) {
    const hex = annotationColor(annotation)
    const existing = colors.find((chip) => chip.hex === hex)
    if (existing === undefined) colors.push({ hex, count: 1 })
    else existing.count += 1
  }
  // 切换类型后原来的颜色可能不存在了，直接视为「全部色」。
  const activeColor = filter.color !== null && colors.some((chip) => chip.hex === filter.color) ? filter.color : null
  const visible = filterAnnotations(annotations, { type: filter.type, color: activeColor })
  const anchored = annotations.filter(
    (annotation) => annotation.position !== null || annotation.range !== null,
  ).length

  function unanchoredTitle(): string {
    if (!hasFulltext) return t('detail.annotationNotAnchoredNoFulltext')
    if (truncated) return t('detail.annotationNotAnchoredTruncated')
    return t('detail.annotationNotAnchored')
  }

  return (
    <div>
      <div style={countStyle}>{tpl(t('detail.annotationCount'), { n: annotations.length, m: anchored })}</div>

      <div style={filterRowStyle} aria-label={t('detail.annotationFilterType')}>
        <Chip active={filter.type === 'all'} onClick={() => onFilterChange({ type: 'all', color: filter.color })}>
          {t('detail.annotationAll')}
          <span style={{ opacity: 0.6 }}>{annotations.length}</span>
        </Chip>
        {types.map((type) => (
          <Chip
            key={type}
            active={filter.type === type}
            onClick={() => onFilterChange({ type, color: filter.color })}
          >
            {typeLabel(t, type)}
            <span style={{ opacity: 0.6 }}>{counts.get(type) ?? 0}</span>
          </Chip>
        ))}
      </div>

      {colors.length > 1 && (
        <div style={filterRowStyle} aria-label={t('detail.annotationFilterColor')}>
          <Chip active={activeColor === null} onClick={() => onFilterChange({ type: filter.type, color: null })}>
            {t('detail.annotationAllColors')}
          </Chip>
          {colors.map((chip) => (
            <Chip
              key={chip.hex}
              active={activeColor === chip.hex}
              onClick={() => onFilterChange({ type: filter.type, color: chip.hex })}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2, background: chip.hex, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.35)' }} />
              <span style={{ opacity: 0.6 }}>{chip.count}</span>
            </Chip>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.6 }}>{t('detail.annotationEmpty')}</p>
      ) : (
        visible.map((annotation) => {
          const key = annotation.key
          const located = annotation.position !== null || annotation.range !== null
          const text = annotation.text.trim()
          const canInsert = text !== '' || hasComment(annotation.comment)
          return (
            <div key={key} style={{ padding: '8px 2px', borderBottom: '1px solid rgba(127,127,127,0.18)', opacity: located ? 1 : 0.55 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Swatch color={annotationColor(annotation)} type={annotation.type} />
                <span style={{ fontSize: 11, opacity: 0.65 }}>{typeLabel(t, annotation.type)}</span>
                {annotation.pageLabel !== '' && (
                  <span style={{ fontSize: 11, opacity: 0.65 }}>
                    {tpl(t('detail.annotationPage'), { n: annotation.pageLabel })}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                {located && text === '' && (
                  <button
                    type="button"
                    onClick={() => onLocate(annotation)}
                    style={locateButtonStyle}
                  >
                    {t('detail.annotationLocate')}
                  </button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canInsert}
                  onClick={() => onInsert(annotation)}
                  title={t('action.insertToChat')}
                  style={insertButtonStyle}
                >
                  {t('action.insertItemShort')}
                </Button>
              </div>

              {text !== '' && (
                <button
                  type="button"
                  disabled={!located}
                  onClick={() => onLocate(annotation)}
                  title={located ? undefined : unanchoredTitle()}
                  style={{ ...textButtonStyle, cursor: located ? 'pointer' : 'default' }}
                >
                  {text}
                </button>
              )}

              {hasComment(annotation.comment) && <CommentBody comment={annotation.comment} />}
            </div>
          )
        })
      )}
    </div>
  )
}

const countStyle = { fontSize: 11.5, opacity: 0.6, marginBottom: 6 } as const

const filterRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 5,
  marginBottom: 6,
} as const

const insertButtonStyle = {
  flexShrink: 0,
  height: 20,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
} as const

const locateButtonStyle = {
  flexShrink: 0,
  height: 20,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: 1.2,
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

const textButtonStyle = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  width: '100%',
  margin: 0,
  padding: 0,
  fontSize: 12.5,
  lineHeight: 1.65,
  textAlign: 'left',
  wordBreak: 'break-word',
  color: 'inherit',
  background: 'transparent',
  border: 'none',
} as const

const commentStyle = {
  marginTop: 5,
  paddingLeft: 8,
  borderLeft: '2px solid rgba(127,127,127,0.28)',
  fontSize: 11.5,
  lineHeight: 1.6,
  opacity: 0.8,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const
