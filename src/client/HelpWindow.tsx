/**
 * 面板头部的「使用帮助」教程浮窗。
 *
 * 复用 {@link useFloatingBox} + {@link useDismiss}：默认摆在右栏外侧、可拖位置、
 * 可拖大小、图钉常驻，Esc / 图钉关闭。与目录 / 信息浮层唯一的区别是
 * `persist: false`——它是面板级的，没有真实 itemKey，几何只在本会话内存里，
 * 绝不往 view-state 写假条目键。
 *
 * 内容分 5 个 tab：快速上手 / 精读与理解 / 笔记整理 / 文库管理 / 截图与标注。
 * 每条示例给出入口提示与一段可一键复制的提示词，文案全走 locales.ts（zh/en）。
 *
 * 面板根必须挂 `{...box.panelProps}`（WINDOW_DRAG_EXCLUDE）：macOS 宿主把整行
 * chrome 当几何拖拽区，浮层压住那行就会变成拖整个 DSH 窗口。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { writeClipboard } from './clipboard'
import { useDismiss } from './dismiss'
import { useFloatingBox } from './floatingBox'
import type { Translate } from './locales'
import { showToast } from './paneStore'
import {
  ACCENT,
  SOFT_BUTTON_ACTIVE_STYLE,
  SOFT_BUTTON_CLASS,
  SOFT_BUTTON_STYLE,
  softButtonClass,
} from './styles'

interface Props {
  t: Translate
  open: boolean
  /** 测量基准：面板正文容器，其 left 即右栏左边界。 */
  anchorRef: { readonly current: HTMLElement | null }
  /** 触发按钮（或其外层包裹）：算「浮层内部」，点它不会被当作点外面。 */
  triggerRef: { readonly current: HTMLElement | null }
  onClose(): void
}

/** 假 key：`persist: false` 时只作 effect 依赖，不参与几何读写。 */
const HELP_BOX_KEY = '__help__'
const PANEL_WIDTH = 460
const PANEL_MIN_WIDTH = 340
const PANEL_MIN_HEIGHT = 280
/** 「已复制」显示多久后复位。 */
const COPIED_FEEDBACK_MS = 1400

type TabId = 'start' | 'reading' | 'notes' | 'library' | 'shots'

interface TabSpec {
  id: TabId
  /** 该 tab 的示例条数（键为 help.ex.<id>.<n>.*，n 从 1 起）。 */
  count: number
  /** 快速上手需要给每条示例标出入口。 */
  withHint: boolean
  footnoteKey?: string
}

const TABS: TabSpec[] = [
  { id: 'start', count: 7, withHint: true, footnoteKey: 'help.start.footnote' },
  { id: 'reading', count: 4, withHint: false },
  { id: 'notes', count: 3, withHint: false },
  { id: 'library', count: 4, withHint: false },
  { id: 'shots', count: 3, withHint: false },
]

