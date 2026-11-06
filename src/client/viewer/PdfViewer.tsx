/**
 * PDF 渲染器：连续滚动 + 懒渲染 + 文本层 + 标注叠加 + 缩放。
 *
 * 缩放有两种模式：`fitWidth`（默认，随容器宽度重算）与手动百分比。
 * 页面 wrapper 始终存在（按第一页尺寸占位），因此滚动条高度稳定；
 * 只有视口附近（IntersectionObserver，rootMargin 150%）的页面才真正绘制 canvas
 * 与文本层，离开视口后释放 canvas 像素。
 */

import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

import {
  getDocument,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
  type RenderTask,
} from 'pdfjs-dist'

import type { ZoteroAnnotation } from '../../zotero/types'
import { hasComment, parseComment } from '../annotationComment'
import { annotationColor } from '../annotationRuns'
import { tpl, type Translate } from '../locales'
import { AnnotationOverlay } from './AnnotationOverlay'
import { viewportBox } from './geometry'
import { PDF_ASSET_BASE, PDF_CSS } from './pdfjs'
import type { DocumentRendererProps } from './types'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]
const GUTTER = 12
const FLASH_MS = 1600

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampScale(value: number): number {
  return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE)
}

function typeLabel(t: Translate, type: string): string {
  const key = `annotation.type.${type}`
  const label = t(key)
  return label === key ? type : label
}

/** 评论正文：白名单渲染加粗 / 斜体 / 上下标与换行。 */
function CommentBody({ comment }: { comment: string }): ReactElement {
  return (
    <div style={commentStyle}>
      {parseComment(comment).map((token, index) => {
        if (token.kind === 'break') return <br key={index} />
        let node: React.ReactNode = token.text
        if (token.sup) node = <sup>{node}</sup>
        if (token.sub) node = <sub>{node}</sub>
        if (token.italic) node = <i>{node}</i>
        if (token.bold) node = <b>{node}</b>
        return <span key={index}>{node}</span>
      })}
    </div>
  )
}

interface PageProps {
  t: Translate
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  estimateWidth: number
  estimateHeight: number
  annotations: ZoteroAnnotation[]
  flashKey: string | null
  onAnnotationClick(annotation: ZoteroAnnotation, clientX: number, clientY: number): void
}

