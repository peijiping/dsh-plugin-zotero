/**
 * 条目详情里的标注列表（高亮 / 划线 / 笔记 / 文本 / 截图 / 墨迹）。
 *
 * 标注是 PDF 附件的子条目（`itemType: "annotation"`）。是否可定位看两处：
 * PDF 叠加视图用 `position`，文本兜底用 Host 在全文上算好的 `range`；
 * 两者都没有时行会置灰，但仍可加入会话。
 *
 * 顶部两行筛选：类型与颜色，两者 AND 组合。类型按当前条目的实际种类生成，
 * 不会出现空分类。
 *
 * 开了写入开关后，高亮与划线可以就地改：换色、换类型、评论、页码、标签，以及删除。
 * 三条约定：
 * - 每次只发改动的那一个字段，`text` 与 `position` 绝不过我们的手；
 * - 标签是**整表替换**，所以草稿框里给的是全表、发出去的也是全表；
 * - 删除是硬删（不进 Zotero 回收站），因此必须点两次。
 * 写完一律交给 {@link onChanged} 重取详情：版本号以库里那份为准，本地不猜结果。
 */

import { Fragment, useState, type ReactElement, type ReactNode } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroAnnotation, ZoteroAnnotationPatch } from '../zotero/types'
import { ANNOTATION_COLORS } from '../zotero/palette'
import { deleteAnnotation, patchAnnotation } from './api'
import { commentForEditor, hasComment, parseComment } from './annotationComment'
import {
  annotationColor,
  EDITABLE_TYPES,
  filterAnnotations,
  isLocatable,
  type AnnotationFilter,
} from './annotationRuns'
import { tpl, type Translate } from './locales'
import { showToast } from './paneStore'
import { ACCENT } from './styles'

interface Props {
  t: Translate
  annotations: ZoteroAnnotation[]
  /** 是否有全文（决定未锚定时的提示文案）。 */
  hasFulltext: boolean
  /** 全文是否被截断。 */
  truncated: boolean
  /** 类型 + 颜色筛选；由详情持有，正文内联跟着一起过滤。 */
  filter: AnnotationFilter
  /** 配置里的「允许写入 Zotero」是否打开；关着时整块保持只读。 */
  canWrite: boolean
  onFilterChange(filter: AnnotationFilter): void
  onLocate(annotation: ZoteroAnnotation): void
  onInsert(annotation: ZoteroAnnotation): void
  /** 写成功后重取整份详情：Zotero 是唯一真相，本地不拼结果。 */
  onChanged(): void
}

/** 类型 chip 的固定顺序；未出现的类型不渲染。 */
const TYPE_ORDER = ['highlight', 'underline', 'note', 'text', 'image', 'ink'] as const

/** 可互转的类型，编辑区里按这个顺序摆 chip。 */
const TOGGLE_TYPES = ['highlight', 'underline'] as const

interface ColorChip {
  hex: string
  count: number
}

/** 展开的那条标注的草稿；每一项都是「将要原样写回 Zotero」的形态。 */
interface Draft {
  comment: string
  pageLabel: string
  tags: string
}