export function HelpWindow({ t, open, anchorRef, triggerRef, onClose }: Props): ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>('start')
  const [pinned, setPinned] = useState(false)
  const [pinHovered, setPinHovered] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  const box = useFloatingBox({
    open,
    anchorRef,
    itemKey: HELP_BOX_KEY,
    kind: 'info',
    persist: false,
    width: PANEL_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
  })

  useDismiss(open, box.panelRef, onClose, { pinned, extraRef: triggerRef })

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
  }, [])

  function copyPrompt(key: string, text: string): void {
    void writeClipboard(text).then((ok) => {
      if (ok) {
        setCopiedKey(key)
      } else {
        setCopiedKey(null)
        showToast(t('toast.copyFailed'))
      }
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopiedKey(null), COPIED_FEEDBACK_MS)
    })
  }

  const tab = TABS.find((spec) => spec.id === activeTab) ?? TABS[0]!

  return (
    <div style={rootStyle}>
      {open && box.style !== null && (
        <div
          ref={box.panelRef}
          role="dialog"
          aria-label={t('help.title')}
          {...box.panelProps}
          style={{ ...panelStyle, ...box.style }}
        >
          <div style={panelHeaderStyle} {...box.moveProps}>
            <span>{t('help.title')}</span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              aria-pressed={pinned}
              aria-label={pinned ? t('help.unpin') : t('help.pin')}
              title={pinned ? t('help.unpin') : t('help.pin')}
              onClick={() => setPinned((current) => !current)}
              onMouseEnter={() => setPinHovered(true)}
              onMouseLeave={() => setPinHovered(false)}
              style={{
                ...iconButtonStyle,
                color: pinned ? ACCENT : 'CanvasText',
                opacity: pinned ? 1 : 0.55,
                background: pinHovered ? 'rgba(127,127,127,0.16)' : 'transparent',
              }}
            >
              <PinIcon filled={pinned} />
            </button>
            <button
              type="button"
              aria-label={t('help.close')}
              title={t('help.close')}
              onClick={onClose}
              style={{ ...iconButtonStyle, fontSize: 15, lineHeight: 1 }}
            >
              ×
            </button>
          </div>

          <div style={subtitleStyle}>{t('help.subtitle')}</div>

          <div style={tabBarStyle} role="tablist" aria-label={t('help.title')}>
            {TABS.map((spec) => {
              const active = spec.id === activeTab
              return (
                <button
                  key={spec.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={softButtonClass(active)}
                  onClick={() => setActiveTab(spec.id)}
                  style={{
                    ...(active ? SOFT_BUTTON_ACTIVE_STYLE : SOFT_BUTTON_STYLE),
                    boxShadow: active ? `inset 0 -2px 0 ${ACCENT}` : 'none',
                    ...tabButtonStyle,
                  }}
                >
                  {t(`help.tab.${spec.id}`)}
                </button>
              )
            })}
          </div>

          <div style={bodyStyle}>
            <div style={sectionTitleStyle}>{t(`help.${tab.id}.title`)}</div>
            <p style={sectionDescStyle}>{t(`help.${tab.id}.desc`)}</p>

            {Array.from({ length: tab.count }, (_, index) => index + 1).map((n) => {
              const key = `help.ex.${tab.id}.${n}`
              const copied = copiedKey === `${tab.id}-${n}`
              const hint = tab.withHint ? t(`${key}.hint`) : ''
              return (
                <div key={key} style={exampleStyle}>
                  <div style={exampleHeadStyle}>
                    <span style={exampleLabelStyle}>{t(`${key}.label`)}</span>
                    <button
                      type="button"
                      className={SOFT_BUTTON_CLASS}
                      onClick={() => copyPrompt(`${tab.id}-${n}`, t(`${key}.prompt`))}
                      style={{
                        ...SOFT_BUTTON_STYLE,
                        ...(copied ? SOFT_BUTTON_ACTIVE_STYLE : null),
                        ...copyButtonStyle,
                        color: copied ? ACCENT : 'var(--dsw-alias-label-primary, CanvasText)',
                      }}
                    >
                      {copied ? t('toast.copied') : t('help.copy')}
                    </button>
                  </div>
                  {hint !== '' && <div style={hintStyle}>{hint}</div>}
                  <div style={promptStyle}>{t(`${key}.prompt`)}</div>
                </div>
              )
            })}

            {tab.footnoteKey !== undefined && <p style={footnoteStyle}>{t(tab.footnoteKey)}</p>}
          </div>

          <span
            aria-hidden="true"
            title={t('help.resize')}
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

function PinIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M9.5 1.5 14.5 6.5 11 8l-2 4-1.5-1.5L4 13 3 12l2.5-3.5L4 7l4-2z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ResizeIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M4.2 9 9 4.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7.4 9 9 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 透明根层：只负责把 zIndex 抬到聊天区 / 输入框之上；自身不画东西、不拦点击。
 * 层级高于兄弟浮层的 300，低于截图定格 400 与宿主对话框（≥1000）。
 */
const rootStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 320,
  pointerEvents: 'none',
} as const

const panelStyle = {
  position: 'fixed',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: '10px 10px 8px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.32)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  fontSize: 12,
  lineHeight: 1.6,
  overscrollBehavior: 'contain',
  zIndex: 320,
} as const

const panelHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
  padding: '0 2px 8px',
  marginBottom: 6,
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  fontWeight: 700,
  fontSize: 13,
  color: ACCENT,
  cursor: 'move',
  userSelect: 'none',
  touchAction: 'none',
} as const

const iconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: 4,
  border: 'none',
  cursor: 'pointer',
  transition: 'background-color 120ms ease',
} as const

const subtitleStyle = {
  flexShrink: 0,
  padding: '0 2px 8px',
  fontSize: 11.5,
  opacity: 0.7,
} as const

const tabBarStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  flexShrink: 0,
  padding: '0 2px 8px',
} as const

const tabButtonStyle: CSSProperties = {
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 11.5,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}

const bodyStyle = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  overscrollBehavior: 'contain',
  padding: '0 4px 16px',
} as const

const sectionTitleStyle = {
  fontSize: 12.5,
  fontWeight: 700,
  color: ACCENT,
  margin: '2px 0 4px',
} as const

const sectionDescStyle = {
  margin: '0 0 10px',
  fontSize: 11.5,
  opacity: 0.78,
} as const

const exampleStyle = {
  marginBottom: 9,
  padding: '7px 8px',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.18)',
  background: 'rgba(127,127,127,0.06)',
} as const

const exampleHeadStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 5,
} as const

const exampleLabelStyle = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 600,
} as const

const copyButtonStyle: CSSProperties = {
  padding: '0 7px',
  fontSize: 11,
  lineHeight: '18px',
  borderRadius: 5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

const hintStyle = {
  fontSize: 11,
  opacity: 0.62,
  marginBottom: 5,
} as const

const promptStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11.5,
  lineHeight: 1.6,
  background: 'rgba(127,127,127,0.10)',
  border: '1px solid rgba(127,127,127,0.22)',
  borderRadius: 6,
  padding: '6px 8px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'CanvasText',
  userSelect: 'text',
} as const

const footnoteStyle = {
  margin: '10px 0 0',
  padding: '7px 8px',
  fontSize: 11,
  lineHeight: 1.6,
  opacity: 0.72,
  borderLeft: `2px solid ${ACCENT}`,
  background: 'rgba(80,140,255,0.06)',
  borderRadius: '0 4px 4px 0',
} as const

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
