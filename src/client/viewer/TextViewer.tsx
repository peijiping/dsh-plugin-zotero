/**
 * 文本渲染器：PDF 全文或独立笔记的纯文本兜底视图。
 *
 * PDF.js 不可用（非 PDF 附件、浏览器拒绝渲染、文件缺失）时由注册表回退到这里。
 * 标注只有 `range`（全文区间）能落到文字上；点标注列表仍会滚动定位并闪烁。
 * 该渲染器没有分页与缩放，工具条据 `capabilities` 自动隐藏对应控件。
 */

import {
  Fragment,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

import type { ZoteroAnnotation } from '../../zotero/types'
import { buildSegments, type Segment } from '../annotationRuns'
import type { Translate } from '../locales'
import { NOTE_CSS } from '../NoteList'
import { SelectionBar } from './SelectionBar'
import type { DocumentRendererProps } from './types'

const FLASH_CLASS = 'dsh-zotero-ann-flash'
const FLASH_MS = 1200
const TEXT_TYPES = new Set(['highlight', 'underline'])

const AnnotatedText = memo(function AnnotatedText({ segments }: { segments: Segment[] }): ReactElement {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>
        const style: CSSProperties = {}
        if (segment.background !== null) style.background = segment.background
        if (segment.underline !== null) {
          style.textDecorationLine = 'underline'
          style.textDecorationColor = segment.underline
          style.textDecorationThickness = 2
          style.textUnderlineOffset = 2
        }
        const owners = segment.owners.join(' ')
        return segment.background !== null ? (
          <mark key={index} className="dsh-zotero-ann" data-ann={owners} style={style}>
            {segment.text}
          </mark>
        ) : (
          <span key={index} className="dsh-zotero-ann" data-ann={owners} style={style}>
            {segment.text}
          </span>
        )
      })}
    </>
  )
})

export function TextViewer({
  t,
  detail,
  annotations,
  viewerRef,
  onReady,
  onInsertExcerpt,
}: DocumentRendererProps): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const flashTimer = useRef<number | null>(null)
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)

  const selfNote = detail.itemType === 'note'
    ? detail.notes.find((note) => note.key === detail.key) ?? null
    : null
  const fulltext = detail.fulltext

  const marked = useMemo(
    () => (selfNote === null ? annotations.filter((annotation) => TEXT_TYPES.has(annotation.type)) : []),
    [annotations, selfNote],
  )
  const segments = useMemo(
    () => buildSegments(fulltext?.content ?? '', marked),
    [fulltext, marked],
  )

  useEffect(() => {
    const timer = window.setTimeout(onReady, 0)
    return () => window.clearTimeout(timer)
  }, [onReady, detail.key, fulltext?.attachmentKey])

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
  }, [])

  function locate(annotationKey: string): boolean {
    const box = boxRef.current
    if (box === null) return false
    const target = box.querySelector<HTMLElement>(`[data-ann~="${CSS.escape(annotationKey)}"]`)
    if (target === null) return false
    const boxRect = box.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    box.scrollTo({
      top: box.scrollTop + rect.top - boxRect.top - box.clientHeight / 2 + rect.height / 2,
      behavior: 'smooth',
    })
    target.classList.remove(FLASH_CLASS)
    void target.offsetWidth
    target.classList.add(FLASH_CLASS)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      target.classList.remove(FLASH_CLASS)
      flashTimer.current = null
    }, FLASH_MS)
    return true
  }

  useImperativeHandle(viewerRef, () => ({
    locate,
    currentPage: () => 1,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    setZoom: () => undefined,
    fitToWidth: () => undefined,
  }))

  function handleMouseUp(): void {
    const sel = window.getSelection()
    const box = boxRef.current
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || box === null) {
      setSelection(null)
      return
    }
    const text = sel.toString().trim()
    const range = sel.getRangeAt(0)
    if (text === '' || !box.contains(range.commonAncestorContainer)) {
      setSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    setSelection({
      text,
      x: rect.left - boxRect.left + box.scrollLeft + rect.width / 2,
      y: rect.top - boxRect.top + box.scrollTop,
    })
  }

  const hasContent = selfNote !== null || fulltext !== null

  return (
    <div ref={boxRef} onMouseUp={handleMouseUp} style={rootStyle}>
      <style>{TEXT_CSS + NOTE_CSS}</style>
      {!hasContent ? (
        <p style={emptyStyle}>{t('detail.noFulltext')}</p>
      ) : selfNote !== null ? (
        <div style={noteStyle}>
          <div className="dsh-zotero-note" dangerouslySetInnerHTML={{ __html: selfNote.html }} />
          {selfNote.truncated && <div style={truncatedStyle}>{t('detail.noteTruncated')}</div>}
        </div>
      ) : (
        <div style={textStyle}>
          {fulltext?.fallback === true && (
            <p style={fallbackStyle}>{t('detail.fulltextFallback')}</p>
          )}
          <AnnotatedText segments={segments} />
          {fulltext?.truncated === true && (
            <div style={truncatedStyle}>{t('detail.fulltextTruncated')}</div>
          )}
        </div>
      )}
      {selection !== null && (
        <SelectionBar
          t={t}
          text={selection.text}
          x={selection.x}
          y={selection.y}
          onInsert={onInsertExcerpt}
          onDismiss={() => setSelection(null)}
        />
      )}
    </div>
  )
}

const rootStyle = {
  position: 'relative',
  height: '100%',
  minHeight: 0,
  overflow: 'auto',
  padding: '10px 14px 14px',
  overscrollBehavior: 'contain',
} as const

const baseTextStyle = {
  fontSize: 12.5,
  lineHeight: 1.7,
  opacity: 0.9,
} as const

const textStyle = { ...baseTextStyle, whiteSpace: 'pre-wrap' } as const

const noteStyle = { ...baseTextStyle, lineHeight: 1.75, overflowWrap: 'break-word' } as const

const emptyStyle = {
  margin: 0,
  padding: '14px 2px',
  fontSize: 12.5,
  opacity: 0.6,
} as const

const truncatedStyle = { marginTop: 6, opacity: 0.6 } as const

const fallbackStyle = { margin: '0 0 6px', opacity: 0.6, fontSize: 12 } as const

const TEXT_CSS = `
.dsh-zotero-ann { color: inherit; padding: 0; border-radius: 2px; }
.dsh-zotero-ann-flash {
  outline: 2px solid transparent;
  outline-offset: 1px;
  animation: dsh-zotero-ann-flash 1.1s ease-in-out 1;
}
@keyframes dsh-zotero-ann-flash {
  0%, 100% { outline-color: transparent; }
  20%, 80% { outline-color: rgba(80,140,255,0.95); }
}
`
