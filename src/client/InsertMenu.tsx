/**
 * 「加入对话」分裂按钮 + 插入方式菜单。
 *
 * 为什么不是一排并列按钮：`全文` / `截图加入对话` 与主操作同权重挂在标题行上，
 * 每多一枚就多压掉一截标题（见 `--dsh-zp-topbar-pad`），而它们的使用频率远低于
 * 主操作。收进一枚带箭头的按钮后，标题行只剩一个控件，插整篇全文从 4 次点击
 * （全文 → 更多方式 → 整篇 → 加入对话）降到 2 次。
 *
 * 菜单第一项刻意与主按钮重复，写全文案「插入文献信息」：主按钮上只有「加入对话」
 * 四个字，不说清插的是什么；展开后给一个显式入口，不必让用户去猜。
 *
 * 菜单用绝对定位挂在行内（`position: absolute`），**不走 portal** —— client bundle
 * 里没有 `react-dom`。因此必须铺 {@link WINDOW_DRAG_EXCLUDE}：宿主把窗口拖拽区
 * 打成了一整行 chrome，压在那行像素上的自有元素不挖掉，拖菜单就会变成拖整个 DSH
 * 窗口。同理别指望 ARIA 角色豁免。
 *
 * 键盘：打开即聚焦第一项，↑↓ 循环，`Esc` 关（`useDismiss`），`Tab` 出菜单。
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import { useDismiss } from './dismiss'
import { WINDOW_DRAG_EXCLUDE } from './floatingBox'
import type { Translate } from './locales'
import { tpl } from './locales'
import { ACCENT, MENU_ITEM_CLASS, SOFT_BUTTON_CLASS, SOFT_BUTTON_STYLE } from './styles'

/**
 * 菜单宽度：五条中文项 + 行尾的两行小字（字数 / token，含「已截断」）刚好放下，
 * 再宽就压到正文上了。英文的「first 204,800 chars · truncated」比中文长一截，
 * 312 是两种语言都不至于把「已截断 / truncated」吃掉的最小值。
 */
const MENU_WIDTH = 312

/** 可聚焦项：禁用的项要跳过，否则 ↑↓ 会停在一条点不动的行上。 */
const SELECTABLE = '[role="menuitem"]:not([disabled])'

/**
 * 悬停说明的宽度。五个入口的区别不是三五个字能说清的（「整篇全文」和「按章节
 * 选择」都叫全文相关的名字），一句 25~35 字的中文在这里正好排 3 行；再宽就压到
 * 正文上了。
 */
const TIP_WIDTH = 236

/** 提示与菜单行之间留的空：贴着行会让人觉得它还属于那一行。 */
const TIP_GAP = 8

/** 悬停说明的载荷：文案 + 可选补充行 + 被悬停那一行的视口矩形。 */
interface TipPayload {
  text: string
  note?: string
  rect: DOMRect
}

/** 落位后的提示（坐标已换算成相对菜单的偏移，见 `showTip`）。 */
interface TipState {
  text: string
  note?: string
  left: number
  top: number
}

interface Props {
  t: Translate
  /**
   * 独立笔记：主按钮插笔记正文，菜单里不出现全文那三项（笔记没有全文索引、
   * 也没有章节可解析），但截图仍可用 —— 笔记渲染器支持取景框。
   */
  selfNote: boolean
  hasFulltext: boolean
  /** 实际能取到的正文字数（被截断时就是上限值），显示在「整篇全文」右边。 */
  fulltextChars: number
  /**
   * 全文被索引上限截断：字数前面要写「前 N 字」再加「已截断」，否则「204,800 字」
   * 会被当成全文长度。
   */
  fulltextTruncated: boolean
  /**
   * 整篇大概吃多少 token，作为「整篇全文」那一行的第二行。
   *
   * 放这里而不是浮层：整篇是点一下直插的，浮层里再算一遍就等于逼用户先点开、
   * 切方式、看一眼再关；而且字数已经在浮层与菜单各写一遍了，token 跟着同一行
   * 眼不用挪就知道成本。0 表示没算出来（没有全文），不显示这一行。
   */
  fulltextTokens: number
  /**
   * 目录解析出的章节数，显示在「按章节选择」右边。
   *
   * `0` 表示这份文档确实没有章节 → 该项置灰（点进去只会看到一句「没有可解析的章节」）；
   * `null` 表示目录还没解析出来（刚切文献的一瞬）→ 先别判死，保持可点。
   */
  chapterCount: number | null
  /** 主按钮：插文献信息 / 笔记正文。 */
  onCite(): void
  /** 整篇全文直插，不弹浮层。 */
  onInsertWhole(): void
  onPickChapters(): void
  onPickRanges(): void
  onScreenshot(): void
  screenshotAvailable: boolean
  screenshotReason: string
  /** 菜单开合：InfoPanel 据此收起信息浮层，避免两块浮层打架。 */
  onMenuOpenChange?(open: boolean): void
  /** 顺手交给全文浮层当 `triggerRef`：点它不该被算成「点外面」。 */
  triggerRef?: { current: HTMLSpanElement | null }
}

