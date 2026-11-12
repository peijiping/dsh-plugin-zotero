/**
 * 右栏：单条条目详情（文档优先）。
 *
 * 版面只有文档本身，元数据 / 摘要 / 标注 / 笔记 / 附件收进左上角的悬浮信息按钮。
 * 具体格式交给 `viewer/registry`：PDF 走 PDF.js，其余回退到全文文本；
 * 新增 Word 等格式只需注册新的渲染器。
 *
 * 标注定位跨附件：当前展示的 PDF 与标注不属于同一份时，先切到标注所在附件，
 * 等渲染器就绪后再滚动并闪烁。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { fileUrl, openInZotero, snapshotUrl } from './api'
import { isLocatable, type AnnotationFilter } from './annotationRuns'
import { InfoPanel } from './InfoPanel'
import type { InsertOutcome } from './inline'
import { tpl, type Translate } from './locales'
import { OutlinePanel } from './OutlinePanel'
import { showToast } from './paneStore'
import { shotWatermark } from './compose'
import { DocumentView } from './viewer/DocumentView'
import { useShotController } from './viewer/shot/controller'
import { buildShotMeta } from './viewer/shot/metadata'
import type { ShotMeta } from './viewer/shot/types'
import { pickRenderer } from './viewer/registry'
import {
  extensionOf,
  isHtml,
  isPdf,
  type DocumentOutlineItem,
  type DocumentSource,
  type ViewerHandle,
} from './viewer/types'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  /** 信息面板里的「引用」：整条目元数据。 */
  onInsertItem(): void
  /** 插入全文选区摘录。 */
  onInsertExcerpt(quote: string): void
  /** 插入一段划词翻译（原文 + 译文）。 */
  onInsertTranslation(quote: string, translated: string): void
  /** 插一条标注的引用 chip（chip 里是原文摘要，提交时展开为完整引用文本）。 */
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  /** 插一条笔记的引用 chip（提交时展开为笔记正文）。 */
  onInsertNote(note: ZoteroNote): void
  /** 面板里写成功后重取详情（静默，不打断当前阅读位置）。 */
  onChanged(): void
  /** 阅读器工具条上的页面级刷新：重取整份详情，返回 Promise 供按钮显示进行中。 */
  onRefresh(): Promise<void>
  /** 截图插入（图片附件 + `shot:` chip）；缺失时截图按钮仍可点，插入给出明确提示。 */
  onInsertShot?(png: Blob, meta: ShotMeta): InsertOutcome
}

/** 定位重试：渲染器刚就绪时页面占位可能还没提交，最多试几次。 */
const LOCATE_RETRIES = 6
const LOCATE_RETRY_MS = 60

/**
 * 目录缓存按「当前文档」归属。
 *
 * 存 key 而不是清空：切附件 / 切条目时新渲染器要重新解析（PDF 书签、快照网页标题、
 * 笔记标题都是几十到几百毫秒），这段时间面板若拿上一条的目录顶上，就会跳错位置。
 * 归属对不上就当作「还没读到」。独立笔记没有附件，所以 key 里要带上条目自身。
 */
interface OutlineState {
  documentKey: string
  /** `null` = 还没读到；空数组 = 这份文档没有目录。 */
  items: DocumentOutlineItem[] | null
}

