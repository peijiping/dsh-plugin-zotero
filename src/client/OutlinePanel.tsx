/**
 * 左上角的**统一**目录浮层：PDF 书签、网页快照标题、笔记 / 全文标题都在这里。
 *
 * 按钮与「文献信息」并排（目录在左）；浮层本体画在右栏外面 —— 目录是一个要开着
 * 反复点的长列表，压在正文上会挡住正在读的那页。位置、拖动、缩放、按条目记忆
 * 都在 `floatingBox` 里（与信息浮层共用），这里只负责画目录。
 *
 * 标题栏右上角有**图钉**：钉住后点浮层外 / 点正文都不收（`useDismiss` 的
 * `pinned`），适合边读边导航；`Esc` 与再点一次目录按钮仍能收起。
 *
 * 目录数据一律由渲染器上报（见 `viewer/types.ts` 的 `onOutlineChange`），这里只负责画：
 * 面板不解释跳转目标，点一条就把 `target` 原样交回 `ItemDetail` 转给渲染器——
 * 于是 PDF 跳页、HTML 滚到标题可以共用同一份 UI。
 *
 * 点条目只跳转、不收起：浮层要留着让用户连点几条反复导航。
 *
 * 反向跟随：正文滚到哪里，对应那条自动高亮（渲染器上报下标，见 `onOutlineActiveChange`）。
 * 高亮行若滚出列表可视区，列表会把它带回来 —— 但用户刚自己拖过目录时先不动，
 * 免得抢滚动。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { useDismiss } from './dismiss'
import { useFloatingBox } from './floatingBox'
import { tpl, type Translate } from './locales'
import { ACCENT } from './styles'
import type { DocumentOutlineItem } from './viewer/types'

interface Props {
  t: Translate
  /** 条目 key：位置 / 尺寸按它各记一份，换一篇文献就是另一套摆法。 */
  itemKey: string
  /** `null` 表示还没读到（文档还在加载）；空数组表示这份文档没有标题 / 书签。 */
  items: DocumentOutlineItem[] | null
  /** 目录来源的一句说明：PDF 书签 / 网页标题 / 笔记标题 …，只作展示。 */
  sourceLabel: string
  /** 正文当前读到的那一条（下标）；`null` 表示没有可跟随的位置。 */
  activeIndex: number | null
  open: boolean
  onToggle(): void
  onClose(): void
  onJump(item: DocumentOutlineItem, index: number): void
}

/** 缩进宽度；层级再深也不再往外推，免得窄面板里标题全被挤成一点。 */
const INDENT = 13
const MAX_INDENT_DEPTH = 6

/** 初始宽度；左侧挤不下时由 `floatingBox` 收窄或退回右栏内。 */
const PANEL_WIDTH = 360
const PANEL_MIN_WIDTH = 260
const PANEL_MIN_HEIGHT = 200

/** 用户自己滚过目录后，这么久之内不再把高亮行带回可视区（别抢滚动）。 */
const FOLLOW_HOLD_MS = 2500

