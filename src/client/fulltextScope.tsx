/** 当前附件的范围选择、实际发送正文预览与用量提示。 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'

import type { ZoteroItemDetail } from '../zotero/types'
import { ChatIcon } from './actionIcons'
import type { DocumentOutlineItem, OutlineTarget } from './viewer/types'
import { parseMarkdownHeadings } from './viewer/outline'
import { useDismiss } from './dismiss'
import { useFloatingBox } from './floatingBox'
import { planChapters, type ChapterPlan } from './fulltextPlan'
import { sliceFulltext } from './fulltextRange'
import type { Translate } from './locales'
import { tpl } from './locales'
import { ACCENT, SOFT_BUTTON_STYLE } from './styles'
import { estimateTokens } from './tokens'

interface Props {
  t: Translate
  open: boolean
  detail: ZoteroItemDetail
  /** 目录浮层那份章节列表（按当前文档归属；null = 还没解析出来）。 */
  outline: DocumentOutlineItem[] | null
  attachmentTitle: string
  /** 几何测量基准：覆盖阅读区的透明容器（InfoPanel 的 rootRef）。 */
  anchorRef: { readonly current: HTMLElement | null }
  /** 触发按钮：算「浮层内部」，点它不被判成点外面而先关一次。 */
  triggerRef: { readonly current: HTMLElement | null }
  onClose(): void
  /** 确认：range 是范围表达式，scope 是人读范围标注（进 chip 标签与展开文本头部）。 */
  onConfirm(range: string, scope: string, quote: string, target?: OutlineTarget): void
  /** 从插入菜单哪一项进来：决定打开时方式下拉预选哪种（缺省按章节）。 */
  initialMode?: FulltextMode
}

/** 四种范围方式，与下拉选项及插入菜单一致。 */
export type FulltextMode = 'all' | 'chapter' | 'chars' | 'headings'

const PANEL_WIDTH = 380
const PANEL_MIN_WIDTH = 300
const PANEL_MIN_HEIGHT = 260
/**
 * 高度上限 = 视口高度的一半。
 *
 * 章节列表长度由文档决定，几十上百节的 PDF 会从顶栏一路铺到窗口底，把整块正文
 * 遮掉（这个浮层只是为了挑几节，没必要占满屏）。封到一半后列表自己在
 * `bodyStyle` 里滚动，头尾（方式下拉 / 字数与按钮）始终露着。
 */
const PANEL_MAX_HEIGHT_RATIO = 0.5
const SCOPE_BOX_KEY = '__fulltext_scope__'

