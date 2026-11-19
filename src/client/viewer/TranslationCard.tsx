/**
 * 划词翻译结果浮层。
 *
 * 形态上照 `AnnotationCard`（`Canvas` 底色、可拖动的标题栏），但定位用 `fixed`：
 * 译文往往比选区宽，压住正文时得能拖开，**而且要和目录浮层一样能拖出右栏、压到聊天区上**。
 * 早先按渲染器容器 `absolute` 定位，拖到右栏边界就被夹住，窄栏里长译文根本摆不开。
 * `fixed` 天然不受渲染器滚动 / 裁剪影响：继续读正文时浮层也不会跟着滚走。
 *
 * 正文是**左右双栏**：左原文、右译文，各自独立滚动，中间一条明显可见的竖分割线。
 * 早先的「上摘要 + 下译文」用一条几乎看不见的细线分隔，长段落对照时很难分界。
 *
 * 关闭有三个入口：标题栏右侧的 ×、Esc、点击框外 —— 后两个都由 `useDismiss` 统一处理，
 * 不要另外挂 pointerdown（拖动发生在框内，天然不算「点外」）。钉住后「点击框外」这一路
 * 被关掉（Esc 与 × 仍可用）：浮层挪到右栏外就是为了边读边对照，点正文不该顺手收走它。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'

import { writeClipboard } from '../clipboard'
import { useDismiss } from '../dismiss'
import { WINDOW_DRAG_EXCLUDE } from '../floatingBox'
import { type Translate } from '../locales'
import { showToast } from '../paneStore'
import { SOFT_BUTTON_CLASS, SOFT_BUTTON_STYLE, ACCENT } from '../styles'
import type { EngineChoice, TranslationView } from './useTranslation'

interface Props {
  t: Translate
  view: TranslationView
  /** 渲染器内容区的尺寸：只用来定初始大小（默认宽度别撑出右栏）。 */
  bounds: { width: number; height: number }
  /** 当前选择的引擎（`default` = 跟随设置页的默认引擎）。 */
  engine: EngineChoice
  /** 换引擎：由 useTranslation 立刻用新引擎重译当前选区。 */
  onEngineChange(engine: EngineChoice): void
  onClose(): void
  onRetry(): void
  /** 「加入对话」：原文 + 译文一起交给上层插 chip。 */
  onInsert(quote: string, translated: string): void
}

/** 与边框留的缝隙，贴边时不至于压住滚动条。 */
const EDGE = 6

/** 默认尺寸：左右双栏各要放得下几行字，宽度比首版单栏时放宽一截。 */
const DEFAULT_WIDTH = 600
const DEFAULT_HEIGHT = 420

/** 拖到多小就不许再小：两栏各留够一行字的宽度，按钮也别换行。 */
const MIN_WIDTH = 320
const MIN_HEIGHT = 180

/** 浮层根节点的标记：渲染器判定「这次选区是不是落在浮层里」用。 */
const MARK = 'data-zp-translate'

/**
 * 选区是否落在译文浮层里。
 *
 * 文本渲染器的 `onMouseUp` 挂在整个滚动容器上，浮层也在里面 —— 用户在译文里拖选
 * 复制时不该被当成本文选区再弹一次工具条。
 */
export function isInsideTranslation(node: Node | null): boolean {
  if (node === null) return false
  const element = node instanceof Element ? node : node.parentElement
  if (element === null) return false
  return element.closest(`[${MARK}]`) !== null
}