export function OutlinePanel({
  t,
  itemKey,
  items,
  sourceLabel,
  activeIndex,
  open,
  onToggle,
  onClose,
  onJump,
}: Props): ReactElement {
  /** 只包触发按钮：给 `useDismiss` 当「浮层内部」的第二个节点。 */
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  /** 测量基准：覆盖整个文献阅读区的透明容器。 */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 列表容器与每条行的节点：跟随高亮要按它们的实际位置算滚动。 */
  const listRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
  /** 用户最后一次自己动目录的时间戳（滚轮 / 拖滚动条 / 触摸）。 */
  const userScrollAt = useRef(0)
  const wasOpen = useRef(false)

  const [pinned, setPinned] = useState(false)
  /** 悬停行：内联 style 写不了 `:hover`，只能自己记一个下标。 */
  const [hovered, setHovered] = useState<number | null>(null)
  /** 悬停图钉：同上。 */
  const [pinHovered, setPinHovered] = useState(false)

  const box = useFloatingBox({
    open,
    anchorRef: rootRef,
    itemKey,
    kind: 'outline',
    width: PANEL_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
  })

  useDismiss(open, box.panelRef, onClose, { pinned, extraRef: triggerRef })

  /**
   * 跟随高亮：当前读到的那一条滚出列表可视区时，把它带回来。
   *
   * 用 `getBoundingClientRect` 算位置而不是 `offsetTop`：行的 offsetParent 是浮层
   * （`position: fixed`）而不是列表，两套坐标系不能混。也不用 `scrollIntoView` ——
   * 那个会连外层一起滚，浮层是 fixed 的，不该动到页面任何东西。
   *
   * 用户自己翻目录的那两秒半里不抢滚动（否则手指还在拖、列表却被拽走）；刚打开
   * 浮层时例外：直接把当前项摆到可见区，省得又得自己找。
   */
  useEffect(() => {
    const justOpened = open && !wasOpen.current
    wasOpen.current = open
    if (!open || activeIndex === null) return
    if (!justOpened && Date.now() - userScrollAt.current < FOLLOW_HOLD_MS) return
    const list = listRef.current
    const row = rowRefs.current[activeIndex]
    if (list === null || row === undefined || row === null) return
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const overflowTop = rowRect.top - listRect.top
    if (overflowTop >= 0 && rowRect.bottom <= listRect.bottom) return
    list.scrollTo({
      top: Math.max(0, list.scrollTop + overflowTop - list.clientHeight / 3),
      behavior: 'smooth',
    })
  }, [activeIndex, open, items])

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={t('outline.title')}
        title={t('outline.title')}
        style={{ ...triggerStyle, color: open ? ACCENT : 'CanvasText' }}
      >
        <ListIcon />
      </button>

      {open && box.style !== null && (
        <div
          ref={box.panelRef}
          role="dialog"
          aria-label={t('outline.title')}
          style={{ ...panelStyle, ...box.style }}
        >
          <div style={panelHeaderStyle} {...box.moveProps}>
            <span>{t('outline.title')}</span>
            {items !== null && items.length > 0 && (
              <span style={countStyle}>{tpl(t('outline.count'), { n: items.length })}</span>
            )}
            <span style={headerSpacerStyle} />
            <button
              type="button"
              aria-pressed={pinned}
              aria-label={pinned ? t('outline.unpin') : t('outline.pin')}
              title={pinned ? t('outline.unpin') : t('outline.pin')}
              onClick={() => setPinned((current) => !current)}
              onMouseEnter={() => setPinHovered(true)}
              onMouseLeave={() => setPinHovered(false)}
              style={{
                ...pinStyle,
                color: pinned ? ACCENT : 'CanvasText',
                opacity: pinned ? 1 : 0.5,
                background: pinHovered ? 'rgba(127,127,127,0.16)' : 'transparent',
              }}
            >
              <PinIcon filled={pinned} />
            </button>
          </div>
          <div style={sourceStyle}>{sourceLabel}</div>

          {items === null && <p style={emptyStyle}>{t('outline.loading')}</p>}

          {items !== null && items.length === 0 && <p style={emptyStyle}>{t('outline.empty')}</p>}

          {items !== null && items.length > 0 && (
            <div
              ref={listRef}
              style={listStyle}
              // 只认「用户自己动目录」的手势：跟随高亮引起的滚动不会触发这三个。
              onWheel={() => { userScrollAt.current = Date.now() }}
              onTouchStart={() => { userScrollAt.current = Date.now() }}
              onPointerDown={(event) => {
                // 点某一条是「跳转」，不是「我在翻目录」：别把它算成手动滚动，
                // 否则点完那两秒半里高亮跟不过来（比如滚轮接着往下读）。
                if ((event.target as HTMLElement | null)?.closest('button') != null) return
                userScrollAt.current = Date.now()
              }}
            >
              {items.map((item, index) => {
                const target = item.target
                const active = index === activeIndex
                const hint = target === null
                  ? item.title
                  : `${item.title}\n${target.kind === 'page'
                    ? tpl(t('outline.jump'), { page: target.page })
                    : t('outline.jumpHeading')}`
                return (
                  <button
                    key={`${index}-${item.title}`}
                    ref={(node) => { rowRefs.current[index] = node }}
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    disabled={target === null}
                    onClick={() => onJump(item, index)}
                    onMouseEnter={() => setHovered(index)}
                    onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
                    title={hint}
                    style={{
                      ...rowStyle,
                      ...(active ? activeRowStyle : null),
                      paddingLeft: 6 + Math.min(item.depth, MAX_INDENT_DEPTH) * INDENT,
                      opacity: target === null ? 0.5 : 1,
                      // 高亮压过悬停：悬停只是「要点这里」，高亮是「你正在这里读」。
                      background: active
                        ? ACTIVE_ROW_BACKGROUND
                        : hovered === index && target !== null
                          ? 'rgba(127,127,127,0.14)'
                          : 'transparent',
                      cursor: target === null ? 'default' : 'pointer',
                    }}
                  >
                    {item.title}
                  </button>
                )
              })}
            </div>
          )}

          <span
            aria-hidden="true"
            title={t('outline.resize')}
            {...box.resizeProps}
            style={resizeHandleStyle}
          >
            <ResizeIcon />
          </span>
        </div>
      )}
    </div>
  )
}

