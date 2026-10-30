/**
 * 右栏：单条条目详情。
 *
 * 版面分上下两区：上方「正文区」（标题 / 元数据 / 摘要 / 全文块），下方「分区面板区」
 * （参考文献 / 笔记 / 标注 / 附件，用 tab 切换）。两区之间是可拖动的横向分隔条，默认正文占
 * 85%，占比存 localStorage 跨会话记住；底部没有任何分区时不分区，正文独占整栏。
 *
 * 正文区内部再分两块：头部信息（标题 / 元数据 / 摘要，过高时自己滚动）与全文块
 * （撑满剩余高度、自己滚动），所以拖高正文区时全文文本跟着变高。
 *
 * 元数据与摘要都默认折叠，各自小标题行右侧的箭头按钮展开 / 收起——右栏空间有限，
 * 折叠后把高度尽量让给全文正文。
 *
 * 「添加到会话」两处入口：头部按钮（整条目元数据）、全文块里的选区浮出按钮
 * （摘录）。全文块内用鼠标选中文本后浮出小按钮，位置取选区 rect。
 *
 * 独立笔记（条目自身 `itemType: "note"`）的正文直接作为全文块内容渲染，
 * 与打开普通条目一样占据正文区，不再只能去底部「笔记」tab 里翻。
 */

import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroAnnotation, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { AnnotationList } from './AnnotationList'
import { buildSegments, filterAnnotations, type AnnotationFilter, type Segment } from './annotationRuns'
import { DetailTabs, type DetailTab } from './DetailTabs'
import type { Translate } from './locales'
import { NoteList, NOTE_CSS } from './NoteList'
import { sectionTitleStyle, sectionToggleButtonStyle, sectionToggleRowStyle } from './styles'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  /** 点击头部「添加条目引用」。 */
  onInsertItem(): void
  /** 插入全文选区摘录。 */
  onInsertExcerpt(quote: string): void
  /** 插入一条标注（原文 + 评论 + 页码）。 */
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  /** 插入一条笔记（正文纯文本）。 */
  onInsertNote(note: ZoteroNote): void
  /** 点击附件行：以其 key 作为条目重新打开（附件条目自带全文）。 */
  onOpenItem(key: string): void
}

/** 正文区占比的存储键与取值范围（%）。 */
const BODY_PERCENT_KEY = 'dsh-plugin-zotero.detailBodyPercent'
const BODY_PERCENT_DEFAULT = 85
const BODY_PERCENT_MIN = 30
const BODY_PERCENT_MAX = 95

function readBodyPercent(): number {
  try {
    const value = Number.parseInt(window.localStorage.getItem(BODY_PERCENT_KEY) ?? '', 10)
    return Number.isFinite(value) && value >= BODY_PERCENT_MIN && value <= BODY_PERCENT_MAX
      ? value
      : BODY_PERCENT_DEFAULT
  } catch {
    return BODY_PERCENT_DEFAULT
  }
}

const labelStyle = { opacity: 0.6, marginRight: 8, flexShrink: 0 } as const
const metaRowStyle = { display: 'flex', gap: 4, marginBottom: 2, lineHeight: 1.5 } as const
/** 折叠区块（元数据 / 摘要）的外框：紧凑的上间距，展开内容再留 4px。 */
const collapsibleStyle = { marginTop: 8 } as const
/** 头部「添加条目引用」：压到最小号，把宽度尽量让给标题。 */
const insertButtonStyle = {
  flexShrink: 0,
  height: 20,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
} as const

/** 正文块外框：PDF 全文与独立笔记共用，仅排版细节不同。 */
const bodyBoxStyle = {
  // 全文块内的选区浮出按钮靠绝对定位，需要这里做定位参照。
  position: 'relative',
  flex: 1,
  minHeight: 60,
  overflow: 'auto',
  padding: '8px 10px',
  border: '1px solid rgba(127,127,127,0.25)',
  borderRadius: 6,
  fontSize: 12.5,
  opacity: 0.9,
} as const

/** PDF 全文：纯文本，保留换行。 */
const textBodyStyle = { ...bodyBoxStyle, whiteSpace: 'pre-wrap', lineHeight: 1.7 } as const

/** 独立笔记：HTML 自带块级换行，不能再叠 pre-wrap，否则标签间空白会被放大。 */
const noteBodyStyle = { ...bodyBoxStyle, lineHeight: 1.75, overflowWrap: 'break-word' } as const