export function TranslationCard(
  { t, view, bounds, engine, onEngineChange, onClose, onRetry, onInsert }: Props,
): ReactElement {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ px: number; py: number; left: number; top: number } | null>(null)
  const resizeRef = useRef<{ px: number; py: number; width: number; height: number } | null>(null)
  const [size, setSize] = useState(() => defaultSize(bounds))
  // 首帧拿不到父节点，先按「选区坐标当视口坐标」摆一个，紧接着的 layout effect
  // 在绘制前换算成真正的视口坐标，不会闪。
  const [pos, setPos] = useState(() => anchor({ x: view.x, y: view.y }, defaultSize(bounds)))
  /** 新选区进来时按当前尺寸重新摆位，但别把用户拖出来的尺寸重置回默认。 */
  const sizeRef = useRef(size)
  sizeRef.current = size
  /** 事件回调 / 监听器里读当前几何，避免闭包拿到旧值。 */
  const posRef = useRef(pos)
  posRef.current = pos

  // 换了一段选区（同一浮层复用）时回到新锚点；状态变化（loading → done）不动它。
  // 选区坐标是「渲染器内容坐标」（文本渲染器还带滚动偏移），这里换算成视口坐标 ——
  // 浮层是 fixed 的，只有视口坐标才拖得出右栏。
  useLayoutEffect(() => {
    setPos(anchor(anchorPoint(cardRef.current, view), sizeRef.current))
  }, [view.text, view.x, view.y]) // eslint-disable-line react-hooks/exhaustive-deps

  // 窗口尺寸变了就把浮层收回可视区：拖到窗口边缘的卡片不该半截留在外面。
  useEffect(() => {
    const onResize = (): void => {
      const nextSize = clampSize(sizeRef.current.width, sizeRef.current.height, posRef.current)
      setSize(nextSize)
      setPos(clampPos(posRef.current, nextSize))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 钉住后点正文 / 点别处都不收，方便边读边对照。 */
  const [pinned, setPinned] = useState(false)

  useDismiss(true, cardRef, onClose, { pinned })

  const [active, setActive] = useState(false)

  function onHandleDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    setActive(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { px: event.clientX, py: event.clientY, left: pos.left, top: pos.top }
  }

  function onHandleMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (drag === null) return
    setPos(clampPos(
      { left: drag.left + event.clientX - drag.px, top: drag.top + event.clientY - drag.py },
      sizeRef.current,
    ))
  }

  function onHandleUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null) return
    dragRef.current = null
    setActive(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function onResizeDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeRef.current = { px: event.clientX, py: event.clientY, width: size.width, height: size.height }
  }

  function onResizeMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current
    if (drag === null) return
    setSize(clampSize(
      drag.width + event.clientX - drag.px,
      drag.height + event.clientY - drag.py,
      posRef.current,
    ))
  }

  function onResizeUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resizeRef.current === null) return
    resizeRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function copy(): void {
    const text = view.result?.text
    if (text === undefined) return
    void writeClipboard(text).then((ok) => {
      showToast(t(ok ? 'translate.copied' : 'toast.copyFailed'))
    })
  }

  function insert(): void {
    const text = view.result?.text
    if (text === undefined) return
    onInsert(view.text, text)
    onClose()
  }

  const engineLabel = view.result === undefined ? undefined : t(`translate.engine.${view.result.provider}`)
  // 自动判向后在栏目标题上标出**实际**译入的语言，让「中→英 / 英→中」一眼可见。
  const target = view.result?.target
  const targetLabel = target === undefined ? undefined : targetName(t, target)

  return (
    <div
      ref={cardRef}
      {...{ [MARK]: '' }}
      {...WINDOW_DRAG_EXCLUDE}
      style={{ ...cardStyle, width: size.width, height: size.height, left: pos.left, top: pos.top }}
      role="dialog"
      aria-label={t('translate.title')}
    >
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        style={{ ...handleStyle, cursor: active ? 'grabbing' : 'move' }}
        title={t('translate.dragHint')}
      >
        <span style={titleStyle}>
          {t('translate.title')}
          {/* 徽标是**实际**引擎：选了精翻但模型通道不可用时，这里会显示回落后的 Bing。 */}
          {engineLabel === undefined
            ? null
            : <span style={engineStyle} title={t('translate.engine.actualHint')}>{engineLabel}</span>}
        </span>
        {/*
          引擎下拉放在标题栏上：换引擎立刻重译，不必关掉浮层跑去设置页。
          标题栏整体是拖动把手，所以必须掐掉 pointerdown 冒泡，否则下拉点不开。
        */}
        <select
          value={engine}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'default' || value === 'bing' || value === 'deepseek') onEngineChange(value)
          }}
          style={engineSelectStyle}
          aria-label={t('translate.engine.label')}
          title={t('translate.engine.hint')}
        >
          <option value="default">{t('translate.engine.default')}</option>
          <option value="bing">{t('translate.provider.bing')}</option>
          <option value="deepseek">{t('translate.provider.deepseek')}</option>
        </select>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? t('translate.unpin') : t('translate.pin')}
          title={pinned ? t('translate.unpin') : t('translate.pin')}
          // 别让图钉顺手把标题栏的拖动也点起来。
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setPinned((value) => !value)}
          style={{
            ...pinStyle,
            color: pinned ? ACCENT : 'inherit',
            opacity: pinned ? 1 : 0.55,
          }}
        >
          <PinIcon filled={pinned} />
        </button>
        <button
          type="button"
          // 别让 × 顺手把标题栏的拖动也点起来。
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          style={closeStyle}
          aria-label={t('action.close')}
          title={t('action.close')}
        >
          ×
        </button>
      </div>

      {/*
        左右双栏：两栏各自吃掉一半宽度、各自滚动；中间那条 2px 竖线是正文区里
        唯一的分隔元素，不靠细边框/留白暗示（早期版本那样几乎看不见）。
      */}
      <div style={columnsStyle}>
        <div style={paneStyle}>
          <div style={paneHeaderStyle}>{t('translate.original')}</div>
          <div style={paneTextStyle}>{view.text}</div>
        </div>

        <div style={dividerStyle} role="separator" aria-orientation="vertical" />

        <div style={paneStyle}>
          <div style={paneHeaderStyle}>
            {t('translate.translation')}
            {targetLabel === undefined ? null : <span style={paneBadgeStyle}>{targetLabel}</span>}
          </div>
          {/*
            状态区恒占满剩余高度：拉大卡片时译文跟着长，而不是留一大片空白。
            加载 / 错误态没有可滚动内容，用 auto 外边距在中间竖直居中。
          */}
          <div style={bodyStyle}>
            {view.status === 'loading' && <div style={statusStyle}>{t('translate.loading')}</div>}
            {view.status === 'error' && <div style={errorStyle}>{view.error ?? t('translate.failed')}</div>}
            {view.status === 'done' && view.result !== undefined && (
              <div style={paneTextStyle}>{view.result.text}</div>
            )}
          </div>
        </div>
      </div>

      <div style={footerStyle}>
        {view.status === 'error' && (
          <button type="button" className={SOFT_BUTTON_CLASS} onClick={onRetry} style={buttonStyle}>
            {t('translate.retry')}
          </button>
        )}
        <button
          type="button"
          className={SOFT_BUTTON_CLASS}
          onClick={copy}
          disabled={view.status !== 'done'}
          style={buttonStyle}
        >
          {t('translate.copy')}
        </button>
        <button
          type="button"
          className={SOFT_BUTTON_CLASS}
          onClick={insert}
          disabled={view.status !== 'done'}
          style={buttonStyle}
        >
          {t('action.insertItemShort')}
        </button>
      </div>

      {/* 右下角缩放把手：只有这里能改尺寸，正文区域留给选中复制。 */}
      <div
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        style={resizeHandleStyle}
        title={t('translate.resizeHint')}
        aria-label={t('translate.resizeHint')}
        role="separator"
      />
    </div>
  )
}

