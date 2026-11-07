/**
 * PDF 渲染器：连续滚动 + 懒渲染 + 文本层 + 标注叠加 + 缩放。
 *
 * 缩放有两种模式：`fitWidth`（默认，随容器宽度重算）与手动百分比。
 * 页面 wrapper 始终存在（按第一页尺寸占位），因此滚动条高度稳定。
 *
 * 可视区由滚动容器上的两个 IntersectionObserver 统一管理：
 * `RENDER_MARGIN` 内的页面才绘制，`RETAIN_MARGIN` 内保留已绘制的像素，
 * 上下回滚时不再重复渲染。
 *
 * 绘制结果先画进脱离文档的 canvas，完成后整块替换进页面，
 * 因此可见 canvas 的尺寸与内容总是一起更新——滚动时不会出现
 * 「canvas 已扩到新尺寸但还没画」的黑色空档。
 */

import {
  memo,
  useCallback,
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
} from 'pdfjs-dist'

import type { ZoteroAnnotation } from '../../zotero/types'
import { commentForEditor, hasComment, parseComment } from '../annotationComment'
import { annotationColor } from '../annotationRuns'
import { createAnnotations, patchAnnotation } from '../api'
import { tpl, type Translate } from '../locales'
import { showToast } from '../paneStore'
import { draftsFromSelection } from './annotationFactory'
import { AnnotationOverlay } from './AnnotationOverlay'
import { viewportBox } from './geometry'
import { PDF_ASSET_BASE, PDF_CSS } from './pdfjs'
import { enqueueRender, markScrollActivity, waitForScrollIdle } from './renderQueue'
import { SelectionBar, type MarkType } from './SelectionBar'
import type { DocumentRendererProps } from './types'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]
const GUTTER = 12
const FLASH_MS = 1600
/** 进入这个范围就开始绘制（提前约一屏，滚动到位时通常已画好）。 */
const RENDER_MARGIN = '100% 0px'
/** 离开这个范围才释放像素；上下各留约两屏，回滚不会重新渲染。 */
const RETAIN_MARGIN = '300% 0px'
/** 单页设备像素上限（与 PDF.js 官方阅读器同一量级），避免高倍缩放把 canvas 撑到数千万像素。 */
const MAX_CANVAS_PIXELS = 5_242_880

const EMPTY_PAGES: ReadonlySet<number> = new Set()
const EMPTY_ANNOTATIONS: ZoteroAnnotation[] = []
/** 卡片里能改评论的类型，与「标注」列表的编辑口径一致。 */
const COMMENTABLE_TYPES = new Set(['highlight', 'underline'])

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampScale(value: number): number {
  return Math.min(Math.max(value, MIN_SCALE), MAX_SCALE)
}

/** 渲染倍率：DPR 封顶 2，再按像素总量封顶。 */
function outputScale(viewport: PageViewport): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = Math.max(1, viewport.width * viewport.height)
  return Math.max(1, Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / pixels)))
}

type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>

/** 每帧最多交给文本层的文本项数量（单页文本项的处理成本不低，切小一点让帧留在预算内）。 */
const TEXT_CHUNK_ITEMS = 8

/**
 * 把整份文本切成小片、每帧喂一片。
 * TextLayer 对每个流片段是同步处理完的，一次灌整份会长时间占住主线程。
 */
function chunkedText(content: PdfTextContent): ReadableStream<PdfTextContent> {
  let index = 0
  let cancelled = false
  return new ReadableStream<PdfTextContent>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          if (cancelled) {
            resolve()
            return
          }
          if (index >= content.items.length) {
            controller.close()
            resolve()
            return
          }
          const items = content.items.slice(index, index + TEXT_CHUNK_ITEMS)
          index += items.length
          controller.enqueue({ ...content, items })
          resolve()
        })
      })
    },
    cancel() {
      cancelled = true
    },
  })
}

/** 基线差超过 0.6 个字高就算换了一行。 */
const SAME_LINE_TOLERANCE = 0.6
/** 向后寻找同一行相邻文本项的最大步数（文本项基本按行顺序发出）。 */
const NEIGHBOR_LOOKAHEAD = 8

interface TextEntry {
  div: HTMLElement
  x: number
  y: number
  width: number
  fontHeight: number
}

