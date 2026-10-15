/**
 * 右栏：单条条目详情。
 *
 * 「添加到会话」两处入口：头部按钮（整条目元数据）、全文块里的选区浮出按钮
 * （摘录）。全文块内用鼠标选中文本后浮出小按钮，位置取选区 rect。
 */

import { useRef, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroItemDetail } from '../zotero/types'
import type { Translate } from './locales'

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

const labelStyle = { opacity: 0.6, marginRight: 8, flexShrink: 0 } as const
const metaRowStyle = { display: 'flex', gap: 4, marginBottom: 4, lineHeight: 1.6 } as const

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

export function ItemDetail({ t, detail, onInsertItem, onInsertExcerpt, onOpenItem }: Props): ReactElement {
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

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
    <div style={{ padding: '12px 14px', lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
        <h2 style={{ flex: 1, margin: 0, fontSize: 15, lineHeight: 1.45 }}>{detail.title}</h2>
        <Button variant="outline" size="sm" onClick={onInsertItem}>
          {t('action.insertItem')}
        </Button>
      </div>

      {detail.creators.length > 0 && <MetaRow label={t('detail.creators')}>{detail.creators.join('、')}</MetaRow>}
      {detail.year !== '' && <MetaRow label={t('detail.year')}>{detail.year}</MetaRow>}
      {detail.publicationTitle !== '' && <MetaRow label={t('detail.source')}>{detail.publicationTitle}</MetaRow>}
      {detail.doi !== '' && <MetaRow label={t('detail.doi')}>{detail.doi}</MetaRow>}
      {detail.url !== '' && <MetaRow label={t('detail.url')}>{detail.url}</MetaRow>}
      {detail.tags.length > 0 && <MetaRow label={t('detail.tags')}>{detail.tags.join('、')}</MetaRow>}

      {detail.abstract !== '' && (
        <section style={{ marginTop: 12 }}>
          <h3 style={sectionTitle}>{t('detail.abstract')}</h3>
          <p style={{ margin: 0, opacity: 0.85 }}>{detail.abstract}</p>
        </section>
      )}

      {detail.attachments.length > 0 && (
        <section style={{ marginTop: 14 }}>
          <h3 style={sectionTitle}>{t('detail.attachments')}</h3>
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
        </section>
      )}

      <section style={{ marginTop: 14 }}>
        <h3 style={sectionTitle}>
          {t('detail.fulltext')}
          {detail.fulltext !== null && (
            <span style={{ opacity: 0.55, fontWeight: 400, marginLeft: 8 }}>{detail.fulltext.attachmentKey}</span>
          )}
        </h3>
        {detail.fulltext === null ? (
          <p style={{ margin: 0, opacity: 0.6 }}>{t('detail.noFulltext')}</p>
        ) : (
          <div
            ref={boxRef}
            onMouseUp={handleMouseUp}
            style={{
              position: 'relative',
              maxHeight: 320,
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
            {detail.fulltext.content}
            {detail.fulltext.truncated && (
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

      {detail.bib !== null && (
        <section style={{ marginTop: 14 }}>
          <h3 style={sectionTitle}>{t('detail.bibTitle')}</h3>
          <p style={{ margin: 0, opacity: 0.85, fontSize: 12.5 }}>{stripTags(detail.bib)}</p>
        </section>
      )}
    </div>
  )
}

const sectionTitle = { margin: '0 0 6px', fontSize: 12.5, fontWeight: 600, opacity: 0.75 } as const

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
