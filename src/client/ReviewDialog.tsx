import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroFulltext, ZoteroItemDetail, ZoteroItemSummary } from '../zotero/types'
import { ApiFailure, fetchFulltext, fetchItem } from './api'
import { ChatIcon } from './actionIcons'
import { reviewEvidenceSource, reviewSourceText, reviewText, type ReviewSource } from './cite'
import { createReviewRun, displayReviewEvidence } from './reviewEvidence'
import { planChapters, type ChapterPlan } from './fulltextPlan'
import { sliceFulltext } from './fulltextRange'
import { readAttachmentOutline } from './viewer/attachmentOutline'
import type { DocumentOutlineItem } from './viewer/types'
import { tpl, type Translate } from './locales'
import { wrapCitation } from './reference'
import { estimateTokens } from './tokens'
import { Button } from './ui'

const INITIAL_CHARS = 6000

interface ReviewRow {
  item: ZoteroItemSummary
  detail?: ZoteroItemDetail
  attachmentKey: string
  fulltext?: ZoteroFulltext | null
  error?: 'load' | 'host'
  mode: 'metadata' | 'range' | 'all' | 'chapter'
  outline?: DocumentOutlineItem[]
  outlineError?: boolean
  chapters: ReadonlySet<number>
  start: string
  end: string
}

interface Props {
  t: Translate
  items: readonly ZoteroItemSummary[]
  onClose(): void
  onConfirm(sources: readonly ReviewSource[], run: string): void
}

function createRow(item: ZoteroItemSummary): ReviewRow {
  return { item, attachmentKey: '', mode: 'all', chapters: new Set(), start: '0', end: String(INITIAL_CHARS) }
}

interface ReviewSelection {
  range: string
  scope: string
  text: string
}

function getSelection(row: ReviewRow, t: Translate, plan: ChapterPlan | null): ReviewSelection | null {
  const index = row.fulltext
  if (index?.revision === undefined || row.mode === 'metadata') return null
  if (row.mode === 'chapter') {
    if (plan === null || plan.fallbackAll) return null
    const slice = sliceFulltext(index.content, plan.range)
    if (slice.text === '') return null
    return { range: plan.range, scope: plan.scope, text: slice.text }
  }
  if (row.mode === 'all') return { range: 'all', scope: t('fulltext.scope.all'), text: index.content }
  if (row.start.trim() === '' || row.end.trim() === '') return null
  const start = Number(row.start)
  const end = Number(row.end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > index.content.length) {
    return null
  }
  return {
    range: `c:${start}:${end}`,
    scope: tpl(t('fulltext.scope.chars'), { value: `${start}–${end}` }),
    text: index.content.slice(start, end),
  }
}

