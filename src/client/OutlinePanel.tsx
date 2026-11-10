/**
 * 左上角的**统一**目录浮层：PDF 书签、网页快照标题、笔记 / 全文标题都在这里。
 *
 * 按钮与「文献信息」并排（目录在左），收起规则和其它浮层共用 {@link useDismiss}：
 * 点浮层外、按 Esc、点进网页快照正文里都会收起。
 *
 * 目录数据一律由渲染器上报（见 `viewer/types.ts` 的 `onOutlineChange`），这里只负责画：
 * 面板不解释跳转目标，点一条就把 `target` 原样交回 `ItemDetail` 转给渲染器——
 * 于是 PDF 跳页、HTML 滚到标题可以共用同一份 UI。
 *
 * 点条目只跳转、不收起：浮层要留着让用户连点几条反复导航，关闭统一交给
 * {@link useDismiss}（点浮层外 / 按 Esc）或再点一次目录按钮。
 */

import { useRef, useState, type ReactElement } from 'react'

import { useDismiss } from './dismiss'
import { tpl, type Translate } from './locales'
import { ACCENT } from './styles'
import type { DocumentOutlineItem } from './viewer/types'

interface Props {
  t: Translate
  /** `null` 表示还没读到（文档还在加载）；空数组表示这份文档没有标题 / 书签。 */
  items: DocumentOutlineItem[] | null
  /** 目录来源的一句说明：PDF 书签 / 网页标题 / 笔记标题 …，只作展示。 */
  sourceLabel: string
  open: boolean
  onToggle(): void
  onClose(): void
  onJump(item: DocumentOutlineItem): void
}

/** 缩进宽度；层级再深也不再往外推，免得窄面板里标题全被挤成一点。 */
const INDENT = 13
const MAX_INDENT_DEPTH = 6

export function OutlinePanel({ t, items, sourceLabel, open, onToggle, onClose, onJump }: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 悬停行：内联 style 写不了 `:hover`，只能自己记一个下标。 */
  const [hovered, setHovered] = useState<number | null>(null)

  useDismiss(open, rootRef, onClose)

  return (
    <div ref={rootRef} style={rootStyle}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={t('outline.title')}
        title={t('outline.title')}
        style={{ ...triggerStyle, color: open ? ACCENT : 'CanvasText' }}
      >
        <ListIcon />
      </button>

      {open && (
        <div role="dialog" aria-label={t('outline.title')} style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>{t('outline.title')}</span>
            {items !== null && items.length > 0 && (
              <span style={countStyle}>{tpl(t('outline.count'), { n: items.length })}</span>
            )}
          </div>
          <div style={sourceStyle}>{sourceLabel}</div>

          {items === null && <p style={emptyStyle}>{t('outline.loading')}</p>}

          {items !== null && items.length === 0 && <p style={emptyStyle}>{t('outline.empty')}</p>}

          {items !== null && items.length > 0 && (
            <div style={listStyle}>
              {items.map((item, index) => {
                const target = item.target
                const hint = target === null
                  ? item.title
                  : `${item.title}\n${target.kind === 'page'
                    ? tpl(t('outline.jump'), { page: target.page })
                    : t('outline.jumpHeading')}`
                return (
                  <button
                    key={`${index}-${item.title}`}
                    type="button"
                    disabled={target === null}
                    onClick={() => onJump(item)}
                    onMouseEnter={() => setHovered(index)}
                    onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
                    title={hint}
                    style={{
                      ...rowStyle,
                      paddingLeft: 6 + Math.min(item.depth, MAX_INDENT_DEPTH) * INDENT,
                      opacity: target === null ? 0.5 : 1,
                      background: hovered === index && target !== null ? 'rgba(127,127,127,0.14)' : 'transparent',
                      cursor: target === null ? 'default' : 'pointer',
                    }}
                  >
                    {item.title}
                  </button>
                )
              })}
            </div>
          )}
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

const rootStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 20,
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

const panelStyle = {
  position: 'absolute',
  pointerEvents: 'auto',
  top: 32,
  left: 8,
  display: 'flex',
  flexDirection: 'column',
  width: 300,
  maxWidth: 'calc(100% - 16px)',
  maxHeight: 'calc(100% - 40px)',
  padding: '8px 6px 6px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.32)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  fontSize: 12,
  lineHeight: 1.6,
  overscrollBehavior: 'contain',
} as const

const panelHeaderStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  flexShrink: 0,
  padding: '0 4px 6px',
  marginBottom: 4,
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  fontWeight: 700,
  fontSize: 12.5,
  color: ACCENT,
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

const emptyStyle = {
  margin: 0,
  padding: '6px 4px 8px',
  fontSize: 12,
  opacity: 0.72,
} as const