/**
 * 校正每个 span 的命中框（`--scale-x` 只缩放透明文字，不影响画面）。
 *
 * 两处误差都会让鼠标「点这个字却选中旁边那个」：
 * 一是 TextLayer 只对多字符项做横向缩放，单字符项沿用回退字体字宽；
 * 二是 PDF 里相邻文本项的包围盒本身就重叠约一个字宽，浏览器按几何距离
 * 解析选点，重叠区里落到哪个 span 全看遮挡顺序。
 *
 * 因此不按文本项自身宽度，而按「同一行下一个文本项的起点」收紧右边界，
 * 相邻 span 首尾相接，选区与点选就落在实际字形上。
 */
function fitSelectionBoxes(
  layer: TextLayer,
  content: PdfTextContent,
  viewport: PageViewport,
): void {
  const divs = layer.textDivs
  const entries: TextEntry[] = []
  let divIndex = 0
  for (const item of content.items) {
    // TextLayer 只为带文本字段的项创建 span，空串项也会占一个 div 但不入 DOM。
    if (!('str' in item)) continue
    const div = divs[divIndex]
    divIndex += 1
    if (div === undefined || item.str === '' || !div.isConnected) continue
    // 旋转文本的包围盒不是字宽，跳过。
    if (div.style.getPropertyValue('--rotate') !== '') continue
    entries.push({
      div,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
      fontHeight: Math.hypot(item.transform[2], item.transform[3]),
    })
  }

  const pending: Array<[HTMLElement, number]> = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    let width = entry.width
    const limit = Math.min(entries.length, index + NEIGHBOR_LOOKAHEAD)
    for (let next = index + 1; next < limit; next += 1) {
      const candidate = entries[next]
      if (Math.abs(candidate.y - entry.y) > entry.fontHeight * SAME_LINE_TOLERANCE) continue
      const gap = candidate.x - entry.x
      if (gap <= 0.5) continue
      width = Math.min(width, gap)
      break
    }
    if (!(width > 0)) continue
    const rect = entry.div.getBoundingClientRect()
    const target = width * viewport.scale
    if (rect.width <= 0 || Math.abs(rect.width - target) <= 0.5) continue
    const raw = Number.parseFloat(entry.div.style.getPropertyValue('--scale-x'))
    const current = Number.isFinite(raw) ? raw : 1
    pending.push([entry.div, current * (target / rect.width)])
  }
  for (const [div, scaleX] of pending) div.style.setProperty('--scale-x', String(scaleX))
}

/**
 * TextLayer 的换行 `<br>` 是绝对定位、没有偏移量的，实际会堆在页面左上角；
 * 跨行选中时会在页边画出一串竖直的小蓝条。换成离屏的换行 span：
 * 选区文本仍然带换行，但不会再画到页面上。
 */
function moveLineBreaksOffscreen(container: HTMLElement): void {
  for (const br of Array.from(container.querySelectorAll('br'))) {
    const holder = document.createElement('span')
    holder.className = 'dsh-zotero-pdf-eol'
    holder.textContent = '\n'
    br.replaceWith(holder)
  }
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
  /** 页面无障碍标签：外层算好，避免把可能不稳定的 `t` 传进 memo 组件。 */
  label: string
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  /** 是否在绘制范围内。 */
  active: boolean
  /** 是否保留已绘制的像素。 */
  retained: boolean
  estimateWidth: number
  estimateHeight: number
  annotations: ZoteroAnnotation[]
  flashKey: string | null
  onAnnotationClick(annotation: ZoteroAnnotation, clientX: number, clientY: number): void
  /** 渲染优先级（离当前阅读页越近越小），由外层按滚动位置实时计算。 */
  priorityOf(pageNumber: number): number
}

