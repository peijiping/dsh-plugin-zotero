/**
 * 点标注弹出的编辑卡片：换色、改评论、换类型、删除、插入会话。
 *
 * PDF 与网页快照共用一份：两边的「点中一条标注」入口不同（PDF 按坐标命中矩形，
 * 快照靠 iframe 里桥接脚本上报），但点中之后的动作完全一样——同一段代码才不会
 * 出现「PDF 能改、快照只能看」这种一半有一半没有的能力差。
 *
 * 三条约定：
 * - 卡片只记标注 key，内容每次从父级的 `annotations` 里现取：写成功后父级重取，
 *   新版本号、最终颜色与类型都从库里回填，本地不拼结果。
 * - 每次只发改动的那一个字段；删除是硬删（不进 Zotero 回收站），因此要点两次。
 * - 定位与宽度由父级给：PDF 按页面坐标摆，快照按 iframe 偏移摆。
 */

import { useEffect, useState, type CSSProperties, type ReactElement, type RefObject } from 'react'

import { ANNOTATION_COLORS } from '../../zotero/palette'
import type { ZoteroAnnotation, ZoteroAnnotationPatch } from '../../zotero/types'
import { commentForEditor, hasComment, parseComment } from '../annotationComment'
import { annotationColor } from '../annotationRuns'
import { deleteAnnotation, patchAnnotation } from '../api'
import { tpl, type Translate } from '../locales'
import { showToast } from '../paneStore'
import { ACCENT, SOFT_BUTTON_STYLE } from '../styles'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function typeLabel(t: Translate, type: string): string {
  const key = `annotation.type.${type}`
  const label = t(key)
  return label === key ? type : label
}

/** 评论正文：白名单渲染加粗 / 斜体 / 上下标与换行，不注入 HTML。 */
function CommentBody({ comment }: { comment: string }): ReactElement {
  return (
    <div style={commentStyle}>
      {parseComment(comment).map((token, index) => {
        if (token.kind === 'break') return <br key={index} />
        let node: React.ReactNode = token.text
        if (token.sup) node = <sup>{node}</sup>
        if (token.sub) node = <sub>{node}</sub>
        if (token.italic) node = <i>{node}</i>
        if (token.bold) node = <b>{node}</b>
        return <span key={index}>{node}</span>
      })}
    </div>
  )
}

interface Props {
  t: Translate
  annotation: ZoteroAnnotation
  /** 卡片自身的位置与外框（`position: absolute` 由调用方决定摆放基准）。 */
  style: CSSProperties
  cardRef: RefObject<HTMLDivElement>
  /** 配置里开了写、正文已就绪、且类型可改时才给编辑入口。 */
  canEdit: boolean
  onClose(): void
  onInsert(annotation: ZoteroAnnotation): void
  onOpenInZotero(): void
  /** 写成功后重取整份详情（卡片内容按 key 现取，新版本号自动跟上来）。 */
  onChanged(): void
}

