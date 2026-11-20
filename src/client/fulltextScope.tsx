/**
 * 「加入全文」的范围选择器浮层。
 *
 * 四种模式：章节（默认、置顶推荐）/ 整篇 / 字符区间 / 标题区间，后三种收在
 * 「更多方式」里。章节列表直接复用目录浮层的 `outlineItems`（PDF 书签 / 快照
 * 网页标题 / 笔记标题 / 纯文本标题），用户在目录里看到什么这里就是什么——绝不
 * 自己用 `parseMarkdownHeadings()` 造一套对 PDF 无效的假章节。
 *
 * 定位策略：选中章节后用**章节标题**在 `detail.fulltext.content` 里逐行定位
 * （`findHeadingOffset`），起点是首个选中标题、终点是紧随其后的下一章节标题，
 * 于是产出精确的 `o:start:end` 字符区间。定位不到时：PDF（page target）退到
 * `p:` 让 codec 按页码估算，其他文档退到整篇并标注——都不静默给错位切片。
 *
 * 浮层复用 `useFloatingBox`（persist:false，面板级、不写 view-state）+ `useDismiss`，
 * 根节点挂 `WINDOW_DRAG_EXCLUDE`（box.panelProps），避免拖浮层变成拖整个窗口。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'

import type { ZoteroItemDetail } from '../zotero/types'
import type { DocumentOutlineItem } from './viewer/types'
import { parseMarkdownHeadings } from './viewer/outline'
import { useDismiss } from './dismiss'
import { useFloatingBox } from './floatingBox'
import { findHeadingOffset } from './fulltextRange'
import type { Translate } from './locales'
import { tpl } from './locales'
import { ACCENT, SOFT_BUTTON_ACTIVE_STYLE, SOFT_BUTTON_CLASS, SOFT_BUTTON_STYLE } from './styles'

interface Props {
  t: Translate
  open: boolean
  detail: ZoteroItemDetail
  /** 目录浮层那份章节列表（按当前文档归属；null = 还没解析出来）。 */
  outline: DocumentOutlineItem[] | null
  /** 几何测量基准：覆盖阅读区的透明容器（InfoPanel 的 rootRef）。 */
  anchorRef: { readonly current: HTMLElement | null }
  /** 触发按钮：算「浮层内部」，点它不被判成点外面而先关一次。 */
  triggerRef: { readonly current: HTMLElement | null }
  onClose(): void
  /** 确认：range 是范围表达式，scope 是人读范围标注（进 chip 标签与展开文本头部）。 */
  onConfirm(range: string, scope: string): void
}

type Mode = 'chapter' | 'all' | 'chars' | 'headings'

const PANEL_WIDTH = 380
const PANEL_MIN_WIDTH = 300
const PANEL_MIN_HEIGHT = 260
const SCOPE_BOX_KEY = '__fulltext_scope__'

interface ChapterPlan {
  range: string
  scope: string
  chars: number
  estimated: boolean
}

/** 章节下标按 outline 顺序排序去重。 */
function sortedIndices(selected: ReadonlySet<number>): number[] {
  return [...selected].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
}

/**
 * 计算选中章节的范围表达式。
 *
 * 用标题逐行定位而不是 outline 的 target.id：快照/笔记的 anchor id 是元素锚点序号、
 * 只有纯文本才是字符偏移，语义不统一；标题文本配 `fulltext.content` 才是同一个
 * 字符空间。定位成功给精确 `o:`，PDF 定位失败给 `p:`（codec 按页估算），其余失败
 * 退整篇。
 */