/** 目录来源说明：同一份浮层服务三类文档，给用户一句口径。 */
const OUTLINE_SOURCE_LABEL: Record<string, string> = {
  pdf: 'outline.source.pdf',
  snapshot: 'outline.source.snapshot',
  note: 'outline.source.note',
  text: 'outline.source.text',
  webpage: 'outline.source.text',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function attachmentSource(attachment: ZoteroItemDetail['attachments'][number]): DocumentSource {
  const ext = extensionOf(attachment.filename || attachment.title)
  const source: DocumentSource = {
    attachmentKey: attachment.key,
    contentType: attachment.contentType,
    ext,
    title: attachment.title,
    url: '',
  }
  // 网页快照走目录形路由（iframe 直接指过来），其余仍是原始文件流。
  source.url = isHtml(source) ? snapshotUrl(attachment.key) : fileUrl(attachment.key)
  return source
}

export function ItemDetail({ t, detail, onInsertItem, onInsertExcerpt, onInsertTranslation, onInsertAnnotation, onInsertNote, onChanged, onRefresh, onInsertShot }: Props): ReactElement {
  const [infoOpen, setInfoOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outline, setOutline] = useState<OutlineState>({ documentKey: '', items: null })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>({ type: 'all', color: null })
  /** 页面级刷新的进行中状态：工具条按钮在 `DocumentView`，动作来源在 `ZoteroItemPane`。 */
  const [refreshing, setRefreshing] = useState(false)
  const [stateKey, setStateKey] = useState(detail.key)
  const viewerRef = useRef<ViewerHandle | null>(null)
  /** 截图范围的唯一边界：正文容器（不含 30px 工具条与左上角悬浮按钮）。 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  /** 悬浮按钮行的宽度驱动工具条 paddingLeft；42 = 行 left(34) + 右侧留白(8)。 */
  const [topbarPad, setTopbarPad] = useState(158)
  const handleRowWidth = useCallback((width: number): void => {
    setTopbarPad(Math.ceil(width) + 42)
  }, [])
  const pendingLocate = useRef<string | null>(null)
  const locateTimer = useRef<number | null>(null)

  // 切条目时重置（渲染期调整态，React 认可的 props 派生写法）。
  if (stateKey !== detail.key) {
    setStateKey(detail.key)
    setSelectedKey(null)
    setAnnotationFilter({ type: 'all', color: null })
    setInfoOpen(false)
    setOutlineOpen(false)
    setRefreshing(false)
    pendingLocate.current = null
  }

  useEffect(() => () => {
    if (locateTimer.current !== null) window.clearTimeout(locateTimer.current)
  }, [])

  const isNote = detail.itemType === 'note'
  const attachments = detail.attachments
  const attachment = attachments.find((item) => item.key === selectedKey)
    ?? attachments.find((item) => item.key === detail.fulltext?.attachmentKey)
    ?? attachments.find((item) => isPdf({ contentType: item.contentType, ext: extensionOf(item.filename || item.title) }))
    ?? attachments[0]
    ?? null

  const source: DocumentSource | null = isNote
    ? null
    : attachment !== null
      ? attachmentSource(attachment)
      : detail.fulltext !== null
        ? {
            attachmentKey: detail.fulltext.attachmentKey,
            contentType: '',
            ext: '',
            title: detail.title,
            url: '',
          }
        : null

  /** 收起信息浮层；`InfoPanel` 内部再用 `useDismiss` 接管「点浮层外 / Esc」。 */
  const closeInfo = useCallback((): void => setInfoOpen(false), [])

  /**
   * 页面级刷新：状态放这一层，工具条按钮与整份详情共用同一份。
   *
   * `ZoteroItemPane` 的刷新已经吞掉错误（只出 toast），这里只负责「进行中」，
   * 按钮在此期间禁用并显示「正在刷新…」，避免连点叠出一串请求。
   */
  async function handleRefresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  // 独立笔记没有附件，光用 attachmentKey 会让两篇笔记共用一份缓存。
  const documentKey = `${detail.key}:${source?.attachmentKey ?? 'self'}`
  /** 归属对不上的目录一律当「还没读到」，绝不用上一条文献的书签跳页。 */
  const outlineItems = outline.documentKey === documentKey ? outline.items : null
  const handleOutlineChange = useCallback((items: DocumentOutlineItem[]): void => {
    setOutline({ documentKey, items })
  }, [documentKey])
  const renderer = pickRenderer(source, detail)
  /** 目录按钮按渲染器能力出现：PDF / 快照 / 笔记 / 全文共用左上角那一个浮层。 */
  const outlineAvailable = renderer.capabilities.outline

  /** 截图状态机：能力来自渲染器，位图统一交给 shot/ 的 adapter 合成。 */
  const shot = useShotController({
    t,
    kind: renderer.capabilities.capture,
    getRoot: () => contentRef.current,
    buildMeta: (frame, rect) => buildShotMeta({ detail, source, outline: outlineItems, frame, rect }),
    watermark: (meta) => shotWatermark(t, meta),
    insert: (png, meta) => onInsertShot?.(png, meta) ?? 'no-conversation',
  })
  /** 启动前显式清场：两个浮层盖在同一块位置，定格图里不该出现它们。 */
  const startScreenshot = useCallback((): void => {
    setInfoOpen(false)
    setOutlineOpen(false)
    shot.start()
  }, [shot.start])
  const outlineSourceLabel = t(OUTLINE_SOURCE_LABEL[detail.itemType === 'note' ? 'note' : renderer.id]
    ?? 'outline.source.text')

  const flushPendingLocate = useCallback((key: string, attempt: number): void => {
    if (locateTimer.current !== null) {
      window.clearTimeout(locateTimer.current)
      locateTimer.current = null
    }
    if (viewerRef.current?.locate(key) === true) return
    if (attempt >= LOCATE_RETRIES) return
    locateTimer.current = window.setTimeout(() => {
      locateTimer.current = null
      flushPendingLocate(key, attempt + 1)
    }, LOCATE_RETRY_MS)
  }, [])

  const onReady = useCallback((): void => {
    const key = pendingLocate.current
    if (key === null) return
    pendingLocate.current = null
    flushPendingLocate(key, 0)
  }, [flushPendingLocate])

  function locateAnnotation(annotation: ZoteroAnnotation): void {
    setInfoOpen(false)
    const shownKey = source?.attachmentKey ?? null
    // 网页标注的 `position` 恒为 null，只看它会把「切到快照再定位」整条路堵死。
    const onOtherAttachment = isLocatable(annotation)
      && annotation.attachmentKey !== shownKey
      && attachments.some((item) => item.key === annotation.attachmentKey)
    if (onOtherAttachment) {
      pendingLocate.current = annotation.key
      setSelectedKey(annotation.attachmentKey)
      return
    }
    flushPendingLocate(annotation.key, 0)
  }

  function selectAttachment(key: string): void {
    pendingLocate.current = null
    setSelectedKey(key)
  }

  function openInZoteroAt(page: number): void {
    // `zotero://open-pdf` 只对 PDF 有效；HTML 快照改成「选中这个附件」，
    // 否则点了没反应，用户会以为插件坏了。
    const isSnapshot = source !== null && isHtml(source)
    const input = source === null
      ? { key: detail.key, kind: 'item' as const }
      : isSnapshot
        ? { key: source.attachmentKey, kind: 'item' as const }
        : { key: source.attachmentKey, kind: 'attachment' as const, page }
    openInZotero(input).catch((error: unknown) => {
      showToast(tpl(t('viewer.openFailed'), { message: errorMessage(error) }))
    })
  }

  /**
   * 跳到一条目录项。
   *
   * 目标原样交给渲染器：PDF 按页、网页快照 / 笔记按标题锚点，面板不解释。
   * **跳完不收起**：目录浮层保持打开，可以连着点好几条反复导航；收起交给
   * `OutlinePanel` 的 `useDismiss`（点浮层外 / 按 Esc）或再点一次目录按钮。
   */
  function jumpToOutline(item: DocumentOutlineItem): void {
    if (item.target !== null) viewerRef.current?.goToOutline(item.target)
  }

  return (
    <div style={{ ...rootStyle, '--dsh-zp-topbar-pad': `${topbarPad}px` } as CSSProperties}>
      <DocumentView
        t={t}
        detail={detail}
        source={source}
        annotations={detail.annotations}
        viewerRef={viewerRef}
        onReady={onReady}
        onInsertExcerpt={onInsertExcerpt}
        onInsertTranslation={onInsertTranslation}
        onInsertAnnotation={onInsertAnnotation}
        onOpenInZotero={openInZoteroAt}
        onChanged={onChanged}
        refreshing={refreshing}
        onRefresh={() => void handleRefresh()}
        onOutlineChange={handleOutlineChange}
        contentRef={contentRef}
        shot={shot}
      />
      {/*
        采集中的短暂提示。故意挂在正文容器**外面**：`html-to-image` 会克隆
        contentRef 子树，提示层若在里面就会被拍进定格图。
      */}
      {shot.phase === 'capturing' && (
        <div style={capturingStyle} aria-live="polite">{t('shot.capturing')}</div>
      )}
      {outlineAvailable && (
        <OutlinePanel
          t={t}
          items={outlineItems}
          sourceLabel={outlineSourceLabel}
          open={outlineOpen}
          onToggle={() => {
            // 两个浮层同一块位置，开一个就收另一个，否则压在一起互相挡。
            if (!outlineOpen) setInfoOpen(false)
            setOutlineOpen(!outlineOpen)
          }}
          onClose={() => setOutlineOpen(false)}
          onJump={jumpToOutline}
        />
      )}
      <InfoPanel
        t={t}
        detail={detail}
        currentAttachmentKey={source?.attachmentKey ?? null}
        open={infoOpen}
        onToggle={() => {
          if (!infoOpen) setOutlineOpen(false)
          setInfoOpen(!infoOpen)
        }}
        onClose={closeInfo}
        onCite={onInsertItem}
        onSelectAttachment={selectAttachment}
        onLocateAnnotation={locateAnnotation}
        onInsertAnnotation={onInsertAnnotation}
        onInsertNote={onInsertNote}
        onChanged={onChanged}
        annotationFilter={annotationFilter}
        onAnnotationFilterChange={setAnnotationFilter}
        onScreenshot={startScreenshot}
        screenshotAvailable={shot.available}
        screenshotReason={shot.unavailableReason}
        onRowWidth={handleRowWidth}
      />
    </div>
  )
}

const rootStyle = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
} as const

/** 采集进行中的覆盖提示：只遮正文（工具条 30px 高），不拦指针。 */
const capturingStyle = {
  position: 'absolute',
  top: 30,
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 23,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0,0,0,0.18)',
  color: 'CanvasText',
  fontSize: 12,
  letterSpacing: '0.02em',
  pointerEvents: 'none',
} as const
