/**
 * 紧凑搜索框：左侧放大镜图标 + 小号字。
 *
 * 目录筛选、条目搜索、标签筛选共用，压缩侧栏里三处输入框的高度。
 * 不用宿主 `Input`（固定 32px 高、14px 字），改用内联样式保持深浅色下都可读。
 */

import { useState, type ReactElement } from 'react'

/** 输入框整体高度（px）。 */
const HEIGHT = 24

interface Props {
  value: string
  placeholder: string
  /** 清除按钮的无障碍标签 / 悬停提示。 */
  clearLabel: string
  onChange(text: string): void
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

export function SearchField({ value, placeholder, clearLabel, onChange }: Props): ReactElement {
  const [focused, setFocused] = useState(false)
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        height: HEIGHT,
        boxSizing: 'border-box',
        padding: '0 7px',
        borderRadius: 6,
        border: `1px solid ${focused ? 'rgba(74,134,232,0.75)' : 'rgba(74,134,232,0.32)'}`,
        background: 'rgba(74,134,232,0.05)',
        cursor: 'text',
        color: 'inherit',
      }}
    >
      <Magnifier />
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
  )
}