/**
 * 初始落点：优先贴在选区下方 14px，其次上方，两边都放不下就贴底（别跑出视口）。
 *
 * `point` 已经是**视口坐标**，`size` 用当前实际尺寸 —— 卡片可能已经被拉大，
 * 估值会让它一半露在视口外。
 */
function anchor(
  point: { x: number; y: number },
  size: { width: number; height: number },
): { left: number; top: number } {
  const view = viewportSize()
  const below = point.y + 14
  const above = point.y - size.height - 14
  const maxTop = view.height - size.height - EDGE
  let top: number
  if (below + size.height <= view.height - EDGE) top = below
  else if (above >= EDGE) top = above
  // 大卡片在矮窗口里两边都塞不下：贴底，至少标题栏和翻页按钮都在视野里。
  else top = Math.min(Math.max(below, EDGE), Math.max(EDGE, maxTop))
  return {
    left: clamp(point.x - size.width / 2, EDGE, view.width - size.width - EDGE),
    top: clamp(top, EDGE, maxTop),
  }
}

/**
 * 选区锚点换算：渲染器给的 `x` / `y` 是**内容坐标**（文本渲染器还叠加了滚动偏移），
 * 而浮层是 `fixed` 的，得加上渲染器根节点的视口位置、再减掉它的滚动量。
 *
 * 根节点就是浮层的父元素：三种渲染器都把浮层直接挂在各自的根容器里。
 */