export function InsertMenu({
  t,
  selfNote,
  hasFulltext,
  fulltextChars,
  fulltextTruncated,
  fulltextTokens,
  chapterCount,
  onCite,
  onInsertWhole,
  onPickChapters,
  onPickRanges,
  onScreenshot,
  screenshotAvailable,
  screenshotReason,
  onMenuOpenChange,
  triggerRef,
}: Props): ReactElement {
  const groupRef = useRef<HTMLSpanElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  /** 菜单相对按钮的左偏移；只在右侧放不下时变成负值（见下面的量算）。 */
  const [shift, setShift] = useState(0)
  /** 当前悬停行的说明；`null` = 没停在任何行上。 */
  const [tip, setTip] = useState<TipState | null>(null)
  /** 延迟清除的定时器（见 `showTip`），换行时先撤掉上一枚。 */
  const tipTimerRef = useRef<number | null>(null)

  const attachGroup = (node: HTMLSpanElement | null): void => {
    groupRef.current = node
    if (triggerRef !== undefined) triggerRef.current = node
  }

  useDismiss(open, menuRef, () => setOpen(false), { extraRef: groupRef })

  /** 只在开合真的变化时通知：父组件的回调是内联箭头，每帧都新。 */
  const notifiedRef = useRef(open)
  useEffect(() => {
    if (notifiedRef.current === open) return
    notifiedRef.current = open
    onMenuOpenChange?.(open)
  }, [open, onMenuOpenChange])

  /**
   * 右栏被拖得很窄时，296px 的菜单从按钮左边缘展开会溢到窗口外被裁掉。
   * 打开那一刻量一次，放不下就整体左移贴住窗口右边界 —— 行本身不滚动，
   * 窗口 resize 期间会直接收起菜单（见下一个 effect），不需要持续跟随。
   */
  useLayoutEffect(() => {
    if (!open) return
    const node = groupRef.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    const overflow = rect.left + MENU_WIDTH - (window.innerWidth - 8)
    setShift(overflow > 0 ? -overflow : 0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [open])

  // 打开即把焦点交给第一条能点的项：键盘用户不必先 Tab 一轮。
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>(SELECTABLE)?.focus()
  }, [open])

  // 菜单一收，说明没有归属方了：留着会在下次打开时闪在旧位置。
  useEffect(() => {
    if (open) return
    if (tipTimerRef.current !== null) {
      window.clearTimeout(tipTimerRef.current)
      tipTimerRef.current = null
    }
    setTip(null)
  }, [open])

  /**
   * 悬停说明落位。
   *
   * 优先放行的右侧（视线顺着行尾走，离菜单也近）；右栏被拖窄、右侧放不下时翻到
   * 左侧，再不够就贴住窗口边。垂直顶对齐行首而不是居中：菜单贴着顶部工具条，
   * 居中的话第一行的提示会有一半越出窗口上沿。
   *
   * 坐标换算成相对菜单的偏移（提示是菜单的绝对定位子节点）：菜单自身是 `absolute`，
   * 用 `fixed` 会跟着祖先的 `transform` 跑偏。
   */
  const showTip = (payload: TipPayload | null): void => {
    if (tipTimerRef.current !== null) {
      window.clearTimeout(tipTimerRef.current)
      tipTimerRef.current = null
    }
    if (payload === null) {
      // 鼠标从一行滑到下一行要穿过分隔线（先 leave 后 enter）：立刻清会让提示闪一下。
      tipTimerRef.current = window.setTimeout(() => {
        tipTimerRef.current = null
        setTip(null)
      }, 60)
      return
    }
    const menuRect = menuRef.current?.getBoundingClientRect()
    if (menuRect === undefined) return
    const { rect } = payload
    const roomRight = window.innerWidth - rect.right - TIP_GAP - 8
    const left = roomRight >= TIP_WIDTH
      ? rect.right + TIP_GAP
      : Math.max(8, rect.left - TIP_GAP - TIP_WIDTH)
    // 贴着窗口下沿时上提：提示比一行高，按行首顶对齐会掉出可视区。
    const top = Math.max(8, Math.min(rect.top - 2, window.innerHeight - 150))
    setTip({ text: payload.text, note: payload.note, left: left - menuRect.left, top: top - menuRect.top })
  }

  const run = (action: () => void) => (): void => {
    setOpen(false)
    action()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(SELECTABLE) ?? [])]
    if (items.length === 0) return
    const current = items.findIndex((node) => node === document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = current < 0 ? 0 : (current + step + items.length) % items.length
    items[next]?.focus()
  }

  const fulltextDisabled = !hasFulltext
  /** 没有章节的文档：入口直接置灰，别让人点开浮层才看到「没有可解析的章节」。 */
  const chaptersUnavailable = chapterCount === 0
  const chaptersDisabled = fulltextDisabled || chaptersUnavailable

  /**
   * 「整篇全文」右侧的两行小字：字数（截断时写「前 N 字 · 已截断」）在上，
   * token 粗估在下。
   *
   * 不挤成一行：中文里「前 204,800 字 · 已截断 · 约 86,000 token」会把菜单撑到
   * 正文上，英文更放不下；分两行后两边的字都能完整读，行高也在 30px 内。
   */
  const wholeCharsHint = fulltextTruncated
    ? `${tpl(t('insert.menu.charsTruncated'), { n: fulltextChars.toLocaleString() })} · ${t('insert.menu.truncated')}`
    : tpl(t('insert.menu.chars'), { n: fulltextChars.toLocaleString() })
  const wholeTokensHint = fulltextTokens > 0
    ? tpl(t('fulltext.tokens'), { n: fulltextTokens.toLocaleString() })
    : undefined

  return (
    <span style={wrapStyle}>
      <span ref={attachGroup} className={SOFT_BUTTON_CLASS} style={groupStyle}>
        <button
          type="button"
          onClick={() => {
            // 菜单开着时点主按钮：插完顺手收起，别让下拉挡在正文上。
            setOpen(false)
            onCite()
          }}
          title={selfNote ? t('action.insertNote') : t('action.insertItem')}
          style={mainStyle}
        >
          {t('action.insertItemShort')}
        </button>
        <span style={dividerStyle} aria-hidden="true" />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('insert.menu.label')}
          title={t('insert.menu.label')}
          style={caretStyle}
        >
          <CaretIcon />
        </button>
      </span>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('insert.menu.label')}
          onKeyDown={handleKeyDown}
          {...WINDOW_DRAG_EXCLUDE}
          style={{ ...menuStyle, left: shift }}
        >
          <MenuItem
            accent
            icon={<InfoIcon />}
            label={selfNote ? t('insert.menu.infoNote') : t('insert.menu.info')}
            hint={t('insert.menu.infoHint')}
            tip={selfNote ? t('insert.tip.infoNote') : t('insert.tip.info')}
            onTip={showTip}
            onSelect={run(onCite)}
          />
          <span style={separatorStyle} role="separator" />

          {/* 独立笔记没有全文索引，也没有可解析的章节：这三项整组不出现，别摆一排灰的。 */}
          {!selfNote && (
            <>
              <MenuItem
                icon={<WholeIcon />}
                label={t('insert.menu.whole')}
                hint={wholeCharsHint}
                hintNote={wholeTokensHint}
                tip={fulltextDisabled ? t('detail.noFulltext') : t('insert.tip.whole')}
                tipNote={fulltextDisabled ? undefined : t('fulltext.tokenHint')}
                disabled={fulltextDisabled}
                onTip={showTip}
                onSelect={run(onInsertWhole)}
              />
              <MenuItem
                icon={<SectionIcon />}
                label={t('insert.menu.chapters')}
                hint={chapterCount !== null && chapterCount > 0 ? tpl(t('insert.menu.sections'), { n: chapterCount }) : undefined}
                tip={fulltextDisabled
                  ? t('detail.noFulltext')
                  : chaptersUnavailable
                    ? t('insert.menu.noChapters')
                    : t('insert.tip.chapters')}
                disabled={chaptersDisabled}
                onTip={showTip}
                onSelect={run(onPickChapters)}
              />
              <MenuItem
                icon={<RangeIcon />}
                label={t('insert.menu.ranges')}
                tip={fulltextDisabled ? t('detail.noFulltext') : t('insert.tip.ranges')}
                disabled={fulltextDisabled}
                onTip={showTip}
                onSelect={run(onPickRanges)}
              />
              <span style={separatorStyle} role="separator" />
            </>
          )}

          <MenuItem
            icon={<ShotIcon />}
            label={t('action.screenshot')}
            tip={screenshotAvailable ? t('insert.tip.shot') : screenshotReason}
            disabled={!screenshotAvailable}
            onTip={showTip}
            onSelect={run(onScreenshot)}
          />
          {tip !== null && (
            <div role="tooltip" {...WINDOW_DRAG_EXCLUDE} style={{ ...tipStyle, left: tip.left, top: tip.top }}>
              {tip.text}
              {tip.note !== undefined && <span style={tipNoteStyle}>{tip.note}</span>}
            </div>
          )}
        </div>
      )}
    </span>
  )
}