const EMPTY_DRAFT: Draft = { comment: '', pageLabel: '', tags: '' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 草稿串 → 标签表。
 *
 * 分隔符容忍全角逗号与换行：中文输入法下逗号天然是「，」。标签本身不含逗号，
 * 真要带就回 Zotero 里加——这里是复刻，不是另立一套标签语法。
 */
function parseTags(input: string): ZoteroAnnotationPatch['tags'] {
  const seen: string[] = []
  for (const part of input.split(/[,，\n]/u)) {
    const tag = part.trim()
    if (tag !== '' && !seen.includes(tag)) seen.push(tag)
  }
  return seen.map((tag) => ({ tag, type: 1 }))
}

function tagsToText(tags: ZoteroAnnotation['tags']): string {
  return tags.map((item) => item.tag).join(', ')
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
  canWrite,
  onFilterChange,
  onLocate,
  onInsert,
  onChanged,
}: Props): ReactElement | null {
  /** 展开编辑区的标注 key；一次只开一条，窄面板里塞两个编辑器只会互相抢视线。 */
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 已点过一次「删除」、正在等第二次确认的标注 key。 */
  const [armed, setArmed] = useState<string | null>(null)

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
  const anchored = annotations.filter(isLocatable).length

  function unanchoredTitle(): string {
    if (!hasFulltext) return t('detail.annotationNotAnchoredNoFulltext')
    if (truncated) return t('detail.annotationNotAnchoredTruncated')
    return t('detail.annotationNotAnchored')
  }

  /**
   * 跑一次与 Zotero 的往返。
   *
   * 成功只报一句就重取详情（新版本号、PDF 叠加层、列表排序都以库里那份为准）；
   * 失败把 Host 的中文文案原样摊出来——里面已经写明去哪点授权、或哪项校验没过。
   */
  async function run(action: () => Promise<unknown>, message: string): Promise<boolean> {
    setNotice(null)
    setBusy(true)
    try {
      await action()
      showToast(message)
      onChanged()
      return true
    } catch (error) {
      setNotice(tpl(t('annotation.writeFailed'), { message: errorMessage(error) }))
      return false
    } finally {
      setBusy(false)
    }
  }

  function save(annotation: ZoteroAnnotation, patch: ZoteroAnnotationPatch): void {
    void run(
      () => patchAnnotation({ key: annotation.key, version: annotation.version, patch }),
      t('annotation.saved'),
    )
  }

  function remove(annotation: ZoteroAnnotation): void {
    setArmed(null)
    void run(
      () => deleteAnnotation({ key: annotation.key, version: annotation.version }),
      t('annotation.deleted'),
    ).then((done) => {
      if (done && editingKey === annotation.key) setEditingKey(null)
    })
  }

  /** 编辑区开合：打开时把草稿铺好，取的是库里那份的归一化形态。 */
  function toggleEditor(annotation: ZoteroAnnotation): void {
    setArmed(null)
    if (editingKey === annotation.key) {
      setEditingKey(null)
      return
    }
    setEditingKey(annotation.key)
    setDraft({
      comment: commentForEditor(annotation.comment),
      pageLabel: annotation.pageLabel,
      tags: tagsToText(annotation.tags),
    })
  }

  function rowButtons(annotation: ZoteroAnnotation): ReactElement | null {
    if (!canWrite) return null
    if (!EDITABLE_TYPES.has(annotation.type)) {
      return (
        <Button variant="outline" size="sm" disabled title={t('annotation.lockedHint')} style={insertButtonStyle}>
          {t('annotation.edit')}
        </Button>
      )
    }
    const open = editingKey === annotation.key
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => toggleEditor(annotation)}
          title={open ? undefined : t('annotation.editTitle')}
          style={insertButtonStyle}
        >
          {open ? t('annotation.closeEdit') : t('annotation.edit')}
        </Button>
        {armed === annotation.key ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => remove(annotation)}
            title={t('annotation.deleteWarn')}
            style={insertButtonStyle}
          >
            {t('annotation.confirmDelete')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setArmed(annotation.key)}
            title={t('annotation.deleteWarn')}
            style={insertButtonStyle}
          >
            {t('annotation.delete')}
          </Button>
        )}
      </>
    )
  }

  /**
   * 一条标注的编辑区。
   *
   * 色块与类型 chip 点一下就写（改的是「选一个值」这类单选项，不需要再按保存）；
   * 评论、页码、标签是自由文本，各带一个保存按钮，内容没变时保存是灰的——
   * 省掉一次「什么都没改但版本号涨了」的写。
   */
  function editor(annotation: ZoteroAnnotation): ReactElement {
    const current = annotationColor(annotation).toLowerCase()
    const originalComment = commentForEditor(annotation.comment)
    const originalTags = tagsToText(annotation.tags)
    // 页码按提交口径 trim 后再比，否则编辑器一开「保存」就是亮的。
    const pageChanged = draft.pageLabel.trim() !== annotation.pageLabel.trim()
    return (
      <div style={editorStyle}>
        <div style={fieldRowStyle}>
          <span style={fieldLabelStyle}>{t('annotation.color')}</span>
          {ANNOTATION_COLORS.map((hex) => (
            <button
              key={hex}
              type="button"
              disabled={busy || hex === current}
              onClick={() => save(annotation, { color: hex })}
              title={hex === current ? t('annotation.currentColor') : t('annotation.setColor')}
              aria-label={t('annotation.setColor')}
              style={{
                ...swatchButtonStyle,
                background: hex,
                boxShadow: hex === current ? `inset 0 0 0 2px Canvas, 0 0 0 2px ${ACCENT}` : 'inset 0 0 0 1px rgba(127,127,127,0.35)',
              }}
            />
          ))}
        </div>

        <div style={fieldRowStyle}>
          <span style={fieldLabelStyle}>{t('annotation.type')}</span>
          {TOGGLE_TYPES.map((type) => (
            <Chip
              key={type}
              active={annotation.type === type}
              onClick={() => {
                if (annotation.type !== type) save(annotation, { type })
              }}
            >
              {typeLabel(t, type)}
            </Chip>
          ))}
        </div>

        <div style={fieldBlockStyle}>
          <span style={fieldLabelStyle}>{t('annotation.comment')}</span>
          <textarea
            value={draft.comment}
            placeholder={t('annotation.commentPlaceholder')}
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, comment: event.target.value }))}
            style={textareaStyle}
            aria-label={t('annotation.comment')}
          />
          <div style={editorFootStyle}>
            <span style={editorHintStyle}>{t('annotation.commentHint')}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || draft.comment === originalComment}
              onClick={() => save(annotation, { comment: draft.comment })}
            >
              {t('annotation.save')}
            </Button>
          </div>
        </div>

        <div style={fieldRowStyle}>
          <span style={fieldLabelStyle}>{t('annotation.pageLabel')}</span>
          <input
            value={draft.pageLabel}
            placeholder={t('annotation.pagePlaceholder')}
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, pageLabel: event.target.value }))}
            style={inputStyle}
            aria-label={t('annotation.pageLabel')}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !pageChanged}
            onClick={() => save(annotation, { pageLabel: draft.pageLabel })}
            style={fieldButtonStyle}
          >
            {t('annotation.save')}
          </Button>
        </div>

        <div style={fieldBlockStyle}>
          <span style={fieldLabelStyle}>{t('annotation.tags')}</span>
          <input
            value={draft.tags}
            placeholder={t('annotation.tagsPlaceholder')}
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, tags: event.target.value }))}
            style={inputStyle}
            aria-label={t('annotation.tags')}
          />
          <div style={editorFootStyle}>
            <span style={editorHintStyle}>{t('annotation.tagsHint')}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || draft.tags === originalTags}
              onClick={() => save(annotation, { tags: parseTags(draft.tags) })}
            >
              {t('annotation.save')}
            </Button>
          </div>
        </div>
      </div>
    )
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
          const located = isLocatable(annotation)
          const text = annotation.text.trim()
          const canInsert = text !== '' || hasComment(annotation.comment)
          return (
            <div key={key} style={{ padding: '8px 2px', borderBottom: '1px solid rgba(127,127,127,0.18)', opacity: located ? 1 : 0.55 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 4 }}>
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
                {rowButtons(annotation)}
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

              {editingKey === key && editor(annotation)}
            </div>
          )
        })
      )}

      {notice !== null && (
        <div role="alert" style={noticeStyle}>
          {notice}
        </div>
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

const editorStyle = {
  marginTop: 8,
  padding: 8,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.25)',
  background: 'rgba(127,127,127,0.05)',
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
  opacity: 1,
} as const

const fieldRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 5,
} as const

const fieldBlockStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
} as const

const fieldLabelStyle = {
  fontSize: 11,
  opacity: 0.65,
  flexShrink: 0,
  marginRight: 2,
} as const

const fieldButtonStyle = {
  flexShrink: 0,
  height: 20,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
} as const

const editorFootStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
} as const

const editorHintStyle = {
  flex: 1,
  fontSize: 10.5,
  lineHeight: 1.5,
  opacity: 0.6,
} as const

/** 色块按钮：颜色本身就是标签，不需要文字；当前色用描边圈出来（禁用态也看得出选了哪个）。 */
const swatchButtonStyle = {
  width: 16,
  height: 16,
  padding: 0,
  flexShrink: 0,
  borderRadius: 3,
  border: 'none',
  cursor: 'pointer',
} as const

const textareaStyle = {
  width: '100%',
  minHeight: 64,
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 12.5,
  lineHeight: 1.6,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'inherit',
  fontFamily: 'inherit',
  resize: 'vertical',
} as const

const inputStyle = {
  flex: 1,
  minWidth: 90,
  boxSizing: 'border-box',
  padding: '4px 8px',
  fontSize: 12.5,
  lineHeight: 1.5,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'inherit',
  fontFamily: 'inherit',
} as const

const noticeStyle = {
  marginTop: 6,
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.6,
  color: '#d29922',
  background: 'rgba(210,153,34,0.1)',
  overflowWrap: 'break-word',
} as const