/** 目录图标：三行「圆点 + 横线」，比 `≡` 更像书签列表。 */
function ListIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {[2, 6, 10].map((y) => (
        <g key={y}>
          <circle cx="1.6" cy={y} r="0.9" fill="currentColor" />
          <rect x="4" y={y - 0.7} width="7" height="1.4" rx="0.7" fill="currentColor" />
        </g>
      ))}
    </svg>
  )
}

/** 图钉：帽 + 针。钉住时实心（`ACCENT`），未钉住只描边。 */
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

/**
 * 覆盖整个阅读区的透明层：只提供测量基准和浮层的层叠上下文。
 *
 * `zIndex` 是 300 —— 浮层要画到右栏外面（聊天区）去，得压过聊天消息与粘性输入区；
 * 又不该高过宿主的对话框（那类通常 ≥ 1000）。这一层不画东西、`pointerEvents:none`，
 * 抬高层级不会挡任何点击。
 */
const rootStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 300,
  pointerEvents: 'none',
} as const

/** 位置比「文献信息」按钮左一格（8 + 22 + 4），两个按钮并排。 */
const triggerStyle = {
  position: 'absolute',
  pointerEvents: 'auto',
  top: 4,
  left: 8,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  padding: 0,
  borderRadius: '50%',
  border: '1px solid rgba(127,127,127,0.4)',
  background: 'Canvas',
  color: 'CanvasText',
  cursor: 'pointer',
  boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
  zIndex: 21,
} as const

/** 右下角的缩放把手：两条 45° 短线，够小、不抢目录的视觉。 */
function ResizeIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M4.2 9 9 4.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7.4 9 9 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 面板本体：`fixed`，几何由 `floatingBox` 注入（`...box.style` 覆盖在最后）。
 *
 * `zIndex` 要压过聊天区（含输入框的粘性层），但不能高到盖住宿主自己的对话框
 * （设置页那类通常 ≥ 1000）。
 */
const panelStyle = {
  position: 'fixed',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: '8px 6px 6px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.32)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  fontSize: 12,
  lineHeight: 1.6,
  overscrollBehavior: 'contain',
  zIndex: 300,
} as const

/** 标题栏兼拖动把手：`cursor: move` 给个信号，拖动期间别顺手选中标题文字。 */
const panelHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
  padding: '0 4px 6px',
  marginBottom: 4,
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  fontWeight: 700,
  fontSize: 12.5,
  color: ACCENT,
  cursor: 'move',
  userSelect: 'none',
  touchAction: 'none',
} as const

/** 把图钉推到最右。 */
const headerSpacerStyle = {
  flex: 1,
} as const

const pinStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  transition: 'background-color 120ms ease',
} as const

const countStyle = {
  fontSize: 11,
  fontWeight: 400,
  opacity: 0.65,
} as const

/** 来源说明：三种文档解析出来的目录长得不一样，给用户一句口径。 */
const sourceStyle = {
  flexShrink: 0,
  padding: '0 4px 6px',
  fontSize: 11,
  opacity: 0.58,
} as const

const listStyle = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  overscrollBehavior: 'contain',
  /** 给右下角的缩放把手让位，最后一条别被它压住。 */
  paddingBottom: 8,
} as const

/** 缩放把手：贴在右下角，盖在列表之上。 */
const resizeHandleStyle = {
  position: 'absolute',
  right: 2,
  bottom: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  color: 'rgba(127,127,127,0.7)',
  cursor: 'nwse-resize',
  touchAction: 'none',
  userSelect: 'none',
} as const

const rowStyle = {
  display: 'block',
  width: '100%',
  padding: '3px 6px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
  lineHeight: 1.5,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const

/** 正在读的那一条：淡蓝底 + 左侧色条 + 蓝字加粗，蓝底见 {@link ACTIVE_ROW_BACKGROUND}。 */
const ACTIVE_ROW_BACKGROUND = 'rgba(80,140,255,0.14)'

const activeRowStyle = {
  color: ACCENT,
  fontWeight: 600,
  boxShadow: `inset 2px 0 0 ${ACCENT}`,
} as const

const emptyStyle = {
  margin: 0,
  padding: '6px 4px 8px',
  fontSize: 12,
  opacity: 0.72,
} as const