export function ReviewDialog({ t, items, onClose, onConfirm }: Props): ReactElement {
  const [run] = useState(createReviewRun)
  const [reload, setReload] = useState(0)
  const [rows, setRows] = useState(() => items.map(createRow))

  useEffect(() => {
    const controller = new AbortController()
    const requested = items.filter((item) => !rows.find((row) => row.item.key === item.key)?.detail)
    async function load(): Promise<void> {
      for (let start = 0; start < requested.length && !controller.signal.aborted; start += 4) {
        await Promise.all(requested.slice(start, start + 4).map(async (item) => {
          try {
            const detail = await fetchItem(item.key, 'apa', controller.signal)
            if (controller.signal.aborted) return
            const fulltext = detail.fulltext?.revision === undefined && detail.fulltext !== null
              ? undefined : detail.fulltext
            const attachmentKey = fulltext?.attachmentKey ?? detail.attachments[0]?.key ?? ''
            setRows((current) => current.map((row) => row.item.key === item.key ? {
              ...row,
              detail,
              error: undefined,
              attachmentKey,
              fulltext,
              end: String(Math.min(INITIAL_CHARS, fulltext?.content.length ?? INITIAL_CHARS)),
            } : row))
          } catch {
            if (controller.signal.aborted) return
            setRows((current) => current.map((row) => row.item.key === item.key ? { ...row, error: 'load' } : row))
          }
        }))
      }
    }
    void load()
    return () => controller.abort()
  }, [items, reload])

  function update(key: string, changes: Partial<ReviewRow>): void {
    setRows((current) => current.map((row) => row.item.key === key ? { ...row, ...changes } : row))
  }

  const prepared = rows.map((row) => {
    const plan = row.mode === 'chapter' && row.outline !== undefined && row.fulltext
      ? planChapters(row.fulltext.content, row.outline, row.chapters, t) : null
    const selected = getSelection(row, t, plan)
    const pending = !row.error && (row.detail === undefined || row.fulltext === undefined
      || (row.mode === 'chapter' && row.fulltext !== null && row.outline === undefined && !row.outlineError))
    const coverage: ReviewSource['coverage'] = row.mode === 'metadata' ? 'metadata'
      : row.error ? 'error'
      : selected !== null ? 'text' : 'missing'
    const missingIndex = row.attachmentKey !== '' && row.fulltext === null
    let status = t(`review.coverage.${coverage}`)
    if (coverage === 'text' && row.fulltext?.truncated) status += ` · ${t('review.indexTruncated')}`
    if (row.mode === 'metadata') {
      if (missingIndex) status += ` · ${t('review.indexMissing')}`
    } else {
      if (row.error === 'host') status = t('review.hostOutdated')
      else if (pending) status = t('status.loading')
      else if (row.attachmentKey === '' && row.fulltext === null) status = t('review.noAttachment')
      else if (row.fulltext?.revision !== undefined) {
        if (row.mode === 'chapter') {
          if (row.outlineError) status = t('review.chaptersError')
          else if (row.outline?.length === 0) status = t('review.chaptersEmpty')
          else if (plan?.fallbackAll) status = t('review.chaptersUnlocated')
          else if (selected === null) status = t('review.chaptersChoose')
        } else if (selected === null) {
          status = tpl(t('review.invalidRange'), { count: row.fulltext.content.length })
        }
      }
    }
    return { row, selected, status, pending, coverage, missingIndex, tokens: estimateTokens(selected?.text ?? '') }
  })

  const canConfirm = prepared.every(({ row, selected }) => row.mode === 'metadata' || selected !== null)
  const sources = prepared.map(({ row, selected, coverage, missingIndex }) => {
    const { key, title, creators, year } = row.item
    const attachment = row.detail?.attachments.find((candidate) => candidate.key === row.attachmentKey)
    const attachmentTitle = attachment?.title || attachment?.filename
    const fulltext = row.fulltext
    const text = selected !== null && fulltext?.revision !== undefined ? {
      key,
      title,
      attachmentKey: row.attachmentKey,
      attachmentTitle: attachmentTitle || row.attachmentKey,
      revision: fulltext.revision,
      range: `${selected.range}|${encodeURIComponent(selected.scope)}`,
    } : undefined
    return { key, title, creators, year, attachmentTitle, text, coverage, missingIndex: missingIndex || undefined }
  })
  const sections = sources.map((source, index) => {
    const fulltext = rows[index].fulltext
    return source.text && fulltext
      ? reviewEvidenceSource(t, source, fulltext, run, index + 1).section
      : reviewSourceText(t, source)
  })
  const total = estimateTokens(wrapCitation(reviewText(t, sections)))
  const bodyTokens = prepared.reduce((sum, row) => sum + row.tokens, 0)
  const loading = prepared.some(({ row, pending }) => row.mode !== 'metadata' && pending)
  const totalLabel = loading ? t('review.estimating')
    : canConfirm ? tpl(t('review.total'), { n: total.toLocaleString() })
    : t('review.unavailable')

  function confirm(): void {
    if (canConfirm) onConfirm(sources, run)
  }

  return (
    <Modal
      open
      title={t('review.title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      className="dsh-zp-review-modal"
      footer={(
        <div className="dsh-zp-review-footer">
          <small role="status" style={{ flex: 1, minWidth: 0 }}>
            {totalLabel}
            {canConfirm && <span style={{ display: 'block' }}>
              {tpl(t('review.bodyTokens'), { n: bodyTokens.toLocaleString() })}
            </span>}
          </small>
          <Button type="button" variant="primary" size="sm" disabled={!canConfirm} onClick={confirm} style={{ flexShrink: 0, whiteSpace: 'nowrap' }} icon={<ChatIcon size={13} />}>
            {t('fulltext.confirm')}
          </Button>
        </div>
      )}
    >
      <p style={{ marginTop: 0 }}>{t('review.hint')}</p>
      <ol style={{ margin: 0, padding: '0 4px 0 22px', maxHeight: 'min(60vh, 640px)', overflow: 'auto' }}>
        {prepared.map(({ row, selected, status, tokens }, index) => (
          <li key={row.item.key} style={{ padding: '8px 0', borderBottom: '1px solid rgba(127,127,127,0.24)' }}>
            <strong style={{ overflowWrap: 'anywhere' }}>{row.item.title}</strong>
            <ReviewControls
              t={t}
              row={row}
              update={(changes) => update(row.item.key, changes)}
            />
            <div role="status">
              {status}
              {selected !== null && row.fulltext !== null && row.fulltext !== undefined && (
                <>
                  {' · '}{selected.scope}{' · '}
                  {tpl(t('fulltext.tokens'), { n: tokens.toLocaleString() })}
                </>
              )}
            </div>
            {row.error === 'load' && (
              <Button type="button" size="sm" onClick={() => {
                if (row.detail === undefined) {
                  update(row.item.key, { error: undefined })
                  setReload((value) => value + 1)
                }
                else update(row.item.key, { error: undefined, fulltext: undefined })
              }}>{t('action.retry')}</Button>
            )}
            {selected !== null && (
              <details>
                <summary>{t('fulltext.preview')}</summary>
                <pre style={{ maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{displayReviewEvidence(sections[index])}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </Modal>
  )
}

const controls: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, marginBlock: 5, alignItems: 'center' }

function ReviewControls({ t, row, update }: {
  t: Translate
  row: ReviewRow
  update(changes: Partial<ReviewRow>): void
}): ReactElement {
  const { detail, attachmentKey } = row
  // A child effect owns the request for the active attachment. The previous request is
  // cancelled on a switch so an old result cannot overwrite the new selection.
  useEffect(() => {
    if (detail === undefined || attachmentKey === '' || row.fulltext !== undefined || row.error) return
    const controller = new AbortController()
    fetchFulltext(attachmentKey, controller.signal).then((fulltext) => {
      if (controller.signal.aborted) return
      if (fulltext !== null && fulltext.revision === undefined) {
        update({ fulltext: undefined, error: 'host' })
        return
      }
      update({ fulltext, end: String(Math.min(INITIAL_CHARS, fulltext?.content.length ?? INITIAL_CHARS)) })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const outdated = error instanceof ApiFailure && error.code === 'bad_request' && error.message.includes('未知 action')
      update({ error: outdated ? 'host' : 'load', fulltext: undefined })
    })
    return () => controller.abort()
    // The callback only addresses this row's stable item key.
  }, [attachmentKey, detail, row.fulltext, row.error])

  useEffect(() => {
    if (row.mode !== 'chapter' || row.outline !== undefined || row.outlineError || row.fulltext?.revision === undefined) return
    const controller = new AbortController()
    const attachment = detail?.attachments.find((item) => item.key === attachmentKey)
    readAttachmentOutline(attachment, row.fulltext.content, controller.signal).then((outline) => {
      if (!controller.signal.aborted) {
        update({ outline })
      }
    }).catch(() => {
      if (!controller.signal.aborted) update({ outlineError: true })
    })
    return () => controller.abort()
  }, [row.item.key, row.mode, row.outline, row.outlineError, row.fulltext, detail, attachmentKey])

  return (
    <>
      <div style={controls}>
        {(detail?.attachments.length ?? 0) > 0 && (
          <label style={{ minWidth: 0 }}>
            {t('review.attachment')}{' '}
            <select
              value={attachmentKey}
              style={{ maxWidth: '100%' }}
              onChange={(event) => update({
                attachmentKey: event.target.value, fulltext: undefined, error: undefined, outline: undefined, outlineError: false, chapters: new Set(), start: '0', end: String(INITIAL_CHARS),
              })}
            >
              {detail?.attachments.map((item) => <option key={item.key} value={item.key}>{item.title || item.filename || item.key}</option>)}
            </select>
          </label>
        )}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          {t('review.scope')}{' '}
          <select value={row.mode} onChange={(event) => {
            const mode = event.target.value
            if (mode === 'metadata' || mode === 'range' || mode === 'all' || mode === 'chapter') update({ mode })
          }}>
            <option value="metadata">{t('review.coverage.metadata')}</option>
            <option value="all">{t('fulltext.scope.all')}</option>
            <option value="chapter">{t('fulltext.mode.chapter')}</option>
            <option value="range">{t('fulltext.option.chars')}</option>
          </select>
        </label>
        {row.mode === 'range' && row.fulltext?.revision !== undefined && (
          <>
            <label>{t('fulltext.start')}{' '}<input type="number" min={0} max={row.fulltext.content.length} value={row.start}
              style={{ width: '6em' }} onChange={(event) => update({ start: event.target.value })} /></label>
            <label>{t('fulltext.end')}{' '}<input type="number" min={0} max={row.fulltext.content.length} value={row.end}
              style={{ width: '6em' }} onChange={(event) => update({ end: event.target.value })} /></label>
          </>
        )}
      </div>
      {row.mode === 'chapter' && row.outlineError && (
        <Button type="button" size="sm" onClick={() => update({ outlineError: false })}>{t('action.retry')}</Button>
      )}
      {row.mode === 'chapter' && row.outline !== undefined && row.outline.length > 0 && (
        <fieldset style={{ margin: '8px 0', padding: '6px 10px', border: '1px solid rgba(127,127,127,0.24)', borderRadius: 6 }}>
          <legend>{t('review.chapters')}</legend>
          <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <Button type="button" size="sm" onClick={() => update({ chapters: new Set(row.outline?.map((_, index) => index)) })}>
              {t('fulltext.selectAll')}
            </Button>
            <Button type="button" size="sm" onClick={() => update({ chapters: new Set() })}>{t('fulltext.clear')}</Button>
          </div>
          <div style={{ maxHeight: 200, overflow: 'auto' }}>
            {row.outline.map((item, index) => (
              <label key={index} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: `3px 0 3px ${Math.min(item.depth, 6) * 12}px` }}>
                <input type="checkbox" checked={row.chapters.has(index)} onChange={() => {
                  const chapters = new Set(row.chapters)
                  if (chapters.has(index)) chapters.delete(index)
                  else chapters.add(index)
                  update({ chapters })
                }} />
                <span>{item.title}</span>
                {item.target?.kind === 'page' && <small style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>P{item.target.page}</small>}
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </>
  )
}
