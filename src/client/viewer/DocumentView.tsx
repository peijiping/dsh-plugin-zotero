/**
 * 文档视图外壳：选渲染器、挂工具条、把页面级状态留给渲染器。
 *
 * 这里不关心文档格式——PDF / 文本 / 将来的 Word 都从 `registry` 里挑。
 * 工具条只按渲染器的 `capabilities` 显示缩放与页码控件。
 */

import { useCallback, useRef, useState, type MutableRefObject, type ReactElement } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail } from '../../zotero/types'
import { tpl, type Translate } from '../locales'
import { SOFT_BUTTON_CLASS, SOFT_BUTTON_STYLE } from '../styles'
import { OpenInZoteroIcon } from './OpenInZoteroIcon'
import { pickRenderer } from './registry'
import type { DocumentOutlineItem, DocumentSource, ViewerHandle } from './types'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  source: DocumentSource | null
  annotations: ZoteroAnnotation[]
  viewerRef: MutableRefObject<ViewerHandle | null>
  onReady(): void
  onInsertExcerpt(quote: string): void
  onInsertTranslation(quote: string, translated: string): void
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  onOpenInZotero(page: number): void
  onChanged(): void
  /**
   * 页面级刷新：重取整份详情（含页面上的标注）。状态由 {@link ItemDetail} 持有，
   * 工具条只显示；进行中禁用按钮、文案换成「正在刷新…」。
   */
  refreshing: boolean
  onRefresh(): void
  /** 渲染器报上来的目录（PDF 书签 / 网页标题 / 笔记标题），交给左上角统一的目录浮层。 */
  onOutlineChange(outline: DocumentOutlineItem[]): void
}

/**
 * 页码：输入框 + 「/ 总数」。
 *
 * 点进去整段选中，输入页码后回车或点别处即跳转，`Esc` 放弃。越界按 `1..total`
 * 夹住而不是报错 —— 输 999 的人只是想翻到最后。
 */
function PageField({ current, total, onJump, t }: {
  current: number
  total: number
  onJump(page: number): void
  t: Translate
}): ReactElement {
  /** 正在编辑时的草稿；`null` 表示没在编辑，显示外部传进来的当前页。 */
  const [draft, setDraft] = useState<string | null>(null)
  /** `Esc` 放弃：紧接着的 blur 不该提交。 */
  const cancelledRef = useRef(false)

  const commit = (): void => {
    const text = draft
    setDraft(null)
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    if (text === null) return
    const value = Number.parseInt(text, 10)
    if (Number.isNaN(value)) return
    onJump(Math.min(Math.max(value, 1), total))
  }

  return (
    <span style={pageStyle}>
      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(current)}
        title={t('viewer.pageJump')}
        aria-label={t('viewer.pageJump')}
        style={pageInputStyle}
        onFocus={(event) => {
          setDraft(String(current))
          event.currentTarget.select()
        }}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/gu, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
            return
          }
          if (event.key === 'Escape') {
            cancelledRef.current = true
            event.currentTarget.blur()
          }
        }}
      />
      <span style={{ whiteSpace: 'nowrap', opacity: 0.72 }}>{tpl(t('viewer.pageTotal'), { total })}</span>
    </span>
  )
}

/**
 * 放大镜图标：镜筒里一根横线是缩小，再加一根竖线是放大，把手朝右下。
 *
 * 纯 `currentColor` 描边，深浅主题都跟着文字走。
 */
function ZoomIcon({ kind }: { kind: 'in' | 'out' }): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
        <circle cx="6.8" cy="6.8" r="4.4" />
        <line x1="10.15" y1="10.15" x2="13.6" y2="13.6" />
        <line x1="4.8" y1="6.8" x2="8.8" y2="6.8" />
        {kind === 'in' && <line x1="6.8" y1="4.8" x2="6.8" y2="8.8" />}
      </g>
    </svg>
  )
}

/**
 * 页面级刷新按钮的循环箭头。
 *
 * 进行中靠全局 `.dsh-zp-refresh-spin` 转起来，文字不再换成「正在刷新…」——
 * 按钮窄了放不下长文案，进度改由图标旋转 + 禁用态 + `title`/`aria-label` 表达。
 * 防重复点击靠的是 `disabled` 与 `ZoteroItemPane` 里的请求序号。
 */
function RefreshIcon({ spinning }: { spinning: boolean }): ReactElement {
  return (
    <svg
      className={spinning ? 'dsh-zp-refresh-spin' : undefined}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 8a5 5 0 1 1-1.5-3.55" />
        <path d="M13.2 3.1v3.2H10" />
      </g>
    </svg>
  )
}