function planChapters(
  content: string,
  items: DocumentOutlineItem[],
  selected: ReadonlySet<number>,
  isPdf: boolean,
  t: Translate,
): ChapterPlan | null {
  const indices = sortedIndices(selected).filter((i) => i < items.length)
  if (indices.length === 0) return null

  const titles = indices.map((i) => items[i]?.title ?? '')
  const offsets = titles.map((title) => findHeadingOffset(content, title))
  const firstOffset = offsets[0] ?? null
  const label = titles.join(' · ')

  // 页码（PDF）用于 scope 标注；非 PDF 的 target 没有页码就不写。
  const pages = isPdf
    ? indices.map((i) => {
        const target = items[i]?.target
        return target?.kind === 'page' ? target.page : null
      }).filter((page): page is number => page !== null)
    : []
  const pageTag = pages.length > 0
    ? `（P${Math.min(...pages)}–P${Math.max(...pages)}）`
    : ''

  if (firstOffset !== null) {
    const lastIndex = indices[indices.length - 1] ?? 0
    // 终点：选中最后一项之后的第一个「能定位到」的章节标题；再没有就到全文末尾。
    let end = content.length
    for (let i = lastIndex + 1; i < items.length; i += 1) {
      const next = findHeadingOffset(content, items[i]?.title ?? '')
      if (next !== null && next > firstOffset) { end = next; break }
    }
    if (end <= firstOffset) end = content.length
    return {
      range: `o:${firstOffset}:${end}`,
      scope: tpl(t('fulltext.scope.chapters'), { value: `${label}${pageTag}` }),
      chars: end - firstOffset,
      estimated: false,
    }
  }

  if (isPdf) {
    const startPage = pages[0] ?? 1
    const endPage = pages[pages.length - 1] ?? startPage
    // 总页用 outline 里最大的页码近似——书签通常覆盖到接近文末，够作比例分母。
    const total = items.reduce((max, item) => {
      const target = item.target
      return target?.kind === 'page' && target.page > max ? target.page : max
    }, endPage)
    const encoded = titles.map((title) => encodeURIComponent(title)).join('+')
    return {
      range: `p:${startPage}:${endPage}:${total}:${encoded}`,
      scope: tpl(t('fulltext.scope.chapters'), { value: `${label}${pageTag}` }),
      chars: Math.round(content.length * (endPage - startPage + 1) / Math.max(1, total)),
      estimated: true,
    }
  }

  return {
    range: 'all',
    scope: tpl(t('fulltext.scope.headingFallback'), { value: label }),
    chars: content.length,
    estimated: true,
  }
}