function anchorPoint(
  node: HTMLElement | null,
  view: TranslationView,
): { x: number; y: number } {
  const parent = node?.parentElement
  if (parent === null || parent === undefined) return { x: view.x, y: view.y }
  const rect = parent.getBoundingClientRect()
  return {
    x: rect.left + view.x - parent.scrollLeft,
    y: rect.top + view.y - parent.scrollTop,
  }
}

/** 可用范围 = 整个窗口：浮层允许拖出右栏，压到聊天区上（与目录浮层一致）。 */
function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 默认尺寸：比单栏版更宽，够两栏各铺开一段长摘录 / 整段译文；仍以右栏宽度为上限。 */
function defaultSize(bounds: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(MIN_WIDTH, Math.min(DEFAULT_WIDTH, bounds.width - EDGE * 2)),
    height: Math.max(MIN_HEIGHT, Math.min(DEFAULT_HEIGHT, bounds.height - EDGE * 2)),
  }
}

/** 位置夹在窗口内，别把浮层拖到看不见的地方。 */
function clampPos(
  pos: { left: number; top: number },
  size: { width: number; height: number },
): { left: number; top: number } {
  const view = viewportSize()
  return {
    left: clamp(pos.left, EDGE, view.width - size.width - EDGE),
    top: clamp(pos.top, EDGE, view.height - size.height - EDGE),
  }
}

/** 缩放时同时受下限与「别越出窗口」约束（右下角只往外拉，左上角不动）。 */
function clampSize(
  width: number,
  height: number,
  pos: { left: number; top: number },
): { width: number; height: number } {
  const view = viewportSize()
  const maxWidth = Math.max(MIN_WIDTH, view.width - pos.left - EDGE)
  const maxHeight = Math.max(MIN_HEIGHT, view.height - pos.top - EDGE)
  return {
    width: Math.min(Math.max(width, MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(height, MIN_HEIGHT), maxHeight),
  }
}

function clamp(value: number, min: number, max: number): number {
  // 容器比浮层还小时 min 会大于 max，此时贴左上角比负值更合理。
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** 设置页下拉里出现过的具体语言；手改配置写进来的野值直接显示原始 tag。 */
const KNOWN_TARGETS = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'ru'])

function targetName(t: Translate, target: string): string {
  return KNOWN_TARGETS.has(target) ? t(`translate.target.${target}`) : target
}

const cardStyle = {
  // 视口定位（不是渲染器容器）：能和目录浮层一样拖出右栏、压到聊天区上。
  position: 'fixed',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  padding: '6px 8px 8px',
  borderRadius: 8,
  background: 'Canvas',
  color: 'CanvasText',
  border: '1px solid rgba(127,127,127,0.32)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
  // 与目录浮层同一层级：要压过聊天消息与粘性输入区，又不高过宿主对话框（≥1000）。
  zIndex: 300,
  fontSize: 12,
  lineHeight: 1.6,
  textAlign: 'left',
} as const

const handleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '1px 2px 5px',
  marginBottom: 5,
  borderBottom: '1px solid rgba(127,127,127,0.22)',
  userSelect: 'none',
  touchAction: 'none',
} as const

const titleStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 1,
  minWidth: 0,
  fontWeight: 600,
  color: 'light-dark(#2c3e63, #d5dced)',
} as const