export function DocumentView({
  t,
  detail,
  source,
  annotations,
  viewerRef,
  onReady,
  onInsertExcerpt,
  onInsertTranslation,
  onInsertAnnotation,
  onOpenInZotero,
  onChanged,
  refreshing,
  onRefresh,
  onOutlineChange,
}: Props): ReactElement {
  const renderer = pickRenderer(source, detail)
  const Renderer = renderer.Component
  const [page, setPage] = useState({ current: 1, total: 0 })

  /**
   * 缩放比例不再显示，但这个回调渲染器还得有（`RendererProps` 必填）。
   * 留着空实现而不是改接口：唯一用处是给工具条写字，删掉它要动三个渲染器。
   */
  const handleZoomChange = useCallback((): void => {}, [])
  const handlePageChange = useCallback((current: number, total: number): void => {
    setPage({ current, total })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={barStyle}>
        <span style={titleStyle} title={source?.title ?? detail.title}>{source?.title ?? detail.title}</span>
        {renderer.capabilities.pageNavigation && page.total > 0 && (
          <PageField
            current={page.current}
            total={page.total}
            onJump={(target) => viewerRef.current?.goToPage(target)}
            t={t}
          />
        )}
        {renderer.capabilities.zoom && (
          <>
            <span style={barDividerStyle} aria-hidden="true" />
            <span style={zoomGroupStyle}>
              <button
                type="button"
                onClick={() => viewerRef.current?.zoomOut()}
                style={iconButtonStyle}
                aria-label={t('viewer.zoomOut')}
                title={t('viewer.zoomOut')}
              >
                <ZoomIcon kind="out" />
              </button>
              <button
                type="button"
                onClick={() => viewerRef.current?.zoomIn()}
                style={iconButtonStyle}
                aria-label={t('viewer.zoomIn')}
                title={t('viewer.zoomIn')}
              >
                <ZoomIcon kind="in" />
              </button>
            </span>
          </>
        )}
        <button
          type="button"
          className={SOFT_BUTTON_CLASS}
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={refreshing ? t('detail.refreshing') : t('action.refresh')}
          title={refreshing ? t('detail.refreshing') : t('detail.refreshHint')}
          style={refreshing ? { ...refreshButtonStyle, cursor: 'default' } : refreshButtonStyle}
        >
          <RefreshIcon spinning={refreshing} />
          <span style={refreshLabelStyle}>{t('action.refresh')}</span>
        </button>
        <button
          type="button"
          onClick={() => onOpenInZotero(page.current)}
          style={{ ...toolButtonStyle, marginLeft: 4 }}
          title={t('viewer.openInZotero')}
        >
          <OpenInZoteroIcon />
          {t('viewer.openInZoteroShort')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Renderer
          key={source?.attachmentKey ?? 'none'}
          t={t}
          detail={detail}
          source={source}
          annotations={annotations}
          viewerRef={viewerRef}
          onReady={onReady}
          onZoomChange={handleZoomChange}
          onPageChange={handlePageChange}
          onInsertExcerpt={onInsertExcerpt}
          onInsertTranslation={onInsertTranslation}
          onInsertAnnotation={onInsertAnnotation}
          onOpenInZotero={onOpenInZotero}
          onChanged={onChanged}
          onOutlineChange={onOutlineChange}
        />
      </div>
    </div>
  )
}

/**
 * 左侧留出三个悬浮按钮（目录 / 文献信息 / 加入对话）的位置，标题居中显示在剩下这段里。
 *
 * 悬浮按钮是绝对定位、盖在工具条上的（见 `OutlinePanel` / `InfoPanel`：8 + 22 + 4 一格，
 * 第三格「加入对话」到 124 为止），所以这里的 `paddingLeft` 必须一起改，否则标题从按钮底下钻出来。
 */
const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
  height: 30,
  padding: '0 8px 0 132px',
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  background: 'transparent',
} as const

const titleStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  fontSize: 11,
  opacity: 0.62,
} as const

/**
 * 工具条里相邻两组控件之间的额外间距（页码 ↔ 缩放 ↔ Zotero）。
 *
 * 组内只隔 4（工具条的 `gap`），组间靠这个拉开，否则 `1 / 3` 和两个放大镜会连成一片。
 */
const GROUP_GAP = 10

const pageStyle = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
} as const

/** 页码输入框：看起来像一段文字，但可点、可改。 */
const pageInputStyle = {
  width: 32,
  height: 18,
  padding: '0 3px',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'right',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.28)',
  background: 'transparent',
  color: 'inherit',
  outline: 'none',
} as const

/** 页码区与缩放区之间的竖线：比纯靠留白更能看出是两组。 */
const barDividerStyle = {
  flexShrink: 0,
  width: 1,
  height: 14,
  margin: '0 3px 0 8px',
  background: 'rgba(127,127,127,0.28)',
} as const

/** 缩放组（两个放大镜）：不再显示百分比，纯图标。 */
const zoomGroupStyle = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
} as const

/** 无边框图标按钮：放大镜本身当按钮，不再套一层方框。 */
const iconButtonStyle = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  padding: 0,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.75,
  cursor: 'pointer',
} as const

const toolButtonStyle = {
  ...SOFT_BUTTON_STYLE,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  height: 22,
  minWidth: 22,
  padding: '0 5px',
  fontSize: 11.5,
  lineHeight: 1,
  borderRadius: 5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

/**
 * 页面级刷新：紧挨 `Zotero` 按钮左边（中间隔 4，与缩放组之间隔 GROUP_GAP）。
 *
 * 宽度从 106 收到 64（约 -40%）：因为文案恒定「刷新」两字，进行中按钮不变宽，
 * 工具条里的页码与标题不会左右跳。`minWidth` 只定下限，中文取 64，英文
 * 「Refresh」按内容自然撑宽一点，不会挤到换行或溢出。
 */
const REFRESH_BUTTON_MIN_WIDTH = 64

const refreshButtonStyle = {
  ...SOFT_BUTTON_STYLE,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  minWidth: REFRESH_BUTTON_MIN_WIDTH,
  height: 22,
  padding: '0 5px',
  marginLeft: GROUP_GAP,
  fontSize: 11.5,
  lineHeight: 1,
  borderRadius: 5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

/** 文案不许被 flex 压窄后换行；按钮宽度只按内容撑，不靠截断。 */
const refreshLabelStyle = {
  flexShrink: 0,
  whiteSpace: 'nowrap',
} as const