interface MenuItemProps {
  icon: ReactElement
  label: string
  hint?: string
  /** 第二行小字（目前只有「整篇全文」的 token 粗估）：比 hint 更淡，只作补充。 */
  hintNote?: string
  disabled?: boolean
  /** 悬停说明：这一项到底插什么、什么场景该用它与别项的区别。 */
  tip: string
  /** 说明的第二段（更淡）：给「整篇全文」挂 token 粗估的免责说明。 */
  tipNote?: string
  /** 主操作（插入文献信息）：图标用主题色，其余用中性灰。 */
  accent?: boolean
  onTip(payload: TipPayload | null): void
  onSelect(): void
}

/**
 * 一行菜单项。
 *
 * 说明挂在外层 `span` 而不是 `button` 上：`disabled` 的 button 在 Chromium 里不派发
 * 鼠标事件（hover 也收不到），禁用项恰恰是最需要解释「为什么点不了」的地方。
 */
function MenuItem({
  icon, label, hint, hintNote, disabled = false, tip, tipNote, accent = false, onTip, onSelect,
}: MenuItemProps): ReactElement {
  return (
    <span
      style={itemWrapStyle}
      onMouseEnter={(event) => onTip({ text: tip, note: tipNote, rect: event.currentTarget.getBoundingClientRect() })}
      onMouseLeave={() => onTip(null)}
    >
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        disabled={disabled}
        onClick={onSelect}
        style={disabled ? { ...itemStyle, ...itemDisabledStyle } : itemStyle}
      >
        <span style={{ flexShrink: 0, display: 'inline-flex', color: accent ? ACCENT : 'rgba(127,127,127,0.95)' }}>{icon}</span>
        <span style={{ flex: 1, minWidth: 0, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {hint !== undefined && (
          <span style={hintColumnStyle}>
            <span style={hintStyle}>{hint}</span>
            {hintNote !== undefined && <span style={hintNoteStyle}>{hintNote}</span>}
          </span>
        )}
      </button>
    </span>
  )
}

function CaretIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 3.9 5 6.9l3-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function InfoIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round">
        <rect x="2" y="1.8" width="8" height="8.4" rx="1.2" />
        <path d="M4 4.3h4M4 6.2h4M4 8.1h2.4" />
      </g>
    </svg>
  )
}

function WholeIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="1.05" strokeLinecap="round">
        <path d="M2 2.6h8M2 6h8M2 9.4h5" />
      </g>
    </svg>
  )
}

function SectionIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="1.05" strokeLinecap="round">
        <path d="M2 3h8M2 6h6M2 9h4" />
      </g>
    </svg>
  )
}

function RangeIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth="1.05" strokeLinecap="round">
        <path d="M4 2.4v7.2M8 2.4v7.2" />
        <path d="M5.6 6h.8" strokeWidth="1.2" />
      </g>
    </svg>
  )
}

function ShotIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.05">
        <rect x="1.9" y="1.9" width="8.2" height="8.2" rx="1.2" />
        <path d="M6 4.2v3.6M4.2 6h3.6" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** 定位上下文：菜单是它的绝对定位子节点，宽度只按内容撑、不参与行布局。 */
const wrapStyle = {
  position: 'relative',
  display: 'inline-flex',
  flexShrink: 0,
  pointerEvents: 'auto',
} as const

/** 分裂按钮外壳：整体共用一层浅蓝底与描边，内部两段各自可点。 */
const groupStyle = {
  ...SOFT_BUTTON_STYLE,
  position: 'relative',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  borderRadius: 11,
  overflow: 'hidden',
  boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
  zIndex: 21,
} as const

const mainStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 9px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 500,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
} as const

const dividerStyle = {
  flexShrink: 0,
  width: 1,
  height: 12,
  background: 'rgba(74,134,232,0.45)',
} as const

const caretStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 21,
  height: 20,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
} as const

const menuStyle = {
  position: 'absolute',
  top: 26,
  left: 0,
  zIndex: 30,
  width: MENU_WIDTH,
  // 宽度算位移时按整体 296px 量，盒模型也必须按整体算（padding / border 含在内）。
  boxSizing: 'border-box' as const,
  display: 'flex',
  flexDirection: 'column',
  padding: 5,
  borderRadius: 10,
  border: '1px solid rgba(127,127,127,0.32)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  pointerEvents: 'auto',
} as const

/** 行外壳：撑满菜单宽度，只负责接住 hover（含禁用行），不参与内部布局。 */
const itemWrapStyle = {
  display: 'flex',
  width: '100%',
} as const

const itemStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  height: 30,
  padding: '0 7px',
  border: 'none',
  borderRadius: 6,
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 12.5,
  lineHeight: 1.2,
  textAlign: 'left',
  cursor: 'pointer',
} as const

const itemDisabledStyle = {
  opacity: 0.45,
  cursor: 'not-allowed',
} as const

const hintStyle = {
  flexShrink: 0,
  fontSize: 11,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
} as const

/** 两行小字叠在行尾：字号按 11 + 10.5 排，行高收紧到 1.15 才塞进 30px 的菜单行。 */
const hintColumnStyle = {
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  lineHeight: 1.15,
} as const

/** token 是估算值，比字数更淡，不跟「字」抢注意力。 */
const hintNoteStyle = {
  fontSize: 10.5,
  opacity: 0.5,
  fontVariantNumeric: 'tabular-nums',
} as const

const separatorStyle = {
  height: 1,
  margin: '4px 6px',
  background: 'rgba(127,127,127,0.28)',
} as const

/**
 * 悬停说明。
 *
 * `pointerEvents: none` 是关键：提示弹在行的侧面，鼠标稍微一偏就会压在上面；
 * 若能接收事件，它会立刻把身下那一行的 `mouseleave` 吃掉，提示自己闪掉。
 */
const tipStyle = {
  position: 'absolute',
  zIndex: 31,
  width: TIP_WIDTH,
  boxSizing: 'border-box',
  padding: '7px 9px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.30)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
  fontFamily: 'inherit',
  fontSize: 11.5,
  fontWeight: 400,
  lineHeight: 1.45,
  whiteSpace: 'normal',
  textAlign: 'left',
  pointerEvents: 'none',
} as const

/** 补充行：token 粗估这类「知道就行」的说明，压淡一档。 */
const tipNoteStyle = {
  display: 'block',
  marginTop: 4,
  fontSize: 10.5,
  opacity: 0.6,
} as const
