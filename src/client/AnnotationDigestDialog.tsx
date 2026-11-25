/**
 * 「汇总笔记与标注」确认弹层。
 *
 * 两个入口共用：条目列表右键（单选 / 多选）、条目详情的「加入对话」下拉。
 *
 * 这一层的价值全在**看得到、勾得动**：每条标注给原文、页码、颜色与评论，每条
 * 笔记给标题、字数、日期与正文首行，默认全选，取消某条就是「这条不要」。
 * 只列条目名与条数的版本等于没有选择，用户不如直接插整组。
 *
 * 勾选状态只活在这一次打开里（关了就复位为全选）：一次性场景，记住上次选了
 * 什么反而制造「为什么这次少了」的困惑。
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroAnnotation, ZoteroNote } from '../zotero/types'
import {
  ANNSET_MAX_ITEMS,
  ANNSET_MAX_PAPERS,
  countItems,
  groupCheckState,
  hasAnnotationContent,
  hasNoteContent,
  planDigest,
  sortAnnotations,
  sortNotes,
  type DigestPaperInput,
} from './annotationDigest'
import { hasComment } from './annotationComment'
import { fetchItem } from './api'
import { annotationSetText, annotationSetChipLabel, noteHtmlToText } from './compose'
import { tpl, type Translate } from './locales'
import { showToast } from './paneStore'
import { annotationSetReference, type AnnotationSetRef, type ReferenceInsert } from './reference'
import { estimateTokens } from './tokens'
import { Button } from './ui'

interface DigestTarget {
  key: string
  title: string
}

interface AnnRow {
  key: string
  checked: boolean
  annotation: ZoteroAnnotation
}

interface NoteRow {
  key: string
  checked: boolean
  note: ZoteroNote
}

interface Group {
  key: string
  title: string
  creators: string
  year: string
  status: 'loading' | 'ready' | 'failed'
  annotations: AnnRow[]
  notes: NoteRow[]
  /** 组默认展开：折叠状态勾选看不见，等于又退回条目级。 */
  open: boolean
}

interface Props {
  t: Translate
  items: readonly DigestTarget[]
  onClose(): void
  /** 实际插入的枚数；返回 0 表示没插进去（草稿被改、无编辑器），此时不关闭。 */
  onInsert(references: readonly ReferenceInsert[]): number
}

function typeLabel(t: Translate, type: string): string {
  const key = `annotation.type.${type}`
  const label = t(key)
  return label === key ? type : label
}

/** 组头计数：只显示本篇真有的那一类，避免「0/0 标注 · 2/2 笔记」这种噪音。 */
function groupMetaText(t: Translate, a: number, ta: number, n: number, tn: number): string {
  if (ta === 0) return tpl(t('digest.group.noteOnly'), { n, tn })
  if (tn === 0) return tpl(t('digest.group.annOnly'), { a, ta })
  return tpl(t('digest.group.count'), { a, ta, n, tn })
}

function pageText(annotation: ZoteroAnnotation): string {
  if (annotation.pageLabel !== '') return annotation.pageLabel
  return annotation.position === null ? '' : String(annotation.position.pageIndex + 1)
}