export function FulltextScope({
  t, open, detail, outline, anchorRef, triggerRef, onClose, onConfirm,
}: Props): ReactElement | null {
  const [mode, setMode] = useState<Mode>('chapter')
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('')
  const [fromTitle, setFromTitle] = useState('')
  const [toTitle, setToTitle] = useState('')

  const content = detail.fulltext?.content ?? ''
  const items = outline ?? []
  const isPdf = items.some((item) => item.target?.kind === 'page')
  const markdownTitles = useMemo(
    () => (mode === 'headings' ? parseMarkdownHeadings(content).map((item) => item.title) : []),
    [content, mode],
  )

  const box = useFloatingBox({
    open,
    anchorRef,
    itemKey: SCOPE_BOX_KEY,
    kind: 'info',
    persist: false,
    width: PANEL_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
  })
  useDismiss(open, box.panelRef, onClose, { extraRef: triggerRef })

  // 每次打开重置到默认章节模式，避免上次的选择带到下一条文献。
  useEffect(() => {
    if (!open) return
    setMode('chapter')
    setSelected(new Set())
    setStart('0')
    setEnd(String(content.length))
    setFromTitle('')
    setToTitle('')
  }, [open, detail.key, content.length])

  // 当前模式下的范围方案与计数。
  const plan: ChapterPlan | null = useMemo(() => {
    switch (mode) {
      case 'chapter':
        return planChapters(content, items, selected, isPdf, t)
      case 'all':
        return {
          range: 'all',
          scope: t('fulltext.scope.all'),
          chars: content.length,
          estimated: false,
        }
      case 'chars': {
        const a = Math.max(0, Math.trunc(Number(start) || 0))
        const b = Math.min(content.length, Math.trunc(Number(end) || 0))
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        if (hi <= lo) return null
        return {
          range: `c:${lo}:${hi}`,
          scope: tpl(t('fulltext.scope.chars'), { value: `${lo}–${hi}` }),
          chars: hi - lo,
          estimated: false,
        }
      }
      case 'headings': {
        if (fromTitle === '' || toTitle === '' || fromTitle === toTitle) return null
        return {
          range: `h:${encodeURIComponent(fromTitle)}:${encodeURIComponent(toTitle)}`,
          scope: tpl(t('fulltext.scope.headings'), { value: `${fromTitle} – ${toTitle}` }),
          chars: 0,
          estimated: false,
        }
      }
    }
  }, [mode, content, items, selected, isPdf, t, start, end, fromTitle, toTitle])

  function toggleChapter(index: number): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function confirm(): void {
    if (plan === null) return
    onConfirm(`${plan.range}|${encodeURIComponent(plan.scope)}`, plan.scope)
  }

  if (!open || box.style === null) return null

  const hasChapters = items.length > 0

  return (
    <div
      ref={box.panelRef}
      role="dialog"
      aria-label={t('fulltext.title')}
      {...box.panelProps}
      style={{ ...panelStyle, ...box.style }}
    >
      <div style={headerRowStyle}>
        <span style={titleStyle}>{t('fulltext.title')}</span>
        <button type="button" aria-label={t('action.close')} title={t('action.close')} onClick={onClose} style={closeStyle}>
          ×
        </button>
      </div>

      <div style={tabRowStyle}>
        <button
          type="button"
          className={SOFT_BUTTON_CLASS}
          onClick={() => setMode('chapter')}
          style={mode === 'chapter' ? { ...SOFT_BUTTON_ACTIVE_STYLE, ...tabStyle } : { ...SOFT_BUTTON_STYLE, ...tabStyle }}
          aria-pressed={mode === 'chapter'}
        >
          {t('fulltext.mode.chapter')}
        </button>
        <button
          type="button"
          className={SOFT_BUTTON_CLASS}
          onClick={() => { if (mode === 'chapter') setMode('all') }}
          style={mode !== 'chapter' ? { ...SOFT_BUTTON_ACTIVE_STYLE, ...tabStyle } : { ...SOFT_BUTTON_STYLE, ...tabStyle }}
          aria-pressed={mode !== 'chapter'}
        >
          {t('fulltext.mode.more')} {mode !== 'chapter' ? '▴' : '▾'}
        </button>
      </div>

      <div style={bodyStyle}>
        {mode === 'chapter' && (
          hasChapters ? (
            <div style={chapterListStyle}>
              <div style={chapterActionsStyle}>
                <button type="button" onClick={() => setSelected(new Set(items.map((_, i) => i)))} style={linkStyle}>
                  {t('fulltext.selectAll')}
                </button>
                <button type="button" onClick={() => setSelected(new Set())} style={linkStyle}>
                  {t('fulltext.clear')}
                </button>
              </div>
              {items.map((item, index) => (
                <label key={`${index}-${item.title}`} style={{
                  ...chapterRowStyle,
                  paddingLeft: 6 + Math.min(item.depth ?? 0, 6) * 12,
                  background: selected.has(index) ? 'rgba(74,134,232,0.10)' : 'transparent',
                }}>
                  <input
                    type="checkbox"
                    checked={selected.has(index)}
                    onChange={() => toggleChapter(index)}
                    style={checkStyle}
                  />
                  <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{item.title}</span>
                  <span style={chapterMetaStyle}>{pageOf(item)}</span>
                </label>
              ))}
            </div>
          ) : (
            <p style={hintStyle}>{t('fulltext.noChapters')}</p>
          )
        )}

        {mode !== 'chapter' && (
          <div style={moreBoxStyle}>
            <ModeRadio
              label={t('fulltext.mode.all')} name="ft-mode"
              checked={mode === 'all'} onChange={() => setMode('all')}
            />
            <ModeRadio
              label={t('fulltext.mode.chars')} name="ft-mode"
              checked={mode === 'chars'} onChange={() => setMode('chars')}
            />
            {mode === 'chars' && (
              <div style={inputRowStyle}>
                <input type="number" value={start} onChange={(e) => setStart(e.target.value)} style={numberInputStyle} aria-label={t('fulltext.start')} />
                <span style={dashStyle}>—</span>
                <input type="number" value={end} onChange={(e) => setEnd(e.target.value)} style={numberInputStyle} aria-label={t('fulltext.end')} />
              </div>
            )}
            <ModeRadio
              label={t('fulltext.mode.headings')} name="ft-mode"
              checked={mode === 'headings'} onChange={() => setMode('headings')}
            />
            {markdownTitles.length === 0 && mode === 'headings' && (
              <p style={noteStyle}>{t('fulltext.headingsHint')}</p>
            )}
            {mode === 'headings' && markdownTitles.length > 0 && (
              <div style={inputRowStyle}>
                <select value={fromTitle} onChange={(e) => setFromTitle(e.target.value)} style={selectStyle} aria-label={t('fulltext.from')}>
                  <option value="">{t('fulltext.from')}</option>
                  {markdownTitles.map((title, i) => <option key={`${i}-${title}`} value={title}>{title}</option>)}
                </select>
                <select value={toTitle} onChange={(e) => setToTitle(e.target.value)} style={selectStyle} aria-label={t('fulltext.to')}>
                  <option value="">{t('fulltext.to')}</option>
                  {markdownTitles.map((title, i) => <option key={`${i}-${title}`} value={title}>{title}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

      </div>

      <div style={footerStyle}>
        <span style={countStyle}>
          {plan === null
            ? t('fulltext.invalidRange')
            : tpl(t('fulltext.charCount'), { n: plan.chars.toLocaleString(), total: content.length.toLocaleString() })}
        </span>
        <button
          type="button"
          disabled={plan === null}
          onClick={confirm}
          style={{
            ...SOFT_BUTTON_STYLE,
            ...confirmStyle,
            ...(plan === null ? { opacity: 0.45, cursor: 'not-allowed' as const } : {}),
          }}
        >
          {t('fulltext.confirm')}
        </button>
      </div>
    </div>
  )
}

function pageOf(item: DocumentOutlineItem): string {
  const target = item.target
  return target?.kind === 'page' ? `P${target.page}` : ''
}

interface ModeRadioProps {
  label: string
  name: string
  checked: boolean
  onChange(): void
}

function ModeRadio({ label, name, checked, onChange }: ModeRadioProps): ReactElement {
  return (
    <label style={radioRowStyle}>
      <input type="radio" name={name} checked={checked} onChange={onChange} style={checkStyle} />
      <span>{label}</span>
    </label>
  )
}

const panelStyle = {
  position: 'fixed',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: '8px 10px 10px',
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

const headerRowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
  paddingBottom: 6, borderBottom: '1px solid rgba(127,127,127,0.2)',
} as const

const titleStyle = { flex: 1, fontWeight: 700, fontSize: 12.5 } as const

const closeStyle = {
  flexShrink: 0, width: 20, height: 20, padding: 0, borderRadius: 4,
  border: 'none', background: 'transparent', color: 'CanvasText',
  fontSize: 17, lineHeight: 1, cursor: 'pointer',
} as const

const tabRowStyle = { display: 'flex', gap: 6, flexShrink: 0, padding: '8px 0 4px' } as const
const tabStyle = { height: 24, padding: '0 10px', fontSize: 11.5, lineHeight: 1, borderRadius: 12, cursor: 'pointer' } as const

const bodyStyle = { flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain', paddingTop: 4 } as const

const chapterListStyle = { display: 'flex', flexDirection: 'column' } as const
const chapterActionsStyle = { display: 'flex', gap: 12, padding: '0 2px 6px' } as const
const linkStyle = { padding: 0, border: 'none', background: 'transparent', color: ACCENT, fontSize: 11.5, cursor: 'pointer' } as const
const chapterRowStyle = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '3px 2px',
  fontSize: 12, borderRadius: 4, cursor: 'pointer',
} as const
const chapterMetaStyle = { flexShrink: 0, fontSize: 11, opacity: 0.6 } as const
const checkStyle = { flexShrink: 0, cursor: 'pointer' } as const

const hintStyle = { margin: '12px 2px', fontSize: 12, opacity: 0.75 } as const
const noteStyle = { margin: '4px 2px 0 20px', fontSize: 11, opacity: 0.7 } as const

const moreBoxStyle = {
  display: 'flex', flexDirection: 'column', gap: 4,
  padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.25)',
} as const
const radioRowStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 12, cursor: 'pointer' } as const
const inputRowStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0 4px 20px' } as const
const numberInputStyle = {
  width: 92, height: 24, padding: '0 6px', fontSize: 12,
  borderRadius: 4, border: '1px solid rgba(127,127,127,0.4)', background: 'Canvas', color: 'CanvasText',
} as const
const selectStyle = {
  flex: 1, minWidth: 0, height: 26, padding: '0 4px', fontSize: 11.5,
  borderRadius: 4, border: '1px solid rgba(127,127,127,0.4)', background: 'Canvas', color: 'CanvasText',
} as const
const dashStyle = { opacity: 0.6 } as const

const footerStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  flexShrink: 0, paddingTop: 8, marginTop: 6, borderTop: '1px solid rgba(127,127,127,0.2)',
} as const
const countStyle = { flex: 1, fontSize: 11, opacity: 0.7 } as const
const confirmStyle = {
  height: 26, padding: '0 12px', fontSize: 11.5, lineHeight: 1,
  borderRadius: 13, cursor: 'pointer',
} as const