export function AnnotationCard({
  t,
  annotation,
  style,
  cardRef,
  canEdit,
  onClose,
  onInsert,
  onOpenInZotero,
  onChanged,
}: Props): ReactElement {
  /** 非 null 即评论编辑器打开着，值就是草稿。 */
  const [commentDraft, setCommentDraft] = useState<string | null>(null)
  /** 任何一次写入失败的原因，就地摊在卡片底部。 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 换色 / 换类型 / 删除 / 存评论正在路上：期间禁掉卡片里所有会落库的按钮。 */
  const [busy, setBusy] = useState(false)
  /** 已点过一次「删除」、正在等第二次确认。 */
  const [armed, setArmed] = useState(false)

  // 换一条标注（或关掉再开）时，未提交的草稿、错误提示与二次确认都不能串过去。
  useEffect(() => {
    setCommentDraft(null)
    setNotice(null)
    setArmed(false)
  }, [annotation.key])

  async function patch(fields: ZoteroAnnotationPatch, message: string): Promise<boolean> {
    setNotice(null)
    setBusy(true)
    try {
      await patchAnnotation({ key: annotation.key, version: annotation.version, patch: fields })
      showToast(message)
      onChanged()
      return true
    } catch (error) {
      setNotice(tpl(t('annotation.writeFailed'), { message: errorText(error) }))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveComment(comment: string): Promise<void> {
    if (await patch({ comment }, t('annotation.saved'))) setCommentDraft(null)
  }

  async function remove(): Promise<void> {
    setArmed(false)
    setNotice(null)
    setBusy(true)
    try {
      await deleteAnnotation({ key: annotation.key, version: annotation.version })
      showToast(t('annotation.deleted'))
      onClose()
      onChanged()
    } catch (error) {
      setNotice(tpl(t('annotation.writeFailed'), { message: errorText(error) }))
    } finally {
      setBusy(false)
    }
  }

  const originalComment = commentForEditor(annotation.comment)
  const currentColor = annotationColor(annotation).toLowerCase()

  return (
    <div ref={cardRef} role="dialog" aria-label={typeLabel(t, annotation.type)} style={{ ...cardStyle, ...style }}>
      <div style={headerStyle}>
        <span style={{ width: 9, height: 9, borderRadius: 2, background: annotationColor(annotation) }} />
        <span style={{ opacity: 0.7 }}>{typeLabel(t, annotation.type)}</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose} style={iconButtonStyle} aria-label={t('viewer.close')}>
          ×
        </button>
      </div>

      {annotation.text.trim() !== '' && (
        <p style={quoteStyle}>{annotation.text.trim()}</p>
      )}

      {hasComment(annotation.comment) && commentDraft === null && <CommentBody comment={annotation.comment} />}

      {canEdit && commentDraft === null && (
        <button
          type="button"
          onClick={() => {
            setNotice(null)
            setCommentDraft(originalComment)
          }}
          style={linkStyle}
        >
          {hasComment(annotation.comment) ? t('annotation.editComment') : t('annotation.addComment')}
        </button>
      )}

      {canEdit && commentDraft !== null && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={commentDraft}
            rows={3}
            disabled={busy}
            placeholder={t('annotation.commentPlaceholder')}
            aria-label={t('annotation.comment')}
            onChange={(event) => setCommentDraft(event.target.value)}
            style={textareaStyle}
          />
          <div style={hintStyle}>{t('annotation.commentHint')}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button
              type="button"
              disabled={busy || commentDraft === originalComment}
              onClick={() => void saveComment(commentDraft)}
              style={smallButtonStyle}
            >
              {t('annotation.save')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCommentDraft(null)
                setNotice(null)
              }}
              style={smallButtonStyle}
            >
              {t('annotation.closeEdit')}
            </button>
          </div>
        </div>
      )}

      {canEdit && (
        <div style={rowStyle} aria-label={t('annotation.color')}>
          {ANNOTATION_COLORS.map((hex) => (
            <button
              key={hex}
              type="button"
              disabled={busy || hex === currentColor}
              onClick={() => void patch({ color: hex }, t('annotation.saved'))}
              title={hex === currentColor ? t('annotation.currentColor') : t('annotation.setColor')}
              aria-label={t('annotation.setColor')}
              style={{
                ...swatchStyle,
                background: hex,
                boxShadow: hex === currentColor
                  ? `inset 0 0 0 2px Canvas, 0 0 0 2px ${ACCENT}`
                  : 'inset 0 0 0 1px rgba(127,127,127,0.35)',
              }}
            />
          ))}
        </div>
      )}

      {canEdit && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const next = annotation.type === 'highlight' ? 'underline' : 'highlight'
            void patch({ type: next }, t('annotation.saved'))
          }}
          style={{ ...smallButtonStyle, marginTop: 6 }}
        >
          {t(annotation.type === 'highlight' ? 'annotation.toUnderline' : 'annotation.toHighlight')}
        </button>
      )}

      {notice !== null && (
        <div role="alert" style={noticeStyle}>
          {notice}
        </div>
      )}

      <div style={footStyle}>
        <button type="button" onClick={() => onInsert(annotation)} style={smallButtonStyle}>
          {t('action.insertItemShort')}
        </button>
        <button type="button" onClick={onOpenInZotero} style={smallButtonStyle}>
          {t('viewer.openInZoteroShort')}
        </button>
        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (armed) void remove()
              else setArmed(true)
            }}
            title={t('annotation.deleteWarn')}
            style={{ ...smallButtonStyle, marginLeft: 'auto', ...(armed ? dangerStyle : null) }}
          >
            {armed ? t('annotation.confirmDelete') : t('annotation.delete')}
          </button>
        )}
      </div>
    </div>
  )
}

const cardStyle = {
  position: 'absolute',
  width: 260,
  maxHeight: '55%',
  overflow: 'auto',
  padding: '8px 10px',
  borderRadius: 8,
  background: 'Canvas',
  color: 'CanvasText',
  border: '1px solid rgba(127,127,127,0.32)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
  zIndex: 9,
  fontSize: 12,
  lineHeight: 1.6,
  textAlign: 'left',
} as const

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginBottom: 6,
} as const

const quoteStyle = {
  margin: '0 0 6px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const

const commentStyle = {
  marginTop: 4,
  paddingLeft: 8,
  borderLeft: '2px solid rgba(127,127,127,0.28)',
  opacity: 0.85,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const

/** 「添加评论 / 改评论」入口：卡片里不想要一个抢眼的按钮，文字链就够。 */
const linkStyle = {
  marginTop: 4,
  padding: 0,
  fontSize: 11.5,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.7,
  cursor: 'pointer',
  textAlign: 'left',
} as const

const rowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 5,
  marginTop: 8,
} as const

/** 色块：颜色本身即标签，当前色用描边圈出来（禁用态也看得出选了哪个）。 */
const swatchStyle = {
  width: 16,
  height: 16,
  padding: 0,
  flexShrink: 0,
  borderRadius: 3,
  border: 'none',
  cursor: 'pointer',
} as const

const iconButtonStyle = {
  width: 20,
  height: 20,
  padding: 0,
  fontSize: 14,
  lineHeight: 1,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
} as const

const textareaStyle = {
  width: '100%',
  minHeight: 60,
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

const hintStyle = {
  marginTop: 4,
  fontSize: 10.5,
  lineHeight: 1.5,
  opacity: 0.6,
} as const

const footStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 8,
} as const

const smallButtonStyle = {
  ...SOFT_BUTTON_STYLE,
  height: 22,
  padding: '0 8px',
  fontSize: 11.5,
  lineHeight: 1.2,
  borderRadius: 5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

/** 删除的二次确认态：只换描边与文字色，不铺红底（深色主题下红底会糊成一块）。 */
const dangerStyle = {
  borderColor: 'rgba(217,83,79,0.7)',
  color: '#d9534f',
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