function PdfPage({
  t,
  pdf,
  pageNumber,
  scale,
  estimateWidth,
  estimateHeight,
  annotations,
  flashKey,
  onAnnotationClick,
}: PageProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const taskRef = useRef<RenderTask | null>(null)
  const textLayerRef = useRef<TextLayer | null>(null)

  useEffect(() => {
    const element = wrapRef.current
    if (element === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry !== undefined) setVisible(entry.isIntersecting)
      },
      { rootMargin: '150% 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || page !== null) return
    let disposed = false
    pdf.getPage(pageNumber)
      .then((proxy) => {
        if (!disposed) setPage(proxy)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [pdf, pageNumber, visible, page])

  useEffect(() => {
    if (page === null) return
    setViewport(page.getViewport({ scale }))
  }, [page, scale])

  useEffect(() => {
    if (!visible || page === null || viewport === null) return
    const canvas = canvasRef.current
    const textDiv = textRef.current
    if (canvas === null || textDiv === null) return

    taskRef.current?.cancel()
    textLayerRef.current?.cancel()
    textLayerRef.current = null
    textDiv.textContent = ''

    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    taskRef.current = task

    let disposed = false
    task.promise
      .then(async () => {
        if (disposed || taskRef.current !== task) return
        const textContent = await page.getTextContent()
        if (disposed || taskRef.current !== task) return
        const layer = new TextLayer({ textContentSource: textContent, container: textDiv, viewport })
        textLayerRef.current = layer
        await layer.render()
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      task.cancel()
      textLayerRef.current?.cancel()
      textLayerRef.current = null
    }
  }, [visible, page, viewport])

  // 离开视口后释放 canvas 像素；滚回来会重新绘制。
  useEffect(() => {
    if (visible) return
    const canvas = canvasRef.current
    if (canvas === null) return
    canvas.width = 0
    canvas.height = 0
    if (textRef.current !== null) textRef.current.textContent = ''
  }, [visible])

  function hitTest(clientX: number, clientY: number): ZoteroAnnotation | null {
    const element = wrapRef.current
    if (element === null || viewport === null) return null
    const rect = element.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    for (const annotation of annotations) {
      for (const source of annotation.position?.rects ?? []) {
        const box = viewportBox(viewport, source)
        if (
          x >= box.left
          && x <= box.left + box.width
          && y >= box.top
          && y <= box.top + box.height
        ) {
          return annotation
        }
      }
    }
    return null
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    if (window.getSelection()?.toString().trim() !== '') return
    const annotation = hitTest(event.clientX, event.clientY)
    if (annotation !== null) onAnnotationClick(annotation, event.clientX, event.clientY)
  }

  const pageStyle: CSSProperties & Record<string, string | number> = {
    width: viewport?.width ?? estimateWidth,
    height: viewport?.height ?? estimateHeight,
    '--total-scale-factor': scale,
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
  }

  return (
    <div
      ref={wrapRef}
      data-zp-page={pageNumber}
      className="dsh-zotero-pdf-page"
      onClick={onClick}
      style={pageStyle}
      aria-label={tpl(t('viewer.page'), { n: pageNumber })}
    >
      <canvas ref={canvasRef} className="dsh-zotero-pdf-canvas" />
      <div ref={textRef} className="dsh-zotero-pdf-text" />
      {viewport !== null && (
        <AnnotationOverlay annotations={annotations} viewport={viewport} flashKey={flashKey} />
      )}
    </div>
  )
}

export function PdfViewer(props: DocumentRendererProps): ReactElement {
  const {
    t,
    source,
    annotations,
    viewerRef,
    onReady,
    onZoomChange,
    onPageChange,
    onInsertExcerpt,
    onInsertAnnotation,
    onOpenInZotero,
  } = props

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<{ ratio: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const flashTimerRef = useRef<number | null>(null)

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [fitWidth, setFitWidth] = useState(true)
  const [manualScale, setManualScale] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const [card, setCard] = useState<{ annotation: ZoteroAnnotation; x: number; y: number } | null>(null)
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)

  const currentPageRef = useRef(1)
  currentPageRef.current = currentPage
  const pageCountRef = useRef(0)
  pageCountRef.current = pageCount

  const url = source?.url ?? ''

  useEffect(() => {
    if (url === '') {
      setPdf(null)
      setLoading(false)
      setError(null)
      return
    }
    let disposed = false
    setLoading(true)
    setError(null)
    setPdf(null)
    setPageCount(0)
    setBaseSize(null)
    setCurrentPage(1)

    const task = getDocument({
      url,
      cMapUrl: `${PDF_ASSET_BASE}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDF_ASSET_BASE}standard_fonts/`,
      wasmUrl: `${PDF_ASSET_BASE}wasm/`,
    })
    task.promise
      .then(async (proxy) => {
        if (disposed) {
          await task.destroy()
          return
        }
        const first = await proxy.getPage(1)
        if (disposed) {
          await task.destroy()
          return
        }
        const base = first.getViewport({ scale: 1 })
        setPdf(proxy)
        setPageCount(proxy.numPages)
        setBaseSize({ width: base.width, height: base.height })
        setLoading(false)
        onReady()
      })
      .catch((loadError: unknown) => {
        if (disposed) return
        setError(errorText(loadError))
        setLoading(false)
      })

    return () => {
      disposed = true
      void task.destroy()
    }
  }, [url, retry, onReady])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      if (width > 0) setContainerWidth(width)
    })
    observer.observe(element)
    setContainerWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const fitScale = baseSize !== null && containerWidth > 0
    ? clampScale((containerWidth - GUTTER * 2) / baseSize.width)
    : 1
  const scale = fitWidth ? fitScale : manualScale

  useEffect(() => {
    onZoomChange({ percent: Math.round(scale * 100), fitWidth })
  }, [scale, fitWidth, onZoomChange])

  useEffect(() => {
    onPageChange(currentPage, pageCount)
  }, [currentPage, pageCount, onPageChange])

  const applyZoom = (next: number): void => {
    setFitWidth(false)
    setManualScale(clampScale(next))
  }

  // 手动缩放时，Ctrl/⌘ + 滚轮保持鼠标下的文档位置不变。
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const y = event.clientY - rect.top
      anchorRef.current = {
        ratio: element.scrollHeight > 0 ? (element.scrollTop + y) / element.scrollHeight : 0,
        y,
      }
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      setFitWidth(false)
      setManualScale(clampScale(scaleRef.current * factor))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const element = scrollRef.current
    if (anchor === null || element === null) return
    anchorRef.current = null
    element.scrollTop = Math.max(0, anchor.ratio * element.scrollHeight - anchor.y)
  }, [scale])

  const annotationsByPage = useMemo(() => {
    const map = new Map<number, ZoteroAnnotation[]>()
    for (const annotation of annotations) {
      if (annotation.attachmentKey !== source?.attachmentKey) continue
      const pageIndex = annotation.position?.pageIndex
      if (pageIndex === undefined) continue
      const list = map.get(pageIndex)
      if (list === undefined) map.set(pageIndex, [annotation])
      else list.push(annotation)
    }
    return map
  }, [annotations, source?.attachmentKey])

  function onScroll(): void {
    setSelection(null)
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      const element = scrollRef.current
      if (element === null) return
      const middle = element.scrollTop + element.clientHeight / 2
      let page = 1
      for (const child of element.querySelectorAll<HTMLElement>('[data-zp-page]')) {
        if (child.offsetTop <= middle) page = Number(child.dataset.zpPage ?? page)
        else break
      }
      setCurrentPage((previous) => (previous === page ? previous : page))
    })
  }

  function onMouseUp(): void {
    const selectionObject = window.getSelection()
    const root = rootRef.current
    if (
      selectionObject === null
      || selectionObject.isCollapsed
      || selectionObject.rangeCount === 0
      || root === null
    ) {
      setSelection(null)
      return
    }
    const text = selectionObject.toString().trim()
    const range = selectionObject.getRangeAt(0)
    const container = scrollRef.current
    if (text === '' || container === null || !container.contains(range.commonAncestorContainer)) {
      setSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    setSelection({
      text,
      x: rect.left - rootRect.left + rect.width / 2,
      y: rect.top - rootRect.top,
    })
  }

  function locate(annotationKey: string): boolean {
    const annotation = annotations.find((item) => item.key === annotationKey)
    const pageIndex = annotation?.position?.pageIndex
    const element = scrollRef.current
    if (annotation === undefined || pageIndex === undefined || element === null) return false
    const target = element.querySelector<HTMLElement>(`[data-zp-page="${pageIndex + 1}"]`)
    if (target === null) return false
    const targetRect = target.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    element.scrollTo({
      top: element.scrollTop + targetRect.top - box.top - element.clientHeight / 2 + targetRect.height / 2,
      behavior: 'smooth',
    })
    setFlashKey(annotationKey)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => {
      setFlashKey(null)
      flashTimerRef.current = null
    }, FLASH_MS)
    return true
  }

  function zoomIn(): void {
    const next = ZOOM_STEPS.find((step) => step > scale + 0.001) ?? MAX_SCALE
    applyZoom(next)
  }

  function zoomOut(): void {
    const next = [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001) ?? MIN_SCALE
    applyZoom(next)
  }

  useImperativeHandle(viewerRef, () => ({
    locate,
    currentPage: () => currentPageRef.current,
    zoomIn,
    zoomOut,
    setZoom: (percent: number) => applyZoom(percent / 100),
    fitToWidth: () => setFitWidth(true),
  }))

  useEffect(() => () => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
  }, [])

  useEffect(() => {
    if (card === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (cardRef.current?.contains(event.target as Node)) return
      setCard(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setCard(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [card])

  const estimateWidth = baseSize === null ? 0 : baseSize.width * scale
  const estimateHeight = baseSize === null ? 0 : baseSize.height * scale
  const rootWidth = rootRef.current?.clientWidth ?? 320
  const rootHeight = rootRef.current?.clientHeight ?? 400
  const cardLeft = card === null ? 0 : Math.max(8, Math.min(card.x, rootWidth - 268))
  const cardAbove = card !== null && card.y > rootHeight * 0.55

  return (
    <div ref={rootRef} style={rootStyle}>
      <style>{PDF_CSS}</style>
      <div
        ref={scrollRef}
        className="dsh-zotero-pdf-scroll"
        onScroll={onScroll}
        onMouseUp={onMouseUp}
      >
        {pageCount > 0 && (
          <div className="dsh-zotero-pdf-pages">
            {Array.from({ length: pageCount }, (_, index) => (
              <PdfPage
                key={index + 1}
                t={t}
                pdf={pdf as PDFDocumentProxy}
                pageNumber={index + 1}
                scale={scale}
                estimateWidth={estimateWidth}
                estimateHeight={estimateHeight}
                annotations={annotationsByPage.get(index) ?? []}
                flashKey={flashKey}
                onAnnotationClick={(annotation, clientX, clientY) => {
                  const rootRect = rootRef.current?.getBoundingClientRect()
                  if (rootRect === undefined) return
                  setCard({ annotation, x: clientX - rootRect.left, y: clientY - rootRect.top })
                }}
              />
            ))}
          </div>
        )}
      </div>

      {loading && (
        <div style={hintOverlayStyle}>
          <span>{t('viewer.loading')}</span>
        </div>
      )}

      {error !== null && (
        <div style={hintOverlayStyle}>
          <div style={{ maxWidth: 260, textAlign: 'center' }}>
            <p style={{ margin: '0 0 8px' }}>{tpl(t('viewer.failed'), { message: error })}</p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
              <button type="button" onClick={() => setRetry((value) => value + 1)} style={smallButtonStyle}>
                {t('action.retry')}
              </button>
              <button
                type="button"
                onClick={() => onOpenInZotero(1)}
                style={smallButtonStyle}
              >
                {t('viewer.openInZotero')}
              </button>
            </div>
          </div>
        </div>
      )}

      {selection !== null && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onInsertExcerpt(selection.text)
            window.getSelection()?.removeAllRanges()
            setSelection(null)
          }}
          style={{
            position: 'absolute',
            left: selection.x,
            top: selection.y,
            transform: 'translate(-50%, -130%)',
            padding: '3px 8px',
            fontSize: 12,
            borderRadius: 6,
            border: '1px solid rgba(127,127,127,0.35)',
            background: 'Canvas',
            color: 'CanvasText',
            cursor: 'pointer',
            zIndex: 8,
            whiteSpace: 'nowrap',
          }}
        >
          {t('action.insertExcerpt')}
        </button>
      )}

      {card !== null && (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={typeLabel(t, card.annotation.type)}
          style={{
            position: 'absolute',
            left: cardLeft,
            ...(cardAbove ? { bottom: rootHeight - card.y + 10 } : { top: card.y + 10 }),
            width: 260,
            maxHeight: '55%',
            overflow: 'auto',
            padding: '8px 10px',
            borderRadius: 8,
            background: 'Canvas',
            color: 'CanvasText',
            border: '1px solid rgba(127,127,127,0.32)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            zIndex: 9,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: annotationColor(card.annotation) }} />
            <span style={{ opacity: 0.7 }}>{typeLabel(t, card.annotation.type)}</span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setCard(null)} style={iconButtonStyle} aria-label={t('viewer.close')}>
              ×
            </button>
          </div>
          {card.annotation.text.trim() !== '' && (
            <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {card.annotation.text.trim()}
            </p>
          )}
          {hasComment(card.annotation.comment) && <CommentBody comment={card.annotation.comment} />}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => onInsertAnnotation(card.annotation)}
              style={smallButtonStyle}
            >
              {t('action.insertItemShort')}
            </button>
            <button
              type="button"
              onClick={() => onOpenInZotero((card.annotation.position?.pageIndex ?? 0) + 1)}
              style={smallButtonStyle}
            >
              {t('viewer.openInZoteroShort')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const rootStyle = {
  position: 'relative',
  height: '100%',
  minHeight: 0,
} as const

const hintOverlayStyle = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  fontSize: 12.5,
  background: 'rgba(127,127,127,0.08)',
  color: 'inherit',
  zIndex: 6,
  pointerEvents: 'none',
} as const

const smallButtonStyle = {
  height: 22,
  padding: '0 8px',
  fontSize: 11.5,
  lineHeight: 1.2,
  borderRadius: 5,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

const iconButtonStyle = {
  width: 20,
  height: 20,
  padding: 0,
  fontSize: 14,
  lineHeight: 1,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
} as const

const commentStyle = {
  marginTop: 4,
  paddingLeft: 8,
  borderLeft: '2px solid rgba(127,127,127,0.28)',
  opacity: 0.85,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
} as const
