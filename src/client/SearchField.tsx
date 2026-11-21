/**
 * 紧凑搜索框：左侧放大镜图标 + 小号字。
 *
 * 目录筛选、条目搜索、标签筛选共用，压缩侧栏里三处输入框的高度。
 * 不用宿主 `Input`（固定 32px 高、14px 字），改用内联样式保持深浅色下都可读。
 *
 * 传入 `modeItems` 时（目前只有条目列表），左侧放大镜变成 Zotero 同款的三档
 * 口径下拉：标题 / 所有字段与标签 / 所有内容；当前档位同时充当占位提示。
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import type { ZoteroSearchMode } from '../zotero/types'
import { useDismiss } from './dismiss'
import { WINDOW_DRAG_EXCLUDE } from './floatingBox'
import { ACCENT } from './styles'

/** 输入框整体高度（px）。 */
const HEIGHT = 24

/** 下拉宽度：中英文最长一项都能放下，又不至于压到正文上。 */
const MENU_WIDTH = 176

export interface SearchModeItem {
  value: ZoteroSearchMode
  label: string
}

interface Props {
  value: string
  placeholder: string
  /** 清除按钮的无障碍标签 / 悬停提示。 */
  clearLabel: string
  onChange(text: string): void
  /** 传入后左侧显示搜索口径下拉；缺省时只是普通搜索框。 */
  modeItems?: readonly SearchModeItem[]
  mode?: ZoteroSearchMode
  /** 下拉触发按钮的无障碍标签。 */
  modeLabel?: string
  onModeChange?(mode: ZoteroSearchMode): void
}

function Magnifier(): ReactElement {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      style={{ flexShrink: 0, color: '#4a86e8', opacity: 0.85 }}
    >
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.4 10.4 3 3" />
    </svg>
  )
}

function Chevron(): ReactElement {
  return (
    <svg
      width={7}
      height={7}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, opacity: 0.6 }}
    >
      <path d="m2 3.6 3 3 3-3" />
    </svg>
  )
}

function Check(): ReactElement {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 5.2 4 7.7l4.5-5.2" />
    </svg>
  )
}

/** 输入框内的清除按钮（有内容时才出现）。 */
function ClearButton({ label, onClick }: { label: string; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.5,
        cursor: 'pointer',
      }}
    >
      <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
        <path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" />
      </svg>
    </button>
  )
}

function ModeOption({ item, checked, onSelect }: {
  item: SearchModeItem
  checked: boolean
  onSelect(): void
}): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '5px 7px',
        border: 'none',
        borderRadius: 6,
        background: checked ? ACCENT : hover ? 'rgba(74,134,232,0.14)' : 'transparent',
        color: checked ? '#fff' : 'inherit',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: 1.25,
        textAlign: 'left',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 10, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
        {checked ? <Check /> : null}
      </span>
      {item.label}
    </button>
  )
}

export function SearchField({
  value,
  placeholder,
  clearLabel,
  onChange,
  modeItems,
  mode,
  modeLabel,
  onModeChange,
}: Props): ReactElement {
  const [focused, setFocused] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useDismiss(open, menuRef, () => setOpen(false), { extraRef: boxRef })

  const hasModes = modeItems !== undefined && modeItems.length > 0
  const current = hasModes ? modeItems.find((item) => item.value === mode) : undefined

  // 打开时把焦点放到当前项上：↑↓ 立刻可用，读屏也能读到选中状态。
  useEffect(() => {
    if (!open) return
    const selected = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
    ;(selected ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus()
  }, [open])

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    if (items.length === 0) return
    const index = items.findIndex((node) => node === document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = index < 0 ? 0 : (index + step + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'flex', minWidth: 0 }}>
      <label
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          height: HEIGHT,
          boxSizing: 'border-box',
          padding: '0 7px',
          borderRadius: 6,
          border: `1px solid ${focused || open ? 'rgba(74,134,232,0.75)' : 'rgba(74,134,232,0.32)'}`,
          background: 'rgba(74,134,232,0.05)',
          cursor: 'text',
          color: 'inherit',
        }}
      >
        {hasModes ? (
          <span
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={modeLabel}
            title={current?.label ?? modeLabel}
            onClick={(event) => {
              // 别让 label 的默认行为把焦点抢给输入框。
              event.preventDefault()
              event.stopPropagation()
              setOpen((value) => !value)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              setOpen((value) => !value)
            }}
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: 0,
              marginLeft: -2,
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            <Magnifier />
            <Chevron />
          </span>
        ) : <Magnifier />}
        <input
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            minWidth: 0,
            height: '100%',
            padding: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'inherit',
            fontSize: 12,
          }}
        />
        {value !== '' && <ClearButton label={clearLabel} onClick={() => onChange('')} />}
      </label>

      {open && hasModes && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={modeLabel}
          onKeyDown={onMenuKeyDown}
          {...WINDOW_DRAG_EXCLUDE}
          style={{
            position: 'absolute',
            top: HEIGHT + 4,
            left: 0,
            zIndex: 30,
            width: MENU_WIDTH,
            maxWidth: 'calc(100vw - 24px)',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            padding: 4,
            borderRadius: 8,
            border: '1px solid rgba(127,127,127,0.32)',
            background: 'Canvas',
            color: 'CanvasText',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          }}
        >
          {modeItems.map((item) => (
            <ModeOption
              key={item.value}
              item={item}
              checked={item.value === mode}
              onSelect={() => {
                setOpen(false)
                if (item.value !== mode) onModeChange?.(item.value)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}