export function FulltextScope({
  t, open, detail, outline, attachmentTitle, anchorRef, triggerRef, onClose, onConfirm, initialMode,
}: Props): ReactElement | null {
  const [mode, setMode] = useState<FulltextMode>(initialMode ?? 'chapter')
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [start, setStart] = useState('0')
  const [end, setEnd] = useState('')
  const [fromTitle, setFromTitle] = useState('')
  const [toTitle, setToTitle] = useState('')

  const content = detail.fulltext?.content ?? ''
  /** 截断前的真实字数；未截断时就是正文长度。老 Host 没有该字段时退回正文长度。 */
  const totalAll = Math.max(detail.fulltext?.totalChars ?? content.length, content.length)
  const items = useMemo(() => outline ?? [], [outline])
  /**
   * 这份文档有没有章节可挑。没有时下拉里的「按章节」置灰，且当前方式自动退到字符区间 ——
   * 否则会停在一个只剩一句「没有可解析的章节」的死路上（方式本身也选不回来）。
   */
  const hasChapters = items.length > 0
  /**
   * 「标题区间」只认 Markdown `#` 标题（PDF / 网页快照的标题在另一套字符空间里，
   * 拿 `#` 去它们正文里找必然为空），所以这里独立算一次，**不按当前方式门控**：
   * 下拉里要在没切过去的时候就把它置灰。
   */
  const markdownTitles = useMemo(() => parseMarkdownHeadings(content).map((item) => item.title), [content])
  const hasHeadings = markdownTitles.length > 0
  /** 选中的方式不可用时退到字符区间（那里永远有得选），别把用户锁在禁用项上。 */
  const activeMode: FulltextMode = (mode === 'chapter' && !hasChapters) || (mode === 'headings' && !hasHeadings)
    ? 'chars'
    : mode

  const box = useFloatingBox({
    open,
    anchorRef,
    itemKey: SCOPE_BOX_KEY,
    kind: 'info',
    persist: false,
    width: PANEL_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
    maxHeightRatio: PANEL_MAX_HEIGHT_RATIO,
  })
  useDismiss(open, box.panelRef, onClose, { extraRef: triggerRef })

  // 每次打开重置到菜单指定的方式（默认按章节），避免上次的选择带到下一条文献。
  useEffect(() => {
    if (!open) return
    setMode(initialMode ?? 'chapter')
    setSelected(new Set())
    setStart('0')
    setEnd(String(content.length))
    setFromTitle('')
    setToTitle('')
  }, [open, detail.key, detail.fulltext?.revision, detail.fulltext?.attachmentKey, content.length, initialMode])

  // 当前模式下的范围方案与计数。
  const plan: ChapterPlan | null = useMemo(() => {
    switch (activeMode) {
      case 'all':
        return { range: 'all', scope: t('fulltext.scope.all'), chars: content.length, estimated: false, fallbackAll: false }
      case 'chapter':
        return planChapters(content, items, selected, t)
      case 'chars': {
        const a = Math.min(content.length, Math.max(0, Math.trunc(Number(start) || 0)))
        const b = Math.min(content.length, Math.max(0, Math.trunc(Number(end) || 0)))
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        if (hi <= lo) return null
        return {
          range: `c:${lo}:${hi}`,
          scope: tpl(t('fulltext.scope.chars'), { value: `${lo}–${hi}` }),
          chars: hi - lo,
          estimated: false,
          fallbackAll: false,
        }
      }
      case 'headings': {
        if (fromTitle === '' || toTitle === '' || fromTitle === toTitle) return null
        return {
          range: `h:${encodeURIComponent(fromTitle)}:${encodeURIComponent(toTitle)}`,
          scope: tpl(t('fulltext.scope.headings'), { value: `${fromTitle} – ${toTitle}` }),
          chars: 0,
          estimated: false,
          fallbackAll: false,
        }
      }
    }
  }, [activeMode, content, items, selected, t, start, end, fromTitle, toTitle])

  /**
   * 真正会被插入的那段正文。
   *
   * 字数从它算，不再用 `plan.chars`：「标题区间」在 plan 里给的是 0
   * （规划阶段不知道两段标题之间多长），照那个数显示会变成「已选约 0 字」。
   */
  const slice = useMemo(() => {
    if (plan === null || (activeMode === 'chapter' && plan.fallbackAll)) return null
    try {
      return sliceFulltext(content, plan.range)
    } catch {
      // 表达式理论上都由本文件 / `fulltextPlan` 生成，不该解析失败；真失败也别让
      // 渲染崩掉——退回 plan 给的估算字数。
      return null
    }
  }, [activeMode, content, plan])
  const chars = slice?.text.length ?? 0

  /**
   * 真正占上下文的是 token，不是字数：选了 7,000 字的中文正文，等于两三万 token。
   *
   * 从切片算而不是按 `chars` 反推——中英比例不同差得远（同一段「字数」在纯英文
   * 里约是 1/2.4 的 token）。整篇的 token 仍报在插入菜单那一行，这里只管当前范围。
   */
  const tokens = useMemo(() => estimateTokens(slice?.text ?? ''), [slice])

  function toggleChapter(index: number): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  function confirm(): void {
    if (plan === null || !slice?.text || detail.fulltext?.revision === undefined) return
    onConfirm(
      `${plan.range}|${encodeURIComponent(plan.scope)}`,
      plan.scope,
      slice.text.trimStart().slice(0, 240),
      plan.target,
    )
  }

  if (!open || box.style === null) return null

  const fallbackAll = plan?.fallbackAll === true || slice?.fallbackAll === true
  const estimated = !fallbackAll && (plan?.estimated === true || slice?.estimated === true)
  const canConfirm = Boolean(slice?.text && detail.fulltext?.revision)
  const countLabel = plan === null
    ? t('fulltext.invalidRange')
    : fallbackAll && activeMode === 'chapter'
      ? t('review.chaptersUnlocated')
      : fallbackAll
        ? tpl(t('fulltext.chapterFallback'), { n: content.length.toLocaleString() })
      : tpl(t('fulltext.charCount'), { n: chars.toLocaleString(), total: totalAll.toLocaleString() })

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

      {/*
        方式：原来「按章节 / 更多方式」两个胶囊加三个单选框，五个控件才定得下一个范围；
        现在一枚原生下拉，选完下方直接换对应区域，确认仍是一步。
      */}
      <p style={{ margin: '0 0 6px' }}>{tpl(t('fulltext.attachment'), { name: attachmentTitle })}</p>
      {detail.fulltext?.truncated && (
        <p style={{ margin: '0 0 6px', color: '#d29922' }}>
          {tpl(t('fulltext.indexTruncated'), { shown: content.length.toLocaleString(), total: totalAll.toLocaleString() })}
        </p>
      )}
      <div style={modeRowStyle}>
        <span style={modeLabelStyle}>{t('fulltext.mode.label')}</span>
        <select
          value={activeMode}
          onChange={(event) => setMode(event.target.value as FulltextMode)}
          aria-label={t('fulltext.mode.label')}
          style={selectStyle}
        >
          <option value="all">{t('fulltext.scope.all')}</option>
          {/* 没有章节就把「按章节」置灰：原生 option 的 disabled 自带灰化，点不动也选不上。 */}
          <option value="chapter" disabled={!hasChapters}>
            {hasChapters
              ? tpl(t('fulltext.option.chapter'), { n: items.length })
              : t('fulltext.mode.chapterNoSections')}
          </option>
          <option value="chars">{t('fulltext.option.chars')}</option>
          {/* 同理：正文里没有 `#` 标题就没什么可挑的区间，置灰标成「无标题」。 */}
          <option value="headings" disabled={!hasHeadings}>
            {hasHeadings ? t('fulltext.option.headings') : t('fulltext.mode.headingsNoTitles')}
          </option>
        </select>
      </div>

      <div style={bodyStyle}>
        {activeMode === 'chapter' && (
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

        {activeMode === 'chars' && (
          <div style={inputRowStyle}>
            <input type="number" value={start} onChange={(e) => setStart(e.target.value)} style={numberInputStyle} aria-label={t('fulltext.start')} />
            <span style={dashStyle}>—</span>
            <input type="number" value={end} onChange={(e) => setEnd(e.target.value)} style={numberInputStyle} aria-label={t('fulltext.end')} />
          </div>
        )}

        {activeMode === 'headings' && markdownTitles.length === 0 && (
          <p style={hintStyle}>{t('fulltext.headingsHint')}</p>
        )}
        {activeMode === 'headings' && markdownTitles.length > 0 && (
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

        {slice?.text && (
          <details style={{ marginTop: 8 }}>
            <summary>{t('fulltext.preview')}</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflow: 'auto' }}>
              {slice.text}
            </pre>
          </details>
        )}
      </div>

      <div style={footerStyle}>
        <span style={footerTextStyle}>
          <span style={countStyle}>{countLabel}</span>
          {estimated && !fallbackAll && <span style={countStyle}>{t('fulltext.estimateHint')}</span>}
          {tokens > 0 && (
            <span style={tokenStyle} title={t('fulltext.tokenHint')}>
              {tpl(t('fulltext.tokens'), { n: tokens.toLocaleString() })}
            </span>
          )}
        </span>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={confirm}
          style={{
            ...SOFT_BUTTON_STYLE,
            ...confirmStyle,
            ...(!canConfirm ? { opacity: 0.45, cursor: 'not-allowed' as const } : {}),
          }}
        >
          {/* 只有落地为「加入对话」时才配聊天气泡；「插入整篇 / 确认估算范围」是另一层语义。 */}
          {!(estimated || (fallbackAll && activeMode !== 'chapter')) && <ChatIcon size={12} />}
          {fallbackAll && activeMode !== 'chapter' ? t('fulltext.confirmAll') : t(estimated ? 'fulltext.confirmEstimate' : 'fulltext.confirm')}
        </button>
      </div>
    </div>
  )
}

function pageOf(item: DocumentOutlineItem): string {
  const target = item.target
  return target?.kind === 'page' ? `P${target.page}` : ''
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

/** 方式行：一枚下拉吃掉原来「两个胶囊 + 三个单选」的位置。 */
const modeRowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, padding: '9px 0 5px' } as const
const modeLabelStyle = { flexShrink: 0, fontSize: 11, opacity: 0.7 } as const

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

const inputRowStyle = { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0' } as const
const numberInputStyle = {
  width: 92, height: 24, padding: '0 6px', fontSize: 12,
  borderRadius: 4, border: '1px solid rgba(127,127,127,0.4)', background: 'Canvas', color: 'CanvasText',
} as const
const selectStyle = {
  flex: 1, minWidth: 0, height: 28, padding: '0 4px', fontSize: 12,
  borderRadius: 5, border: '1px solid rgba(127,127,127,0.4)', background: 'Canvas', color: 'CanvasText',
} as const
const dashStyle = { opacity: 0.6 } as const

const footerStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  flexShrink: 0, paddingTop: 8, marginTop: 6, borderTop: '1px solid rgba(127,127,127,0.2)',
} as const
/** 左侧两行：字数在上、token 在下（与插入菜单「整篇全文」那一行的排法一致）。 */
const footerTextStyle = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  lineHeight: 1.25,
} as const
const countStyle = { fontSize: 11, opacity: 0.7 } as const
/** token 是估算值，比字数更淡一档，不跟「已选 N 字」抢注意力。 */
const tokenStyle = { fontSize: 10.5, opacity: 0.5, fontVariantNumeric: 'tabular-nums' } as const
const confirmStyle = {
  height: 26, padding: '0 12px', fontSize: 11.5, lineHeight: 1,
  borderRadius: 13, cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', gap: 4,
} as const