const truncatedHintStyle = { marginTop: 6, opacity: 0.6 } as const

/** 去掉 CSL HTML 标签，只留可见文本（zotero 导出的是便携 HTML）。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim()
}

function MetaRow({ label, children }: { label: string; children: ReactElement | string }): ReactElement {
  return (
    <div style={metaRowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={{ wordBreak: 'break-word' }}>{children}</span>
    </div>
  )
}

interface SectionToggleProps {
  label: string
  open: boolean
  onToggle(): void
  expandLabel: string
  collapseLabel: string
}

/** 小标题 + 右侧展开/收起箭头。 */
function SectionToggle({ label, open, onToggle, expandLabel, collapseLabel }: SectionToggleProps): ReactElement {
  return (
    <div style={sectionToggleRowStyle}>
      <h3 style={{ ...sectionTitleStyle, margin: 0 }}>{label}</h3>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? collapseLabel : expandLabel}
        style={sectionToggleButtonStyle}
      >
        {open ? '▴' : '▾'}
      </button>
    </div>
  )
}

/** 定位时给标注元素加的闪烁类与持续时间。 */
const FLASH_CLASS = 'dsh-zotero-ann-flash'
const FLASH_MS = 1200

/**
 * 全文正文：把切好的片段渲染成文本 + 标注元素。
 *
 * 用 memo 包住——鼠标选区（`selection` state）变化会重渲染父组件，
 * 但 200KB 文本不该跟着重排。
 */
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

