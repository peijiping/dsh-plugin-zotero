/**
 * 全文选区浮动菜单：标注 / 复制 / 加入对话。
 *
 * PDF 与文本渲染器共用。两者传入的 x/y 都已经换算成各自内容根节点的坐标。
 * 按钮在 mousedown 时 preventDefault，避免浏览器先清掉选区导致后续取值失败。
 *
 * 传了 `annotate` 才出现标注那一排（写开关开着、且当前渲染的是 PDF）：色块点下去
 * 就是写入，类型 chip 只决定「点色块建的是高亮还是划线」，评论输入框默认收起 ——
 * 浮条飘在正文上，能少一个常驻控件就少一个。
 */

import { useState, type ReactElement } from 'react'

import { ANNOTATION_COLORS } from '../../zotero/palette'
import { writeClipboard } from '../clipboard'
import { showToast } from '../paneStore'
import { type Translate } from '../locales'
import {
  SOFT_BUTTON_ACTIVE_STYLE,
  SOFT_BUTTON_CLASS,
  SOFT_BUTTON_STYLE,
  softButtonClass,
} from '../styles'

/** 本插件能新建的标注类型，与 Zotero 阅读器浮条上的两个按钮同集合。 */
export type MarkType = 'highlight' | 'underline'

interface Annotate {
  /** 上一次写入还在路上：期间禁掉所有会落库的按钮。 */
  busy: boolean
  onCreate(type: MarkType, color: string, comment: string): void
}

/** 翻译入口：把原文与锚点交给渲染器，浮层由渲染器自己渲染。 */
interface TranslateAction {
  onTranslate(text: string, x: number, y: number): void
}

interface Props {
  t: Translate
  text: string
  x: number
  y: number
  onInsert(text: string): void
  onDismiss(): void
  annotate?: Annotate
  translate?: TranslateAction
}

export function SelectionBar({ t, text, x, y, onInsert, onDismiss, annotate, translate }: Props): ReactElement {
  const [type, setType] = useState<MarkType>('highlight')
  const [comment, setComment] = useState('')
  const [commentOpen, setCommentOpen] = useState(false)

  function finish(): void {
    window.getSelection()?.removeAllRanges()
    onDismiss()
  }

  function copy(): void {
    void writeClipboard(text).then((ok) => {
      showToast(t(ok ? 'toast.copied' : 'toast.copyFailed'))
    })
    finish()
  }

  /** 点色块：带着当前类型与评论草稿写入。 */
  function mark(color: string): void {
    if (annotate === undefined) return
    annotate.onCreate(type, color, comment.trim())
  }

  function chipButton(value: MarkType): ReactElement {
    const active = type === value
    return (
      <button
        type="button"
        className={softButtonClass(active)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setType(value)}
        disabled={annotate?.busy === true}
        style={{ ...chipStyle, ...(active ? chipActiveStyle : null) }}
      >
        {t(value === 'highlight' ? 'annotation.type.highlight' : 'annotation.type.underline')}
      </button>
    )
  }

  return (
    <div style={{ ...barStyle, left: x, top: y }}>
      {annotate !== undefined && (
        <div style={groupStyle}>
          {chipButton('highlight')}
          {chipButton('underline')}
          {ANNOTATION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => mark(color)}
              disabled={annotate.busy}
              title={t('annotation.markHint')}
              style={{ ...swatchStyle, background: color }}
              aria-label={color}
            />
          ))}
          <button
            type="button"
            className={softButtonClass(commentOpen)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCommentOpen((open) => !open)}
            style={{ ...chipStyle, ...(commentOpen ? chipActiveStyle : null) }}
            title={t('annotation.commentQuick')}
          >
            {t('annotation.commentQuickShort')}
          </button>
        </div>
      )}
      {annotate !== undefined && commentOpen && (
        <div style={commentRowStyle}>
          <input
            value={comment}
            placeholder={t('annotation.commentQuickPlaceholder')}
            onChange={(event) => setComment(event.target.value)}
            // 回车等于「用默认黄把这条选区标掉」，与点色块同一动作。
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              mark(ANNOTATION_COLORS[0])
            }}
            onMouseDown={(event) => event.stopPropagation()}
            style={commentInputStyle}
            aria-label={t('annotation.comment')}
          />
        </div>
      )}
      <div style={groupStyle}>
        <button type="button" className={SOFT_BUTTON_CLASS} onClick={copy} style={buttonStyle}>
          {t('action.copy')}
        </button>
        {translate !== undefined && (
          <button
            type="button"
            className={SOFT_BUTTON_CLASS}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              translate.onTranslate(text, x, y)
              // 浮条与译文框都贴着选区，留着会互相压住：点完就收。
              finish()
            }}
            style={buttonStyle}
          >
            {t('action.translate')}
          </button>
        )}
        <button
          type="button"
          className={SOFT_BUTTON_CLASS}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onInsert(text)
            finish()
          }}
          style={buttonStyle}
        >
          {t('action.insertItemShort')}
        </button>
      </div>
    </div>
  )
}

const barStyle = {
  position: 'absolute',
  transform: 'translate(-50%, -130%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  zIndex: 8,
} as const

const groupStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  overflow: 'hidden',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
  padding: '2px 3px',
  fontSize: 12,
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
} as const

const buttonStyle = {
  ...SOFT_BUTTON_STYLE,
  padding: '3px 8px',
  borderRadius: 5,
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

const chipStyle = {
  ...SOFT_BUTTON_STYLE,
  padding: '2px 6px',
  borderRadius: 5,
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

const chipActiveStyle = SOFT_BUTTON_ACTIVE_STYLE

const swatchStyle = {
  width: 15,
  height: 15,
  padding: 0,
  border: '1px solid rgba(0,0,0,0.25)',
  borderRadius: 4,
  cursor: 'pointer',
} as const

const commentRowStyle = {
  display: 'flex',
  width: 'min(240px, 78vw)',
} as const

const commentInputStyle = {
  flex: 1,
  minWidth: 0,
  padding: '3px 6px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
} as const