const engineStyle = {
  padding: '0 5px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.35)',
  fontSize: 11,
  fontWeight: 400,
  color: 'var(--dsw-alias-label-secondary, GrayText)',
  whiteSpace: 'nowrap',
} as const

/** 标题栏里的引擎下拉：原生 select，配色随宿主明暗主题。 */
const engineSelectStyle = {
  flex: 'none',
  height: 20,
  maxWidth: 170,
  padding: '0 2px',
  border: '1px solid rgba(127,127,127,0.35)',
  borderRadius: 5,
  fontSize: 11,
  background: 'Canvas',
  color: 'CanvasText',
  cursor: 'pointer',
} as const

/** 图钉：帽 + 针；钉住时实心（`ACCENT`），未钉住只描边。与目录浮层同形。 */
function PinIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M4.5 1.6h3l-.55 3.05L8.5 6.2v1.15h-5V6.2L5.05 4.65z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
      <path d="M6 7.55v2.9" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
    </svg>
  )
}

/** 标题栏里的图钉按钮：与 × 同尺寸，别把标题挤窄。 */
const pinStyle = {
  flex: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  cursor: 'pointer',
} as const

const closeStyle = {
  flex: 'none',
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  fontSize: 14,
  lineHeight: 1,
  cursor: 'pointer',
} as const

/** 双栏容器：吃掉标题栏与底部按钮之外的全部高度。 */
const columnsStyle = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
  flex: 1,
  minHeight: 0,
} as const

/** 单栏：等分宽度，内容超高时只在自己这一栏里滚。 */
const paneStyle = {
  display: 'flex',
  flexDirection: 'column',
  flex: '1 1 0',
  minWidth: 0,
  minHeight: 0,
} as const

const paneHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 'none',
  paddingBottom: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--dsw-alias-label-secondary, GrayText)',
  userSelect: 'none',
} as const

/** 右栏标题后的目标语言徽标：自动判向时显示实际译入的语言。 */
const paneBadgeStyle = {
  padding: '0 4px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.35)',
  fontSize: 10,
  fontWeight: 400,
  letterSpacing: 0,
  whiteSpace: 'nowrap',
} as const

/**
 * 中间竖分割线：2px 实色 + 两侧留白。
 * 别退回 1px 半透明灰 —— 在浅色底上几乎看不见，这正是要修的问题。
 */
const dividerStyle = {
  flex: 'none',
  width: 2,
  alignSelf: 'stretch',
  margin: '0 12px',
  borderRadius: 1,
  background: 'light-dark(#8593a8, #78859a)',
} as const

/** 右栏正文区：吃掉栏目标题之外的全部高度。 */
const bodyStyle = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
} as const

/** 原文 / 译文共用：从栏顶开始铺，长文本在本栏内滚动。 */
const paneTextStyle = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const

const statusStyle = {
  // auto 上下外边距 = 在这块空区域里竖直居中。
  margin: 'auto 0',
  padding: '6px 0',
  color: 'var(--dsw-alias-label-secondary, GrayText)',
} as const

const errorStyle = {
  margin: 'auto 0',
  padding: '6px 0',
  color: 'light-dark(#b3261e, #f2b8b5)',
} as const

const footerStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 4,
  marginTop: 6,
  // 给右下角的缩放把手让出位置，否则按钮会压在把手上。
  paddingRight: 10,
} as const

/** 右下角缩放把手：两条斜线示意「可以拉」，命中区比图形略大。 */
const resizeHandleStyle = {
  position: 'absolute',
  right: 0,
  bottom: 0,
  width: 16,
  height: 16,
  cursor: 'nwse-resize',
  touchAction: 'none',
  borderBottomRightRadius: 8,
  backgroundImage:
    'linear-gradient(135deg, transparent 0 46%, rgba(127,127,127,0.55) 46% 52%, transparent 52% 64%, rgba(127,127,127,0.55) 64% 70%, transparent 70%)',
} as const

const buttonStyle = {
  ...SOFT_BUTTON_STYLE,
  padding: '2px 8px',
  borderRadius: 5,
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const
