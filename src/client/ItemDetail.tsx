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

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { fileUrl, openInZotero, snapshotUrl } from './api'
import { isLocatable, type AnnotationFilter } from './annotationRuns'
import { InfoPanel } from './InfoPanel'
import { tpl, type Translate } from './locales'
import { OutlinePanel } from './OutlinePanel'
import { showToast } from './paneStore'
import { DocumentView } from './viewer/DocumentView'
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
  /** 插一条标注的引用 chip（chip 里是原文摘要，提交时展开为完整引用文本）。 */
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  /** 插一条笔记的引用 chip（提交时展开为笔记正文）。 */
  onInsertNote(note: ZoteroNote): void
  /** 面板里写成功后重取详情（静默，不打断当前阅读位置）。 */
  onChanged(): void
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

export function ItemDetail({ t, detail, onInsertItem, onInsertExcerpt, onInsertAnnotation, onInsertNote, onChanged }: Props): ReactElement {
  const [infoOpen, setInfoOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outline, setOutline] = useState<OutlineState>({ documentKey: '', items: null })
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilter>({ type: 'all', color: null })
  const [stateKey, setStateKey] = useState(detail.key)
  const viewerRef = useRef<ViewerHandle | null>(null)
  const pendingLocate = useRef<string | null>(null)
  const locateTimer = useRef<number | null>(null)

  // 切条目时重置（渲染期调整态，React 认可的 props 派生写法）。
  if (stateKey !== detail.key) {
    setStateKey(detail.key)
    setSelectedKey(null)
    setAnnotationFilter({ type: 'all', color: null })
    setInfoOpen(false)
    setOutlineOpen(false)
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
   * 跳完就收起目录：浮层压在文档左边，留着会把刚跳过去的内容挡掉一半。
   */
  function jumpToOutline(item: DocumentOutlineItem): void {
    setOutlineOpen(false)
    if (item.target !== null) viewerRef.current?.goToOutline(item.target)
  }

  return (
    <div style={rootStyle}>
      <DocumentView
        t={t}
        detail={detail}
        source={source}
        annotations={detail.annotations}
        viewerRef={viewerRef}
        onReady={onReady}
        onInsertExcerpt={onInsertExcerpt}
        onInsertAnnotation={onInsertAnnotation}
        onOpenInZotero={openInZoteroAt}
        onChanged={onChanged}
        onOutlineChange={handleOutlineChange}
      />
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
