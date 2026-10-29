/**
 * 右栏底部：可切换的分区面板（tab 页）。
 *
 * 用于承载「参考文献 / 笔记 / 附件」这类次级内容：它们与正文区（标题、元数据、
 * 摘要、全文）分开，用 tab 切换，避免正文区被撑散、也方便后续往这里加新的分区。
 *
 * 传入的 tabs 里没有内容的分区不会被渲染成 tab；默认选中第一个有内容的分区。
 */

import { useState, type ReactElement, type ReactNode } from 'react'

import { ACCENT } from './styles'

export interface DetailTab {
  /** 唯一 id。 */
  id: string
  /** tab 上的标题。 */
  label: string
  /** 标题右侧的补充说明（如条目数）。 */
  hint?: string
  /** tab 内容。 */
  content: ReactNode
}

interface Props {
  tabs: DetailTab[]
}

export function DetailTabs({ tabs }: Props): ReactElement | null {
  const [activeId, setActiveId] = useState<string>('')

  if (tabs.length === 0) return null

  // 切换条目后 tabs 会变，若当前选中的分区已不存在则回落到第一个。
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div role="tablist" style={tabBarStyle}>
        {tabs.map((tab) => {
          const selected = tab.id === active.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveId(tab.id)}
              style={tabButtonStyle(selected)}
            >
              <span>{tab.label}</span>
              {tab.hint !== undefined && tab.hint !== '' && (
                <span style={{ opacity: 0.55, fontWeight: 400, fontSize: 11 }}>{tab.hint}</span>
              )}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px 12px' }}>
        {active.content}
      </div>
    </div>
  )
}

const tabBarStyle = {
  display: 'flex',
  alignItems: 'stretch',
  gap: 4,
  flexShrink: 0,
  padding: '0 10px',
  borderBottom: '1px solid rgba(127,127,127,0.22)',
  // 窄栏下 4 个分区会溢出，横向滚动而不是挤压/换行。
  overflowX: 'auto',
} as const

function tabButtonStyle(selected: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    flexShrink: 0,
    padding: '8px 10px 7px',
    marginBottom: -1,
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: 0.2,
    color: ACCENT,
    opacity: selected ? 1 : 0.55,
    background: 'transparent',
    border: 'none',
    borderBottom: `2px solid ${selected ? ACCENT : 'transparent'}`,
    cursor: 'pointer',
  }
}
