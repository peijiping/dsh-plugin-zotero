/**
 * 左上角的悬浮信息菜单：文献信息 / 摘要 / 标注 / 笔记 / 附件 / 参考文献。
 *
 * 文档占满整版面，元数据类内容收进这个按钮背后的浮层，每块都可折叠。
 * 「加入对话」是这一行里的独立按钮（`i` 右侧），不放浮层里：它是每次读文献都要点的
 * 主操作，藏进菜单等于每次多两次点击。
 * 浮层用系统色 `Canvas` / `CanvasText`，盖在白色 PDF 上深浅主题都能读。
 * 点浮层外或按 Esc 关闭（统一走 {@link useDismiss}，网页快照在 iframe 里的按下也算
 * 「外」）；点标注定位后也关闭，让文档重新成为焦点。
 *
 * 各区块的开合全局记一份（见 {@link useInfoSections}）：用户按自己的习惯折过
 * 一次之后，换文献、关浮层、重启都保持原样，不用每篇重新折。
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { AnnotationList } from './AnnotationList'
import type { AnnotationFilter } from './annotationRuns'
import { useDismiss } from './dismiss'
import {
  setInfoSection,
  toggleInfoSection,
  useInfoSections,
  type InfoSectionId,
} from './infoSectionStore'
import { itemTypeLabel } from './itemType'
import type { Translate } from './locales'
import { NoteList } from './NoteList'
import { ACCENT } from './styles'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  /** 当前正文展示的附件；附件块据此打勾。 */
  currentAttachmentKey: string | null
  open: boolean
  onToggle(): void
  onClose(): void
  onCite(): void
  onSelectAttachment(key: string): void
  onLocateAnnotation(annotation: ZoteroAnnotation): void
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  onInsertNote(note: ZoteroNote): void
  /** 面板里的写操作成功后重取整份详情。 */
  onChanged(): void
  annotationFilter: AnnotationFilter
  onAnnotationFilterChange(filter: AnnotationFilter): void
}

interface BlockProps {
  label: string
  hint?: string
  open: boolean
  onToggle(): void
  /**
   * 标题行右侧的独立操作（如「笔记」的加号新建）。
   *
   * 不能塞进标题按钮里：那会变成 `<button>` 套 `<button>`，点一下既触发操作又开合区块。
   */
  action?: ReactNode
  children: ReactNode
}

function Block({ label, hint, open, onToggle, action, children }: BlockProps): ReactElement {
  return (
    <section style={blockStyle}>
      <div style={blockHeaderRowStyle}>
        <button type="button" onClick={onToggle} aria-expanded={open} style={blockHeaderStyle}>
          <span style={blockChevronStyle}>{open ? '▾' : '▸'}</span>
          <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
          {hint !== undefined && <span style={blockHintStyle}>{hint}</span>}
        </button>
        {action}
      </div>
      {open && <div style={blockBodyStyle}>{children}</div>}
    </section>
  )
}