const ANNOTATION_CSS = `
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

export function ItemDetail({ t, detail, onInsertItem, onInsertExcerpt, onInsertAnnotation, onInsertNote, onOpenItem }: Props): ReactElement {
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const [bodyPercent, setBodyPercent] = useState(readBodyPercent)
  const [splitHover, setSplitHover] = useState(false)
  const [abstractOpen, setAbstractOpen] = useState(false)
  const [metaOpen, setMetaOpen] = useState(false)
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>({ type: 'all', color: null })
  const [filterItemKey, setFilterItemKey] = useState(detail.key)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ y: number; height: number; percent: number } | null>(null)
  const flashTimer = useRef<number | null>(null)

  // 切条目时重置筛选（渲染期调整态，React 认可的 props 派生写法）。
  if (filterItemKey !== detail.key) {
    setFilterItemKey(detail.key)
    setAnnotationFilter({ type: 'all', color: null })
  }

  const bib = detail.bib
  const fulltext = detail.fulltext
  /** 条目本身就是独立笔记时，正文即自身，直接放到全文位置展示。 */
  const selfNote = detail.itemType === 'note'
    ? detail.notes.find((note) => note.key === detail.key) ?? null
    : null
  /** 正文区是否有可展示的内容（PDF 全文或独立笔记正文）。 */
  const hasBody = fulltext !== null || selfNote !== null
  const bodyKey = selfNote !== null ? selfNote.key : fulltext?.attachmentKey ?? ''
  const visibleAnnotations = useMemo(
    () => filterAnnotations(detail.annotations, annotationFilter),
    [detail.annotations, annotationFilter],
  )
  const segments = useMemo(
    () => buildSegments(fulltext?.content ?? '', visibleAnnotations),
    [fulltext, visibleAnnotations],
  )

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
  }, [])

  // 底部 tab 区：有参考文献 / 笔记 / 标注 / 附件时才存在。
  const tabs: DetailTab[] = []
  if (bib !== null) {
    tabs.push({
      id: 'bib',
      label: t('detail.bibTitle'),
      content: (
        <p style={{ margin: 0, opacity: 0.85, fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {stripTags(bib)}
        </p>
      ),
    })
  }
  // 独立笔记的正文已经在正文区展示，底部不再重复列出。
  if (detail.notes.length > 0 && selfNote === null) {
    tabs.push({
      id: 'notes',
      label: t('detail.notes'),
      hint: String(detail.notes.length),
      content: <NoteList t={t} notes={detail.notes} onInsert={onInsertNote} />,
    })
  }
  if (detail.annotations.length > 0) {
    tabs.push({
      id: 'annotations',
      label: t('detail.annotations'),
      hint: String(detail.annotations.length),
      content: (
        <AnnotationList
          t={t}
          annotations={detail.annotations}
          hasFulltext={fulltext !== null}
          truncated={fulltext?.truncated === true}
          filter={annotationFilter}
          onFilterChange={setAnnotationFilter}
          onLocate={locate}
          onInsert={onInsertAnnotation}
        />
      ),
    })
  }
  if (detail.attachments.length > 0) {
    tabs.push({
      id: 'attachments',
      label: t('detail.attachments'),
      hint: String(detail.attachments.length),
      content: (
        <div>
          {detail.attachments.map((attachment) => (
            <button
              key={attachment.key}
              type="button"
              onClick={() => onOpenItem(attachment.key)}
              style={linkRowStyle}
            >
              <span style={{ flex: 1, textAlign: 'left', wordBreak: 'break-word' }}>{attachment.title}</span>
              <span style={{ opacity: 0.55, flexShrink: 0 }}>
                {attachment.contentType}
                {attachment.size > 0 ? ` · ${Math.round(attachment.size / 1024)} KB` : ''}
              </span>
            </button>
          ))}
        </div>
      ),
    })
  }
  const hasBottom = tabs.length > 0

  const metaRows: { label: string; value: string }[] = []
  if (detail.creators.length > 0) metaRows.push({ label: t('detail.creators'), value: detail.creators.join('、') })
  if (detail.year !== '') metaRows.push({ label: t('detail.year'), value: detail.year })
  if (detail.publicationTitle !== '') metaRows.push({ label: t('detail.source'), value: detail.publicationTitle })
  if (detail.doi !== '') metaRows.push({ label: t('detail.doi'), value: detail.doi })
  if (detail.url !== '') metaRows.push({ label: t('detail.url'), value: detail.url })
  if (detail.tags.length > 0) metaRows.push({ label: t('detail.tags'), value: detail.tags.join('、') })

  function clampBodyPercent(next: number): number {
    return Math.min(Math.max(next, BODY_PERCENT_MIN), BODY_PERCENT_MAX)
  }

  function onSplitterDown(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      y: event.clientY,
      height: rootRef.current?.clientHeight ?? 0,
      percent: bodyPercent,
    }
  }

  function onSplitterMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (drag === null || drag.height === 0) return
    setBodyPercent(clampBodyPercent(drag.percent + ((event.clientY - drag.y) / drag.height) * 100))
  }

  function onSplitterUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    try {
      window.localStorage.setItem(BODY_PERCENT_KEY, String(Math.round(bodyPercent)))
    } catch {
      // 隐私模式等禁用 localStorage 时忽略，占比仍在本会话内生效。
    }
  }

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

  /**
   * 滚动到某条标注并闪烁。
   *
   * 不用 `scrollIntoView`：它会连带滚动外层 pane 的滚动容器，整页都会跳。
   * 这里只动全文块自己的 `scrollTop`。
   */
  function locate(annotationKey: string): void {
    const box = boxRef.current
    if (box === null) return
    const target = box.querySelector<HTMLElement>(`[data-ann~="${CSS.escape(annotationKey)}"]`)
    if (target === null) return
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
  }

  return (
    <div
      ref={rootRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <style>{ANNOTATION_CSS + NOTE_CSS}</style>
      <div
        style={{
          flex: hasBottom ? `0 0 ${bodyPercent}%` : '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* 头部信息：内容不足时不抢空间，超高时自己滚动 */}
        <div
          style={{
            flex: hasBody ? '0 1 auto' : '1 1 auto',
            minHeight: 44,
            overflow: 'auto',
            padding: '12px 14px 0',
            lineHeight: 1.6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6 }}>
            <h2 style={{ flex: 1, margin: 0, fontSize: 13.5, fontWeight: 700, lineHeight: 1.4 }}>{detail.title}</h2>
            {/* 独立笔记没有可引的 CSL 元数据，整条笔记的「引用」在正文区标题行 */}
            {selfNote === null && (
              <Button
                variant="outline"
                size="sm"
                onClick={onInsertItem}
                title={t('action.insertItem')}
                style={insertButtonStyle}
              >
                {t('action.insertItemShort')}
              </Button>
            )}
          </div>

          {metaRows.length > 0 && (
            <section style={collapsibleStyle}>
              <SectionToggle
                label={t('detail.metadata')}
                open={metaOpen}
                onToggle={() => setMetaOpen((open) => !open)}
                expandLabel={t('detail.metadataExpand')}
                collapseLabel={t('detail.metadataCollapse')}
              />
              {metaOpen && metaRows.map((row) => <MetaRow key={row.label} label={row.label}>{row.value}</MetaRow>)}
            </section>
          )}

          {detail.abstract !== '' && (
            <section style={{ ...collapsibleStyle, paddingBottom: 12 }}>
              <SectionToggle
                label={t('detail.abstract')}
                open={abstractOpen}
                onToggle={() => setAbstractOpen((open) => !open)}
                expandLabel={t('detail.abstractExpand')}
                collapseLabel={t('detail.abstractCollapse')}
              />
              {abstractOpen && (
                <p style={{ margin: '4px 0 0', opacity: 0.85 }}>{detail.abstract}</p>
              )}
            </section>
          )}
        </div>

        {/* 正文块：撑满正文区剩余高度，文本随之变高；独立笔记的正文也放这里 */}
        <section
          style={{
            flex: hasBody ? '1 1 0' : '0 0 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: '2px 14px 14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <h3 style={{ ...sectionTitleStyle, margin: 0 }}>
              {t(selfNote !== null ? 'detail.noteBody' : 'detail.fulltext')}
              {bodyKey !== '' && (
                <span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 8 }}>{bodyKey}</span>
              )}
            </h3>
            <div style={{ flex: 1 }} />
            {selfNote !== null && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onInsertNote(selfNote)}
                title={t('action.insertToChat')}
                style={insertButtonStyle}
              >
                {t('action.insertItemShort')}
              </Button>
            )}
          </div>
          {!hasBody ? (
            <p style={{ margin: 0, opacity: 0.6 }}>{t('detail.noFulltext')}</p>
          ) : (
            <div
              ref={boxRef}
              onMouseUp={handleMouseUp}
              style={selfNote === null ? textBodyStyle : noteBodyStyle}
            >
              {selfNote !== null ? (
                <>
                  <div className="dsh-zotero-note" dangerouslySetInnerHTML={{ __html: selfNote.html }} />
                  {selfNote.truncated && <div style={truncatedHintStyle}>{t('detail.noteTruncated')}</div>}
                </>
              ) : (
                <>
                  <AnnotatedText segments={segments} />
                  {fulltext?.truncated === true && (
                    <div style={truncatedHintStyle}>{t('detail.fulltextTruncated')}</div>
                  )}
                </>
              )}
              {selection !== null && (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onInsertExcerpt(selection.text)
                    window.getSelection()?.removeAllRanges()
                    setSelection(null)
                  }}
                  style={{
                    position: 'absolute',
                    left: selection.x,
                    top: selection.y,
                    transform: 'translate(-50%, -130%)',
                    padding: '3px 8px',
                    fontSize: 12,
                    borderRadius: 6,
                    border: '1px solid rgba(127,127,127,0.35)',
                    background: 'rgba(40,40,40,0.92)',
                    color: '#fff',
                    cursor: 'pointer',
                    zIndex: 5,
                  }}
                >
                  {t('action.insertExcerpt')}
                </button>
              )}
            </div>
          )}
        </section>
      </div>

      {hasBottom && (
        <div
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onSplitterDown}
          onPointerMove={onSplitterMove}
          onPointerUp={onSplitterUp}
          onPointerCancel={onSplitterUp}
          onPointerEnter={() => setSplitHover(true)}
          onPointerLeave={() => setSplitHover(false)}
          style={{
            flexShrink: 0,
            height: 5,
            display: 'flex',
            alignItems: 'center',
            cursor: 'row-resize',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <span
            style={{
              width: '100%',
              height: 1,
              background:
                splitHover || dragRef.current !== null ? 'rgba(80,140,255,0.75)' : 'rgba(127,127,127,0.2)',
            }}
          />
        </div>
      )}

      {hasBottom && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <DetailTabs tabs={tabs} />
        </div>
      )}
    </div>
  )
}

const linkRowStyle = {
  display: 'flex',
  gap: 8,
  alignItems: 'baseline',
  width: '100%',
  padding: '4px 2px',
  fontSize: 12.5,
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid rgba(127,127,127,0.18)',
  color: 'inherit',
  cursor: 'pointer',
} as const
