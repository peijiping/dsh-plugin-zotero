/**
 * 右栏：单条条目详情。
 *
 * 版面分上下两区：上方「正文区」（标题 / 元数据 / 摘要 / 全文块），下方「分区面板区」
 * （参考文献 / 笔记 / 附件，用 tab 切换）。两区之间是可拖动的横向分隔条，默认正文占
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
 */

import { useRef, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroItemDetail } from '../zotero/types'
import { DetailTabs, type DetailTab } from './DetailTabs'
import type { Translate } from './locales'
import { NoteList } from './NoteList'
import { sectionTitleStyle, sectionToggleButtonStyle, sectionToggleRowStyle } from './styles'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  /** 点击头部「添加条目引用」。 */
  onInsertItem(): void
  /** 插入全文选区摘录。 */
  onInsertExcerpt(quote: string): void
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

export function ItemDetail({ t, detail, onInsertItem, onInsertExcerpt, onOpenItem }: Props): ReactElement {
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const [bodyPercent, setBodyPercent] = useState(readBodyPercent)
  const [splitHover, setSplitHover] = useState(false)
  const [abstractOpen, setAbstractOpen] = useState(false)
  const [metaOpen, setMetaOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ y: number; height: number; percent: number } | null>(null)

  const bib = detail.bib
  const fulltext = detail.fulltext

  // 底部 tab 区：有参考文献 / 笔记 / 附件时才存在。
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
  if (detail.notes.length > 0) {
    tabs.push({
      id: 'notes',
      label: t('detail.notes'),
      hint: String(detail.notes.length),
      content: <NoteList t={t} notes={detail.notes} />,
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

  return (
    <div
      ref={rootRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
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
            flex: fulltext !== null ? '0 1 auto' : '1 1 auto',
            minHeight: 44,
            overflow: 'auto',
            padding: '12px 14px 0',
            lineHeight: 1.6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6 }}>
            <h2 style={{ flex: 1, margin: 0, fontSize: 13.5, fontWeight: 700, lineHeight: 1.4 }}>{detail.title}</h2>
            <Button
              variant="outline"
              size="sm"
              onClick={onInsertItem}
              title={t('action.insertItem')}
              style={insertButtonStyle}
            >
              {t('action.insertItemShort')}
            </Button>
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

        {/* 全文块：撑满正文区剩余高度，文本随之变高 */}
        <section
          style={{
            flex: fulltext !== null ? '1 1 0' : '0 0 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: '2px 14px 14px',
          }}
        >
          <h3 style={sectionTitleStyle}>
            {t('detail.fulltext')}
            {fulltext !== null && (
              <span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 8 }}>{fulltext.attachmentKey}</span>
            )}
          </h3>
          {fulltext === null ? (
            <p style={{ margin: 0, opacity: 0.6 }}>{t('detail.noFulltext')}</p>
          ) : (
            <div
              ref={boxRef}
              onMouseUp={handleMouseUp}
              style={{
                position: 'relative',
                flex: 1,
                minHeight: 60,
                overflow: 'auto',
                padding: '8px 10px',
                border: '1px solid rgba(127,127,127,0.25)',
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                fontSize: 12.5,
                lineHeight: 1.7,
                opacity: 0.9,
              }}
            >
              {fulltext.content}
              {fulltext.truncated && (
                <div style={{ marginTop: 6, opacity: 0.6 }}>{t('detail.fulltextTruncated')}</div>
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