export function AnnotationDigestDialog({ t, items, onClose, onInsert }: Props): ReactElement {
  const [groups, setGroups] = useState<Group[]>(() => items.map((item) => ({
    key: item.key,
    title: item.title,
    creators: '',
    year: '',
    status: 'loading',
    annotations: [],
    notes: [],
    open: true,
  })))
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const pending = groups.filter((group) => group.status === 'loading').map((group) => group.key)
    async function load(): Promise<void> {
      for (let start = 0; start < pending.length && !controller.signal.aborted; start += 4) {
        await Promise.all(pending.slice(start, start + 4).map(async (key) => {
          try {
            const detail = await fetchItem(key, 'apa', controller.signal)
            if (controller.signal.aborted) return
            setGroups((current) => current.map((group) => group.key === key ? {
              ...group,
              status: 'ready',
              title: detail.title || group.title,
              creators: detail.creators.join('、'),
              year: detail.year,
              // 截图 / 墨迹这类既无原文也无评论的标注不进汇总，也不占勾选位。
              annotations: sortAnnotations(detail.annotations.filter(hasAnnotationContent))
                .map((annotation) => ({ key: annotation.key, checked: true, annotation })),
              notes: sortNotes(detail.notes.filter(hasNoteContent))
                .map((note) => ({ key: note.key, checked: true, note })),
            } : group))
          } catch {
            if (controller.signal.aborted) return
            // 读不到的篇不静默变「无内容」：留着 failed，让用户决定重试还是跳过。
            setGroups((current) => current.map((group) => group.key === key
              ? { ...group, status: 'failed', annotations: [], notes: [] }
              : group))
          }
        }))
      }
    }
    void load()
    return () => controller.abort()
    // 只为「打开」与「点了重试」各跑一次：groups 放进依赖会每次 setGroups 后重取。
  }, [reload])

  const inputs: DigestPaperInput[] = useMemo(() => groups
    .filter((group) => group.status === 'ready')
    .map((group) => ({
      key: group.key,
      title: group.title,
      creators: group.creators,
      year: group.year,
      annotations: group.annotations.filter((row) => row.checked).map((row) => row.annotation),
      notes: group.notes.filter((row) => row.checked).map((row) => row.note),
    })), [groups])

  const plan = useMemo(() => planDigest(inputs), [inputs])
  const selectedItems = countItems(inputs)
  const tooMany = inputs.length > ANNSET_MAX_PAPERS || selectedItems > ANNSET_MAX_ITEMS

  /** 篇号按「首次出现」编号：续批仍算同一篇，不把篇数撑大。 */
  const paperNumbers = useMemo(() => {
    const map = new Map<string, number>()
    for (const batch of plan.batches) {
      for (const paper of batch.papers) {
        if (!map.has(paper.key)) map.set(paper.key, map.size + 1)
      }
    }
    return map
  }, [plan])

  /** 每批正文的实际文本：统计用真字数，不拿估算糊弄「约 N 字」。 */
  const texts = useMemo(() => plan.batches.map((batch, index) => {
    const numbers = batch.papers.map((paper) => paperNumbers.get(paper.key) ?? 1)
    return annotationSetText(t, batch, {
      index: index + 1,
      total: plan.batches.length,
      from: Math.min(...numbers),
      to: Math.max(...numbers),
      overall: {
        papers: plan.total.papers,
        annotations: plan.total.annotations,
        notes: plan.total.notes,
        chars: plan.total.chars,
        missingItems: 0,
        missingPapers: plan.total.missing,
      },
    })
  }), [plan, paperNumbers, t])

  const chars = texts.reduce((sum, text) => sum + text.length, 0)
  const tokens = estimateTokens(texts.join(''))
  const loading = groups.some((group) => group.status === 'loading')
  const canConfirm = !tooMany && !loading && plan.batches.length > 0

  function setGroupChecked(key: string, checked: boolean): void {
    setGroups((current) => current.map((group) => group.key === key ? {
      ...group,
      annotations: group.annotations.map((row) => ({ ...row, checked })),
      notes: group.notes.map((row) => ({ ...row, checked })),
    } : group))
  }

  function toggleRow(key: string, kind: 'annotation' | 'note', rowKey: string, checked: boolean): void {
    setGroups((current) => current.map((group) => {
      if (group.key !== key) return group
      return kind === 'annotation'
        ? { ...group, annotations: group.annotations.map((row) => row.key === rowKey ? { ...row, checked } : row) }
        : { ...group, notes: group.notes.map((row) => row.key === rowKey ? { ...row, checked } : row) }
    }))
  }

  function bulk(mode: 'all' | 'none' | 'commented'): void {
    setGroups((current) => current.map((group) => ({
      ...group,
      annotations: group.annotations.map((row) => ({
        ...row,
        checked: mode === 'none' ? false : mode === 'commented' ? hasComment(row.annotation.comment) : true,
      })),
      notes: group.notes.map((row) => ({ ...row, checked: mode !== 'none' })),
    })))
  }

  function references(): ReferenceInsert[] {
    const refs: ReferenceInsert[] = []
    for (const [index, batch] of plan.batches.entries()) {
      const numbers = batch.papers.map((paper) => paperNumbers.get(paper.key) ?? 1)
      const continued = batch.papers.filter((paper) => paper.continued).map((paper) => paper.key)
      const more = batch.papers.filter((paper) => paper.hasMore).map((paper) => paper.key)
      const body: AnnotationSetRef = {
        v: 2,
        papers: batch.papers.map((paper) => ({
          key: paper.key,
          anns: paper.annotations.map((annotation) => annotation.key),
          notes: paper.notes.map((note) => note.key),
          annTotal: paper.annotationTotal,
          noteTotal: paper.noteTotal,
        })),
        batch: [index + 1, plan.batches.length],
        range: [Math.min(...numbers), Math.max(...numbers)],
        total: [plan.total.papers, plan.total.annotations, plan.total.notes, chars],
        ...(continued.length > 0 ? { continued } : {}),
        ...(more.length > 0 ? { more } : {}),
      }
      refs.push(annotationSetReference(
        body,
        annotationSetChipLabel(t, index + 1, plan.batches.length, batch.papers.length),
      ))
    }
    return refs
  }

  function confirm(): void {
    const refs = references()
    const inserted = onInsert(refs)
    if (inserted === 0) return
    if (inserted < refs.length) {
      showToast(tpl(t('error.partialInsert'), { n: inserted }))
    } else {
      showToast(tpl(t('digest.inserted'), {
        n: inserted,
        a: plan.total.annotations,
        m: plan.total.notes,
      }))
    }
    onClose()
  }

  const selectedGroups = groups.filter((group) => group.status === 'ready'
    && (group.annotations.some((row) => row.checked) || group.notes.some((row) => row.checked))).length

  const batchesLabel = plan.batches.length <= 1
    ? tpl(t('digest.batchesOne'), { p: plan.total.papers })
    : tpl(t('digest.batches'), {
      n: plan.batches.length,
      sizes: plan.batches.map((batch) => batch.papers.length).join(' + '),
    })

  return (
    <Modal
      open
      title={t('digest.title')}
      closeLabel={t('action.close')}
      onClose={onClose}
      className="dsh-zp-review-modal"
      footer={(
        <div className="dsh-zp-review-footer">
          <small role="status" style={{ flex: 1, minWidth: 0 }}>
            {plan.batches.length === 0
              ? t('digest.empty')
              : tpl(t('digest.stats'), {
                a: plan.total.annotations,
                n: plan.total.notes,
                p: selectedGroups,
                chars: chars.toLocaleString(),
              })}
            {plan.batches.length > 0 && (
              <span style={{ display: 'block' }}>
                {`${batchesLabel} · ${tpl(t('fulltext.tokens'), { n: tokens.toLocaleString() })}`}
              </span>
            )}
          </small>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canConfirm}
            onClick={confirm}
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {t('action.insertItemShort')}
          </Button>
        </div>
      )}
    >
      <p style={{ marginTop: 0 }}>{t('digest.hint')}</p>

      {tooMany && (
        <p role="alert" style={warnStyle}>
          {inputs.length > ANNSET_MAX_PAPERS
            ? tpl(t('digest.limitPapers'), { n: ANNSET_MAX_PAPERS })
            : tpl(t('digest.limitItems'), { n: ANNSET_MAX_ITEMS })}
        </p>
      )}

      <div style={bulkStyle}>
        <span style={{ fontSize: 12.5, opacity: 0.75 }}>
          {tpl(t('digest.selected'), {
            a: plan.total.annotations,
            n: plan.total.notes,
            p: selectedGroups,
          })}
        </span>
        <span style={{ flex: 1 }} />
        <Button type="button" size="sm" onClick={() => bulk('all')}>{t('digest.bulk.all')}</Button>
        <Button type="button" size="sm" onClick={() => bulk('none')}>{t('digest.bulk.none')}</Button>
        <Button type="button" size="sm" onClick={() => bulk('commented')}>{t('digest.bulk.commented')}</Button>
      </div>

      <div style={listStyle}>
        {groups.map((group) => {
          const state = groupCheckState([...group.annotations, ...group.notes].map((row) => row.checked))
          const totalAnnotations = group.annotations.length
          const totalNotes = group.notes.length
          const checkedAnnotations = group.annotations.filter((row) => row.checked).length
          const checkedNotes = group.notes.filter((row) => row.checked).length
          const empty = group.status === 'ready' && totalAnnotations === 0 && totalNotes === 0
          return (
            <div key={group.key} style={groupStyle}>
              <div style={groupHeadStyle}>
                <button
                  type="button"
                  aria-label={t(group.open ? 'digest.group.collapse' : 'digest.group.expand')}
                  onClick={() => setGroups((current) => current.map((item) => item.key === group.key
                    ? { ...item, open: !item.open }
                    : item))}
                  style={caretStyle}
                >
                  {group.open ? '▾' : '▸'}
                </button>
                <input
                  type="checkbox"
                  aria-label={group.title}
                  disabled={group.status !== 'ready' || empty}
                  checked={state === 'all'}
                  ref={(node) => {
                    if (node !== null) node.indeterminate = state === 'partial'
                  }}
                  onChange={() => setGroupChecked(group.key, state !== 'all')}
                />
                <button
                  type="button"
                  onClick={() => setGroups((current) => current.map((item) => item.key === group.key
                    ? { ...item, open: !item.open }
                    : item))}
                  style={groupTitleStyle}
                  title={group.title}
                >
                  {group.title}
                </button>
                <span style={groupMetaStyle(group.status === 'ready' && state === 'partial')}>
                  {group.status === 'loading'
                    ? t('digest.group.loading')
                    : group.status === 'failed'
                      ? t('digest.group.failed')
                      : empty
                        ? t('digest.group.empty')
                        : groupMetaText(t, checkedAnnotations, totalAnnotations, checkedNotes, totalNotes)}
                </span>
              </div>

              {group.status === 'failed' && (
                <div style={groupBodyStyle}>
                  <Button type="button" size="sm" onClick={() => {
                    setGroups((current) => current.map((item) => item.key === group.key
                      ? { ...item, status: 'loading' }
                      : item))
                    setReload((value) => value + 1)
                  }}>{t('action.retry')}</Button>
                </div>
              )}

              {group.open && group.status === 'ready' && (
                <div style={groupBodyStyle}>
                  {group.annotations.map((row) => {
                    const page = pageText(row.annotation)
                    const comment = row.annotation.comment.trim() === '' ? '' : row.annotation.comment
                    return (
                      <label key={row.key} style={rowStyle(!row.checked)}>
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={(event) => toggleRow(group.key, 'annotation', row.key, event.target.checked)}
                        />
                        <span style={rowBodyStyle}>
                          <span style={metaLineStyle}>
                            <span style={{ ...swatchStyle, background: row.annotation.color || '#aaaaaa' }} />
                            {typeLabel(t, row.annotation.type)}
                            {page !== '' && ` · ${tpl(t('digest.page'), { n: page })}`}
                          </span>
                          <span style={quoteStyle}>
                            {row.annotation.text === '' ? t('digest.commentOnly') : row.annotation.text}
                          </span>
                          {comment !== '' && <span style={commentStyle}>{comment}</span>}
                        </span>
                      </label>
                    )
                  })}
                  {group.notes.map((row) => {
                    const body = noteHtmlToText(row.note.html)
                    return (
                      <label key={row.key} style={rowStyle(!row.checked)}>
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={(event) => toggleRow(group.key, 'note', row.key, event.target.checked)}
                        />
                        <span style={rowBodyStyle}>
                          <span style={metaLineStyle}>
                            <span style={{ ...swatchStyle, background: 'rgba(127,127,127,0.75)' }} />
                            {tpl(t('digest.noteMeta'), {
                              chars: Array.from(body).length,
                              date: row.note.dateModified.slice(0, 10),
                            })}
                          </span>
                          <span style={quoteStyle}>{row.note.title || row.note.key}</span>
                          <span style={commentStyle}>{body.slice(0, 120)}</span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

const warnStyle: CSSProperties = {
  margin: '0 0 8px',
  fontSize: 12,
  color: '#d29922',
  lineHeight: 1.6,
}

const bulkStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  padding: '8px 0',
  borderTop: '1px solid rgba(127,127,127,0.24)',
  borderBottom: '1px solid rgba(127,127,127,0.24)',
}

const listStyle: CSSProperties = {
  maxHeight: 'min(52vh, 520px)',
  overflow: 'auto',
  marginTop: 2,
}

const groupStyle: CSSProperties = {
  borderBottom: '1px solid rgba(127,127,127,0.14)',
}

const groupHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 2px',
  position: 'sticky',
  top: 0,
  background: 'Canvas',
  zIndex: 1,
}

const caretStyle: CSSProperties = {
  width: 16,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 10,
  opacity: 0.65,
  cursor: 'pointer',
  flexShrink: 0,
}

const groupTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  cursor: 'pointer',
}

function groupMetaStyle(partial: boolean): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 11,
    opacity: partial ? 0.95 : 0.6,
    color: partial ? '#4a86e8' : 'inherit',
    whiteSpace: 'nowrap',
  }
}

const groupBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  paddingBottom: 4,
}

function rowStyle(off: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 7,
    padding: '4px 2px 4px 22px',
    cursor: 'pointer',
    opacity: off ? 0.45 : 1,
  }
}

const rowBodyStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const metaLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 11,
  opacity: 0.65,
}

const swatchStyle: CSSProperties = {
  width: 9,
  height: 9,
  borderRadius: 2,
  flexShrink: 0,
}

const quoteStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.55,
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
}

/** 评论 / 笔记正文压淡一档：不与原文抢注意力，只作勾选时的判断依据。 */
const commentStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.5,
  opacity: 0.75,
  paddingLeft: 7,
  borderLeft: '2px solid rgba(127,127,127,0.35)',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 1,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
}