/** 去掉 CSL HTML 标签，只留可见文本。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim()
}

export function InfoPanel({
  t,
  detail,
  currentAttachmentKey,
  open,
  onToggle,
  onClose,
  onCite,
  onSelectAttachment,
  onLocateAnnotation,
  onInsertAnnotation,
  onInsertNote,
  onChanged,
  annotationFilter,
  onAnnotationFilterChange,
}: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 各区块开合来自全局持久状态，不放在组件里：换条目/重开都是同一份。 */
  const sections = useInfoSections()
  /** 「笔记」新建框是否打开：加号在区块标题行，编辑器在区块内，状态只能放在这里。 */
  const [composingNote, setComposingNote] = useState(false)

  // 换条目 / 收起浮层时丢掉半截的新建草稿，免得带到下一条文献上。
  useEffect(() => {
    setComposingNote(false)
  }, [detail.key, open])

  // 点浮层外 / 按 Esc 收起。根节点同时包着触发按钮，点它不会被判成「外面」，
  // 交给 `onToggle` 自己开合。
  useDismiss(open, rootRef, onClose)

  function toggle(id: InfoSectionId): void {
    toggleInfoSection(id)
  }

  const metaRows: { label: string; value: string }[] = []
  const typeLabel = itemTypeLabel(t, detail.itemType)
  if (typeLabel !== '') metaRows.push({ label: t('detail.type'), value: typeLabel })
  if (detail.creators.length > 0) metaRows.push({ label: t('detail.creators'), value: detail.creators.join('、') })
  if (detail.year !== '') metaRows.push({ label: t('detail.year'), value: detail.year })
  if (detail.publicationTitle !== '') metaRows.push({ label: t('detail.source'), value: detail.publicationTitle })
  if (detail.doi !== '') metaRows.push({ label: t('detail.doi'), value: detail.doi })
  if (detail.url !== '') metaRows.push({ label: t('detail.url'), value: detail.url })
  if (detail.collectionNames.length > 0) {
    metaRows.push({ label: t('detail.collections'), value: detail.collectionNames.join(' / ') })
  }
  if (detail.tags.length > 0) metaRows.push({ label: t('detail.tags'), value: detail.tags.join('、') })

  const selfNote = detail.itemType === 'note'
  const notes = detail.notes

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={t('detail.info')}
        title={t('detail.info')}
        style={triggerStyle}
      >
        i
      </button>

      {/* 笔记类条目自己就是正文，没有「把条目加入对话」这回事（同浮层头部的旧规则）。 */}
      {!selfNote && (
        <button type="button" onClick={onCite} title={t('action.insertItem')} style={citeTriggerStyle}>
          {t('action.insertItemShort')}
        </button>
      )}

      {open && (
        <div role="dialog" aria-label={t('detail.info')} style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span style={panelTitleStyle} title={detail.title}>{detail.title}</span>
          </div>

          <Block label={t('detail.metadata')} open={sections.metadata} onToggle={() => toggle('metadata')}>
            {metaRows.map((row) => (
              <div key={row.label} style={metaRowStyle}>
                <span style={metaLabelStyle}>{row.label}</span>
                <span style={{ wordBreak: 'break-word' }}>{row.value}</span>
              </div>
            ))}
          </Block>

          {detail.abstract !== '' && (
            <Block
              label={t('detail.abstract')}
              open={sections.abstract}
              onToggle={() => toggle('abstract')}
            >
              <p style={paragraphStyle}>{detail.abstract}</p>
            </Block>
          )}

          {detail.annotations.length > 0 && (
            <Block
              label={t('detail.annotations')}
              hint={String(detail.annotations.length)}
              open={sections.annotations}
              onToggle={() => toggle('annotations')}
            >
              <AnnotationList
                t={t}
                annotations={detail.annotations}
                hasFulltext={detail.fulltext !== null}
                truncated={detail.fulltext?.truncated === true}
                filter={annotationFilter}
                canWrite={detail.writeEnabled}
                onFilterChange={onAnnotationFilterChange}
                onLocate={onLocateAnnotation}
                onInsert={onInsertAnnotation}
                onChanged={onChanged}
              />
            </Block>
          )}

          {(notes.length > 0 || (detail.writeEnabled && !selfNote)) && (
            <Block
              label={t('detail.notes')}
              hint={String(notes.length)}
              open={sections.notes}
              onToggle={() => toggle('notes')}
              action={
                detail.writeEnabled && !selfNote ? (
                  <button
                    type="button"
                    onClick={() => {
                      // 区块收着就先摊开再出新笔记框，别让用户点了没反应。
                      if (!sections.notes) {
                        setInfoSection('notes', true)
                        setComposingNote(true)
                        return
                      }
                      setComposingNote((previous) => !previous)
                    }}
                    title={composingNote ? t('note.cancel') : t('note.new')}
                    aria-label={t('note.new')}
                    style={blockActionStyle}
                  >
                    {composingNote ? '×' : '+'}
                  </button>
                ) : undefined
              }
            >
              <NoteList
                t={t}
                notes={notes}
                itemKey={detail.key}
                canWrite={detail.writeEnabled}
                selfNote={selfNote}
                composing={composingNote}
                onComposingChange={setComposingNote}
                onInsert={onInsertNote}
                onChanged={onChanged}
              />
            </Block>
          )}

          {detail.attachments.length > 0 && (
            <Block
              label={t('detail.attachments')}
              hint={String(detail.attachments.length)}
              open={sections.attachments}
              onToggle={() => toggle('attachments')}
            >
              {detail.attachments.map((attachment) => {
                const current = attachment.key === currentAttachmentKey
                return (
                  <button
                    key={attachment.key}
                    type="button"
                    onClick={() => onSelectAttachment(attachment.key)}
                    style={{ ...attachmentRowStyle, opacity: current ? 1 : 0.8 }}
                    title={t('detail.attachmentOpen')}
                  >
                    <span style={{ width: 12, flexShrink: 0, color: ACCENT }}>{current ? '●' : ''}</span>
                    <span style={{ flex: 1, textAlign: 'left', wordBreak: 'break-word' }}>
                      {attachment.filename || attachment.title}
                    </span>
                    <span style={attachmentMetaStyle}>
                      {attachment.contentType}
                      {attachment.size > 0 ? ` · ${Math.round(attachment.size / 1024)} KB` : ''}
                    </span>
                  </button>
                )
              })}
            </Block>
          )}

          {detail.bib !== null && (
            <Block label={t('detail.bibTitle')} open={sections.bib} onToggle={() => toggle('bib')}>
              <p style={paragraphStyle}>{stripTags(detail.bib)}</p>
            </Block>
          )}
        </div>
      )}
    </div>
  )
}

const rootStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 20,
  pointerEvents: 'none',
} as const

/** 这一行按钮从左往右：目录（8）、文献信息（34）、加入对话（60），每个 22 高、间隔 4。 */
const triggerStyle = {
  position: 'absolute',
  pointerEvents: 'auto',
  top: 4,
  left: 34,
  width: 22,
  height: 22,
  padding: 0,
  fontSize: 13,
  fontStyle: 'italic',
  fontWeight: 700,
  lineHeight: 1,
  borderRadius: '50%',
  border: '1px solid rgba(127,127,127,0.4)',
  background: 'Canvas',
  color: 'CanvasText',
  cursor: 'pointer',
  boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
  zIndex: 21,
} as const

const panelStyle = {
  position: 'absolute',
  pointerEvents: 'auto',
  top: 32,
  left: 8,
  width: 320,
  maxWidth: 'calc(100% - 16px)',
  maxHeight: 'calc(100% - 40px)',
  overflow: 'auto',
  padding: '8px 10px 10px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.32)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  fontSize: 12,
  lineHeight: 1.6,
  overscrollBehavior: 'contain',
} as const

const panelHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  paddingBottom: 6,
  borderBottom: '1px solid rgba(127,127,127,0.2)',
} as const

const panelTitleStyle = {
  flex: 1,
  minWidth: 0,
  fontWeight: 700,
  fontSize: 12.5,
  lineHeight: 1.45,
  wordBreak: 'break-word',
} as const

/** 收在 `i` 右边、跟它同一行：是每次读文献都要点的主操作，不藏进浮层。 */
const citeTriggerStyle = {
  position: 'absolute',
  pointerEvents: 'auto',
  top: 4,
  left: 60,
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 9px',
  fontSize: 11.5,
  fontWeight: 500,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  borderRadius: 11,
  border: '1px solid rgba(127,127,127,0.4)',
  background: 'Canvas',
  color: 'CanvasText',
  cursor: 'pointer',
  boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
  zIndex: 21,
} as const

const blockStyle = {
  borderBottom: '1px solid rgba(127,127,127,0.18)',
  padding: '4px 0',
} as const

const blockHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  flex: 1,
  minWidth: 0,
  padding: '3px 0',
  fontSize: 12.5,
  fontWeight: 700,
  color: ACCENT,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
} as const

const blockHeaderRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
} as const

/** 标题行上的图标按钮（当前只有「笔记」的加号 / 取消）。 */
const blockActionStyle = {
  flexShrink: 0,
  width: 16,
  height: 16,
  padding: 0,
  marginRight: 2,
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.45)',
  background: 'transparent',
  color: ACCENT,
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
} as const

const blockChevronStyle = {
  flexShrink: 0,
  fontSize: 10,
  opacity: 0.8,
} as const

const blockHintStyle = {
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 400,
  opacity: 0.65,
} as const

const blockBodyStyle = {
  padding: '2px 0 4px',
} as const

const metaRowStyle = {
  display: 'flex',
  gap: 6,
  marginBottom: 2,
  lineHeight: 1.55,
} as const

const metaLabelStyle = {
  flexShrink: 0,
  marginRight: 4,
  whiteSpace: 'nowrap',
  opacity: 0.6,
} as const

const paragraphStyle = {
  margin: 0,
  opacity: 0.88,
  fontSize: 12,
} as const

const attachmentRowStyle = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  width: '100%',
  padding: '4px 0',
  fontSize: 12,
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid rgba(127,127,127,0.14)',
  color: 'inherit',
  cursor: 'pointer',
} as const

const attachmentMetaStyle = {
  flexShrink: 0,
  fontSize: 10.5,
  opacity: 0.55,
} as const