const PdfPage = memo(function PdfPage({
  label,
  pdf,
  pageNumber,
  scale,
  active,
  retained,
  estimateWidth,
  estimateHeight,
  annotations,
  flashKey,
  onAnnotationClick,
  priorityOf,
}: PageProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const textRef = useRef<HTMLDivElement | null>(null)
  /** 当前显示中的 canvas 及其绘制倍率；回滚到同倍率时跳过重复渲染。 */
  const paintedRef = useRef<{ canvas: HTMLCanvasElement; scale: number } | null>(null)
  const textScaleRef = useRef<number | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  /** 已上屏 canvas 的绘制倍率；文本层要等画布出来再渲染。 */
  const [paintedScale, setPaintedScale] = useState<number | null>(null)

  useEffect(() => {
    if (!(active || retained) || page !== null) return
    let disposed = false
    pdf.getPage(pageNumber)
      .then((proxy) => {
        if (!disposed) setPage(proxy)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [pdf, pageNumber, active, retained, page])

  // 画布：渲染到游离 canvas，完成后整块替换，可见 canvas 不会被「先清空后绘制」。
  // 全局串行排队，一帧里只有一个 pdf.js 绘制分片，滚动时不再被多页叠加抢帧。
  useEffect(() => {
    if (!active || page === null) return
    const host = hostRef.current
    if (host === null) return
    const painted = paintedRef.current
    if (painted !== null && painted.scale === scale && host.firstChild === painted.canvas) return

    let cancelled = false
    let task: ReturnType<PDFPageProxy['render']> | null = null

    const cancelQueued = enqueueRender({
      priority: () => priorityOf(pageNumber),
      start: async () => {
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const ratio = outputScale(viewport)
        const canvas = document.createElement('canvas')
        canvas.className = 'dsh-zotero-pdf-canvas'
        canvas.width = Math.max(1, Math.round(viewport.width * ratio))
        canvas.height = Math.max(1, Math.round(viewport.height * ratio))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        const renderTask = page.render({
          canvas,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        })
        task = renderTask
        try {
          await renderTask.promise
        } catch {
          return
        }
        if (cancelled) return
        host.replaceChildren(canvas)
        paintedRef.current = { canvas, scale }
        setPaintedScale(scale)
      },
    })

    return () => {
      cancelled = true
      cancelQueued()
      task?.cancel()
    }
  }, [active, page, scale, pageNumber, priorityOf])

  // 文本层：等画布上屏、且滚动停下后再渲染，避免和画布绘制分片抢帧。
  useEffect(() => {
    if (!active || page === null || paintedScale !== scale) return
    const container = textRef.current
    if (container === null) return
    if (textScaleRef.current === scale) return

    let cancelled = false
    let layer: TextLayer | null = null
    const viewport = page.getViewport({ scale })

    waitForScrollIdle()
      .then(() => {
        if (cancelled) return undefined
        return page.getTextContent()
      })
      .then((content) => {
        if (cancelled || content === undefined) return undefined
        container.textContent = ''
        const textLayer = new TextLayer({
          textContentSource: chunkedText(content),
          container,
          viewport,
        })
        layer = textLayer
        return textLayer.render().then(() => {
          if (cancelled) return
          fitSelectionBoxes(textLayer, content, viewport)
          moveLineBreaksOffscreen(container)
          textScaleRef.current = scale
        })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
      layer?.cancel()
    }
  }, [active, page, scale, paintedScale])

  // 只在离开保留范围时释放像素（此时页面早已滚出视口）。
  useEffect(() => {
    if (retained) return
    paintedRef.current = null
    textScaleRef.current = null
    hostRef.current?.replaceChildren()
    setPaintedScale(null)
    if (textRef.current !== null) textRef.current.textContent = ''
  }, [retained])

  const viewport = page === null ? null : page.getViewport({ scale })

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
      aria-label={label}
    >
      <div ref={hostRef} className="dsh-zotero-pdf-canvas-host" />
      <div ref={textRef} className="dsh-zotero-pdf-text" />
      {viewport !== null && (
        <AnnotationOverlay annotations={annotations} viewport={viewport} flashKey={flashKey} />
      )}
    </div>
  )
})

/** 观察页面 wrapper，把「进入范围」的页号集合交给回调。 */
function observePages(
  elements: readonly HTMLElement[],
  root: HTMLElement,
  rootMargin: string,
  onChange: (pages: ReadonlySet<number>) => void,
): IntersectionObserver {
  const current = new Set<number>()
  const observer = new IntersectionObserver(
    (entries) => {
      let changed = false
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.zpPage)
        if (!Number.isFinite(pageNumber)) continue
        if (entry.isIntersecting) {
          if (!current.has(pageNumber)) {
            current.add(pageNumber)
            changed = true
          }
        } else if (current.delete(pageNumber)) {
          changed = true
        }
      }
      if (changed) onChange(new Set(current))
    },
    { root, rootMargin },
  )
  for (const element of elements) observer.observe(element)
  return observer
}

export function PdfViewer(props: DocumentRendererProps): ReactElement {
  const {
    t,
    detail,
    source,
    annotations,
    viewerRef,
    onReady,
    onZoomChange,
    onPageChange,
    onInsertExcerpt,
    onInsertAnnotation,
    onOpenInZotero,
    onChanged,
  } = props

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<{ ratio: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  const selectionRef = useRef<{ text: string; x: number; y: number } | null>(null)
  /**
   * 上一次鼠标松开时的选区快照。
   *
   * 必须是 `cloneRange()`：浮条上的按钮一按，实时选区就可能被清掉，而位置、原文、
   * 排序键都要从这份 Range 里算。
   */
  const rangeRef = useRef<Range | null>(null)
  const [marking, setMarking] = useState(false)

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
  /**
   * 卡片只记 key 和屏幕位置，内容每次从 `annotations` 里现取。
   *
   * 存快照会有两个坏味道：写成功后 `onChanged` 重取的新版本号进不了卡片，下一次保存
   * 必撞 412；Zotero 那边改了评论，卡片还显示旧的。
   */
  const [card, setCard] = useState<{ key: string; x: number; y: number } | null>(null)
  /** 非 null 即评论编辑器打开着，值就是草稿。 */
  const [commentDraft, setCommentDraft] = useState<string | null>(null)
  const [commentNotice, setCommentNotice] = useState<string | null>(null)
  const [savingComment, setSavingComment] = useState(false)
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const [activePages, setActivePages] = useState<ReadonlySet<number>>(EMPTY_PAGES)
  const [retainedPages, setRetainedPages] = useState<ReadonlySet<number>>(EMPTY_PAGES)

  selectionRef.current = selection
  const currentPageRef = useRef(1)
  currentPageRef.current = currentPage

  /** 队列优先级：离当前页越近越先画；读 ref，避免滚动时重建回调打破子树 memo。 */
  const priorityOf = useCallback((pageNumber: number) => Math.abs(pageNumber - currentPageRef.current), [])

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
    setActivePages(EMPTY_PAGES)
    setRetainedPages(EMPTY_PAGES)

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

  // 页面 wrapper 提交后再挂观察器：两个观察器共用滚动容器，避免每页各养一个。
  useEffect(() => {
    const root = scrollRef.current
    if (root === null || pageCount === 0) return
    const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-zp-page]'))
    if (elements.length === 0) return
    const renderObserver = observePages(elements, root, RENDER_MARGIN, setActivePages)
    const retainObserver = observePages(elements, root, RETAIN_MARGIN, setRetainedPages)
    return () => {
      renderObserver.disconnect()
      retainObserver.disconnect()
    }
  }, [pageCount])

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

  /** 闪烁只影响目标页，避免每次高亮都让全部页面重渲染。 */
  const flashPage = useMemo(() => {
    if (flashKey === null) return -1
    const annotation = annotations.find((item) => item.key === flashKey)
    return annotation?.position?.pageIndex ?? -1
  }, [flashKey, annotations])

  const cardAnnotation = useMemo(
    () => (card === null ? null : annotations.find((item) => item.key === card.key) ?? null),
    [card, annotations],
  )

  const onAnnotationClick = useCallback(
    (annotation: ZoteroAnnotation, clientX: number, clientY: number): void => {
      const rootRect = rootRef.current?.getBoundingClientRect()
      if (rootRect === undefined) return
      setCard({ key: annotation.key, x: clientX - rootRect.left, y: clientY - rootRect.top })
    },
    [],
  )

  function onScroll(): void {
    markScrollActivity()
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      if (selectionRef.current !== null) {
        rangeRef.current = null
        setSelection(null)
      }
      const element = scrollRef.current
      if (element === null) return
      const pages = element.firstElementChild
      if (pages === null) return
      // 页高一致，按 offsetTop 二分定位；避免每帧遍历全部页面。
      const middle = element.scrollTop + element.clientHeight / 2
      let low = 0
      let high = pages.children.length - 1
      while (low <= high) {
        const index = (low + high) >> 1
        const child = pages.children[index] as HTMLElement | undefined
        if (child === undefined) break
        if (child.offsetTop <= middle) low = index + 1
        else high = index - 1
      }
      const page = Math.max(1, low)
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
      rangeRef.current = null
      setSelection(null)
      return
    }
    const text = selectionObject.toString().trim()
    const range = selectionObject.getRangeAt(0)
    const container = scrollRef.current
    if (text === '' || container === null || !container.contains(range.commonAncestorContainer)) {
      rangeRef.current = null
      setSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    rangeRef.current = range.cloneRange()
    setSelection({
      text,
      x: rect.left - rootRect.left + rect.width / 2,
      y: rect.top - rootRect.top,
    })
  }

  /**
   * 把当前选区写成一条（跨页则每页一条）标注。
   *
   * 成功只报一句然后交给 {@link onChanged} 整份重取：位置、排序、版本号都以库里那份
   * 为准，本地不拼。失败把原因摊出来 —— 未授权、未开写、类型不对都在 Host 挡成中文。
   */
  async function createMark(type: MarkType, color: string, comment: string): Promise<void> {
    const range = rangeRef.current
    const container = scrollRef.current
    if (range === null || pdf === null || source === null || container === null) {
      showToast(t('annotation.markUnavailable'))
      return
    }
    setMarking(true)
    try {
      const drafts = await draftsFromSelection({
        range,
        pdf,
        pagesRoot: container,
        scale,
        annotationType: type,
        annotationColor: color,
        annotationComment: comment,
      })
      if (drafts.length === 0) {
        showToast(t('annotation.markUnavailable'))
        return
      }
      await createAnnotations({ parentItem: source.attachmentKey, annotations: drafts })
      showToast(drafts.length === 1 ? t('annotation.created') : tpl(t('annotation.createdMany'), { count: drafts.length }))
      rangeRef.current = null
      window.getSelection()?.removeAllRanges()
      setSelection(null)
      onChanged()
    } catch (error) {
      showToast(tpl(t('annotation.writeFailed'), { message: errorText(error) }))
    } finally {
      setMarking(false)
    }
  }

  /**
   * 保存卡片里的评论。
   *
   * 存的是编辑器口径的原文，Host 那边只做换行归一和长度上限，`<b>` 之类按 Zotero
   * 自己的写法字面量入库。成功后交给 {@link onChanged}：新版本的评论由库里那份回填，
   * 卡片不在本地拼。
   */
  async function saveComment(annotation: ZoteroAnnotation, comment: string): Promise<void> {
    setSavingComment(true)
    setCommentNotice(null)
    try {
      await patchAnnotation({ key: annotation.key, version: annotation.version, patch: { comment } })
      showToast(t('annotation.saved'))
      setCommentDraft(null)
      onChanged()
    } catch (error) {
      setCommentNotice(tpl(t('annotation.writeFailed'), { message: errorText(error) }))
    } finally {
      setSavingComment(false)
    }
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

  /** 换一条标注（或关掉卡片）时，未提交的评论草稿不能跟着串到下一条上。 */
  useEffect(() => {
    setCommentDraft(null)
    setCommentNotice(null)
  }, [card?.key])

  const estimateWidth = baseSize === null ? 0 : baseSize.width * scale
  const estimateHeight = baseSize === null ? 0 : baseSize.height * scale
  const rootWidth = rootRef.current?.clientWidth ?? 320
  const rootHeight = rootRef.current?.clientHeight ?? 400
  const cardLeft = card === null ? 0 : Math.max(8, Math.min(card.x, rootWidth - 268))
  const cardAbove = card !== null && card.y > rootHeight * 0.55

  /**
   * 点色块弹出的卡片。
   *
   * 评论就地可改（Zotero 卡片也是这个位置），但只在「开了写 + PDF 就绪 + 高亮或划线」
   * 三者都成立时给入口；其余类型只读，避免把文本框、图片标注改成半残状态。
   */
  function annotationCard(shown: ZoteroAnnotation, cardY: number): ReactElement {
    const canEditComment = detail.writeEnabled && source !== null && !loading && COMMENTABLE_TYPES.has(shown.type)
    const originalComment = commentForEditor(shown.comment)
    return (
      <div
        ref={cardRef}
        role="dialog"
        aria-label={typeLabel(t, shown.type)}
        style={{
          position: 'absolute',
          left: cardLeft,
          ...(cardAbove ? { bottom: rootHeight - cardY + 10 } : { top: cardY + 10 }),
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
          <span style={{ width: 9, height: 9, borderRadius: 2, background: annotationColor(shown) }} />
          <span style={{ opacity: 0.7 }}>{typeLabel(t, shown.type)}</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => setCard(null)} style={iconButtonStyle} aria-label={t('viewer.close')}>
            ×
          </button>
        </div>
        {shown.text.trim() !== '' && (
          <p style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {shown.text.trim()}
          </p>
        )}
        {hasComment(shown.comment) && commentDraft === null && <CommentBody comment={shown.comment} />}
        {canEditComment && commentDraft === null && (
          <button
            type="button"
            onClick={() => {
              setCommentNotice(null)
              setCommentDraft(originalComment)
            }}
            style={cardLinkStyle}
          >
            {hasComment(shown.comment) ? t('annotation.editComment') : t('annotation.addComment')}
          </button>
        )}
        {canEditComment && commentDraft !== null && (
          <div style={{ marginTop: 6 }}>
            <textarea
              value={commentDraft}
              rows={3}
              disabled={savingComment}
              placeholder={t('annotation.commentPlaceholder')}
              aria-label={t('annotation.comment')}
              onChange={(event) => setCommentDraft(event.target.value)}
              style={cardTextareaStyle}
            />
            <div style={cardHintStyle}>{t('annotation.commentHint')}</div>
            {commentNotice !== null && (
              <div role="alert" style={cardNoticeStyle}>
                {commentNotice}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                disabled={savingComment || commentDraft === originalComment}
                onClick={() => void saveComment(shown, commentDraft)}
                style={smallButtonStyle}
              >
                {t('annotation.save')}
              </button>
              <button
                type="button"
                disabled={savingComment}
                onClick={() => {
                  setCommentDraft(null)
                  setCommentNotice(null)
                }}
                style={smallButtonStyle}
              >
                {t('annotation.closeEdit')}
              </button>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          <button
            type="button"
            onClick={() => onInsertAnnotation(shown)}
            style={smallButtonStyle}
          >
            {t('action.insertItemShort')}
          </button>
          <button
            type="button"
            onClick={() => onOpenInZotero((shown.position?.pageIndex ?? 0) + 1)}
            style={smallButtonStyle}
          >
            {t('viewer.openInZoteroShort')}
          </button>
        </div>
      </div>
    )
  }

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
                label={tpl(t('viewer.page'), { n: index + 1 })}
                pdf={pdf as PDFDocumentProxy}
                pageNumber={index + 1}
                scale={scale}
                active={activePages.has(index + 1)}
                retained={retainedPages.has(index + 1)}
                estimateWidth={estimateWidth}
                estimateHeight={estimateHeight}
                annotations={annotationsByPage.get(index) ?? EMPTY_ANNOTATIONS}
                flashKey={index === flashPage ? flashKey : null}
                onAnnotationClick={onAnnotationClick}
                priorityOf={priorityOf}
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
        <SelectionBar
          t={t}
          text={selection.text}
          x={selection.x}
          y={selection.y}
          onInsert={onInsertExcerpt}
          onDismiss={() => {
            rangeRef.current = null
            setSelection(null)
          }}
          annotate={
            detail.writeEnabled && source !== null && !loading
              ? { busy: marking, onCreate: (type, color, comment) => void createMark(type, color, comment) }
              : undefined
          }
        />
      )}

      {card !== null && cardAnnotation !== null && annotationCard(cardAnnotation, card.y)}
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

/** 「添加评论 / 改评论」入口：卡片里不想要一个抢眼的按钮，文字链就够。 */
const cardLinkStyle = {
  marginTop: 4,
  padding: 0,
  fontSize: 11.5,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.7,
  cursor: 'pointer',
  textAlign: 'left',
} as const

const cardTextareaStyle = {
  width: '100%',
  minHeight: 60,
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 12.5,
  lineHeight: 1.6,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'inherit',
  fontFamily: 'inherit',
  resize: 'vertical',
} as const

const cardHintStyle = {
  marginTop: 4,
  fontSize: 10.5,
  lineHeight: 1.5,
  opacity: 0.6,
} as const

const cardNoticeStyle = {
  marginTop: 6,
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.6,
  color: '#d29922',
  background: 'rgba(210,153,34,0.1)',
  overflowWrap: 'break-word',
} as const
