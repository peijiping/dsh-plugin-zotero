/**
 * 微信式定格遮罩：位图铺底、拖拽框选、选区挖空、只有「取消 / 加入对话」两枚按钮。
 *
 * 挂在 `DocumentView` 的正文容器上（30px 工具条之下），所以截图范围天然只含文献
 * 正文，不含工具条与左上角悬浮按钮。zIndex 22 高于现有最大值 21。
 *
 * Esc / 取消由本组件自管，**不注册 `useDismiss`**：那会与其它浮层互相干扰。
 */

import { useEffect, useRef, useState, type PointerEvent, type ReactElement } from 'react'

import type { Translate } from '../../locales'
import { SOFT_BUTTON_CLASS, SOFT_BUTTON_STYLE } from '../../styles'
import type { ClientRect } from './types'
import { MIN_SELECTION_SIZE } from './types'

interface Props {
  t: Translate
  url: string
  width: number
  height: number
  selection: ClientRect | null
  busy: boolean
  onSelect(rect: ClientRect): void
  onCancel(): void
  onConfirm(): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function ScreenshotOverlay({
  t, url, width, height, selection, busy, onSelect, onCancel, onConfirm,
}: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const [draft, setDraft] = useState<ClientRect | null>(null)
  const shown = draft ?? selection

  // 遮罩自己管 Esc，避免与 useDismiss 的全局广播互相收起。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  function pointOf(event: PointerEvent<HTMLDivElement>): { x: number; y: number } {
    const rect = rootRef.current?.getBoundingClientRect()
    return {
      x: clamp(event.clientX - (rect?.left ?? 0), 0, width),
      y: clamp(event.clientY - (rect?.top ?? 0), 0, height),
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || busy) return
    event.preventDefault()
    const point = pointOf(event)
    dragRef.current = point
    setDraft({ left: point.x, top: point.y, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const start = dragRef.current
    if (start === null) return
    const point = pointOf(event)
    setDraft({
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    })
  }

  function releaseCapture(element: HTMLDivElement, pointerId: number): void {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null) return
    const point = pointOf(event)
    const start = dragRef.current
    dragRef.current = null
    setDraft(null)
    releaseCapture(event.currentTarget, event.pointerId)
    const rect = {
      left: Math.min(start.x, point.x),
      top: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    }
    // 已有选区时原地一点不该把它清掉（用户可能只是想接着看，或点偏了）。
    if (selection !== null && rect.width < MIN_SELECTION_SIZE && rect.height < MIN_SELECTION_SIZE) return
    onSelect(rect)
  }

  /** 指针被系统抢走（触控板手势、拖出窗口）当作放弃这次拖动，不确认选区。 */
  function onPointerCancel(event: PointerEvent<HTMLDivElement>): void {
    dragRef.current = null
    setDraft(null)
    releaseCapture(event.currentTarget, event.pointerId)
  }

  /** 按钮贴在选区下方，放不下时翻到上方；左右夹进遮罩内。 */
  const buttonTop = shown !== null
    ? (shown.top + shown.height + 34 > height ? Math.max(4, shown.top - 34) : shown.top + shown.height + 6)
    : 0
  const buttonLeft = shown !== null
    ? clamp(shown.left, 4, Math.max(4, width - 150))
    : 0

  return (
    <div
      ref={rootRef}
      style={rootStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onWheel={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <img src={url} alt="" draggable={false} style={imageStyle} />
      {/* 还没框选时整体压暗：画面一暗，用户立刻知道进了截图模式（微信同款手感）。
          有选区后由 `cutStyle` 的 boxShadow 接管四周压暗，这层就撤掉，避免叠加过黑。 */}
      {shown === null && <div style={dimStyle} aria-hidden="true" />}
      {shown !== null && shown.width > 0 && shown.height > 0 && (
        <div style={{ ...cutStyle, left: shown.left, top: shown.top, width: shown.width, height: shown.height }} />
      )}
      {shown === null && (
        <div style={hintStyle}>{t('shot.hint')}</div>
      )}
      {shown !== null && shown.width > 0 && shown.height > 0 && (
        <div
          style={{ ...actionsStyle, left: buttonLeft, top: buttonTop }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={SOFT_BUTTON_CLASS}
            style={{ ...buttonStyle, ...SOFT_BUTTON_STYLE }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onCancel}
            disabled={busy}
          >
            {t('note.cancel')}
          </button>
          <button
            type="button"
            className={SOFT_BUTTON_CLASS}
            style={{ ...buttonStyle, ...SOFT_BUTTON_STYLE }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onConfirm}
            disabled={busy}
          >
            {t('action.insertItemShort')}
          </button>
        </div>
      )}
    </div>
  )
}

const rootStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 22,
  overflow: 'hidden',
  cursor: 'crosshair',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  touchAction: 'none',
  color: 'CanvasText',
} as const

const imageStyle = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'fill',
  pointerEvents: 'none',
} as const

/** 未框选时的整体压暗层；与 `cutStyle` 的 boxShadow 用同一个暗度，切换时不跳。 */
const dimStyle = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0,0,0,0.42)',
  pointerEvents: 'none',
} as const

/** 一块 div 用超大 boxShadow 做「选区挖空 + 四周压暗」。 */
const cutStyle = {
  position: 'absolute',
  border: '1px solid #ffffff',
  boxShadow: '0 0 0 9999px rgba(0,0,0,0.42)',
  pointerEvents: 'none',
} as const

const hintStyle = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%,-50%)',
  padding: '6px 12px',
  borderRadius: 6,
  background: 'rgba(0,0,0,0.62)',
  color: '#ffffff',
  fontSize: 12,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
} as const

const actionsStyle = {
  position: 'absolute',
  display: 'flex',
  gap: 6,
  padding: 4,
  borderRadius: 6,
  background: 'Canvas',
  boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
} as const

const buttonStyle = {
  height: 24,
  padding: '0 10px',
  fontSize: 11.5,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  borderRadius: 5,
  cursor: 'pointer',
} as const
