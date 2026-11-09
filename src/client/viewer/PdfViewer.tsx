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
 *
 * 滚动的帧预算优先给滚动本身：pdf.js 每个绘制分片最多占主线程 15ms，所以
 * 分片节奏由 `renderQueue.paceChunk` 接管（滚动中远处的页等停手、近处的页隔帧），
 * 文本层与选区框校正等停稳后才做，滚动期间文本层直接不上屏（字是透明的，撤掉
 * 不影响画面）；页码定位读缓存的页面 top 数组，不在滚动帧里读 `offsetTop`。
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
import { EDITABLE_TYPES } from '../annotationRuns'
import { createAnnotations, fetchAttachmentInfo } from '../api'
import { useDismiss } from '../dismiss'
import { SOFT_BUTTON_STYLE } from '../styles'
import { tpl, type Translate } from '../locales'
import { showToast } from '../paneStore'
import { AnnotationCard } from './AnnotationCard'
import { draftsFromSelection } from './annotationFactory'
import { AnnotationOverlay } from './AnnotationOverlay'
import { viewportBox } from './geometry'
import { PDF_ASSET_BASE, PDF_CSS } from './pdfjs'
import {
  enqueueRender,
  markScrollActivity,
  paceChunk,
  SCROLL_IDLE_MS,
  SCROLL_NEAR_PRIORITY,
  scrollIdleFor,
  waitForScrollIdle,
} from './renderQueue'
import { SelectionBar, type MarkType } from './SelectionBar'
import type { DocumentOutlineItem, DocumentRendererProps } from './types'
import { useReadPosition } from './useReadPosition'

const MIN_SCALE = 0.5
const MAX_SCALE = 3
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3]
const GUTTER = 12
const FLASH_MS = 1600
/** 停手这么久就把文本层放回屏幕（比绘制让路的判定短：字要尽早能选）。 */
const SCROLLING_FLAG_MS = 140
/** 进入这个范围就开始绘制（提前约一屏，滚动到位时通常已画好）。 */
const RENDER_MARGIN = '100% 0px'
/** 离开这个范围才释放像素；上下各留约两屏，回滚不会重新渲染。 */
const RETAIN_MARGIN = '300% 0px'
/** 单页设备像素上限（与 PDF.js 官方阅读器同一量级），避免高倍缩放把 canvas 撑到数千万像素。 */
const MAX_CANVAS_PIXELS = 5_242_880

const EMPTY_PAGES: ReadonlySet<number> = new Set()
const EMPTY_ANNOTATIONS: ZoteroAnnotation[] = []

/** 目录条目数与层级的硬上限：个别 PDF 的书签能上千条，面板画不完也没人看得完。 */
const OUTLINE_MAX_ITEMS = 800
const OUTLINE_MAX_DEPTH = 8

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * pdf.js 的「服务器返回 N」：形如
 * `Unexpected server response (404) while retrieving PDF "dsh-app://app/…".`
 */
const SERVER_RESPONSE = /Unexpected server response \((\d{3})\)/u

/**
 * 去掉 pdf.js 文案里的 URL。
 *
 * 那串 `dsh-app://app/dsh-zotero/api/file?key=…` 对用户没有任何用处，只会让
 * 提示看起来像内部报错；状态码留着，真正的原因由 {@link explainLoadFailure} 补。
 */
function tidyLoadError(message: string): string {
  return message.replace(/\s*while retrieving PDF\s*"[^"]*"\.?/u, '').trim()
}

/**
 * 把「服务器返回 404」翻译成人话。
 *
 * `/api/file` 成功时发的是二进制流，失败时 pdf.js 只拿得到状态码，于是界面上
 * 只剩一句看不懂的 404。这里补一次 `/api/attachment-info` 探测：
 * - 探测失败 → 那条错误消息就是真相（「附件文件不存在：/path」「没有权限读取」）；
 * - 探测成功 → 文件本身读得到，这次 404 是瞬时的（Zotero 重启、正在重建索引），
 *   提示重试比解释原因有用。
 *
 * 非 HTTP 类失败（加密、损坏、内存不足）一律返回 `null`，让原文案照原样显示。
 */
async function explainLoadFailure(
  error: unknown,
  key: string,
  t: Translate,
  signal?: AbortSignal,
): Promise<string | null> {
  const status = SERVER_RESPONSE.exec(errorText(error))?.[1]
  if (status === undefined || key === '') return null
  try {
    const info = await fetchAttachmentInfo(key, signal)
    // 415 之类由类型不支持引起：文件读得到也没用，别劝用户重试。
    if (!info.servable) return tpl(t('viewer.unsupported'), { type: info.contentType || info.filename })
    return tpl(t('viewer.serverResponse'), { status })
  } catch (probeError) {
    // 探测请求本身也可能失败（Host 没起来等），那就把它的原话带上。
    return tpl(t('viewer.attachmentUnavailable'), { message: tidyLoadError(errorText(probeError)) })
  }
}

/**
 * 一条书签的 `dest` → 1 基页码。
 *
 * `dest` 有两种形态：命名目标（字符串，要去 catalog 里查）或显式数组
 * `[页引用, 视图, ...]`。数组首元素通常是页对象的引用 `{num, gen}`，
 * 但有的生成器直接写 0 基页号，两种都收；外链书签（只有 `url`）返回 `null`。
 */
async function outlinePageOf(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  let resolved: unknown = dest
  if (typeof dest === 'string') {
    try {
      resolved = await pdf.getDestination(dest)
    } catch {
      return null
    }
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null
  const first: unknown = resolved[0]
  if (typeof first === 'number' && Number.isInteger(first)) return first + 1
  if (typeof first !== 'object' || first === null) return null
  try {
    return (await pdf.getPageIndex(first as { num: number; gen: number })) + 1
  } catch {
    return null
  }
}

/**
 * 把 PDF 的书签树拍平成带层级的列表。
 *
 * 解析失败按「没有目录」处理：目录是附加阅读入口，不能因为它把文档判成加载失败。
 * 返回数组而不是 `null` —— 「没有书签」是确定的结果，面板要显示的文案不一样。
 */
async function readOutline(pdf: PDFDocumentProxy): Promise<DocumentOutlineItem[]> {
  type Nodes = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>
  let tree: Nodes
  try {
    tree = await pdf.getOutline()
  } catch {
    return []
  }
  if (!Array.isArray(tree)) return []

  const out: DocumentOutlineItem[] = []
  const walk = async (nodes: Nodes, depth: number): Promise<void> => {
    for (const node of nodes) {
      if (out.length >= OUTLINE_MAX_ITEMS) return
      out.push({
        title: (node.title ?? '').trim() || '(无标题)',
        page: await outlinePageOf(pdf, node.dest),
        depth,
      })
      const children = node.items as Nodes | undefined
      if (depth + 1 < OUTLINE_MAX_DEPTH && Array.isArray(children) && children.length > 0) {
        await walk(children, depth + 1)
      }
    }
  }
  await walk(tree, 0)
  return out
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
 *
 * TextLayer 对每个流片段是同步处理完的，一次灌整份会长时间占住主线程。
 * 每片之前还要等滚动停稳：插 span 会带来样式重算与布局失效，这些都不该落在
 * 滚动的帧上（不滚动时 `waitForScrollIdle` 立即兑现，不影响正常速度）。
 */
function chunkedText(content: PdfTextContent): ReadableStream<PdfTextContent> {
  let index = 0
  let cancelled = false
  return new ReadableStream<PdfTextContent>({
    async pull(controller): Promise<void> {
      await waitForScrollIdle()
      if (cancelled) return
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })
      if (cancelled) return
      if (index >= content.items.length) {
        controller.close()
        return
      }
      const items = content.items.slice(index, index + TEXT_CHUNK_ITEMS)
      index += items.length
      controller.enqueue({ ...content, items })
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
      // 预渲染余量里的远处页不在滚动中开画：一片就要吃掉主线程 15ms，
      // 而那些帧正被滚动用着；滚完它往往也已经不在范围里了。
      ready: () => priorityOf(pageNumber) <= SCROLL_NEAR_PRIORITY || scrollIdleFor() >= SCROLL_IDLE_MS,
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
        // pdf.js 默认是「上一片画完，下一个 rAF 接着画」，也就是每帧都塞满 15ms。
        // 这里把续排的时机接管过来，滚动时让出帧（见 `paceChunk`）。
        renderTask.onContinue = (scheduleNext: () => void): void => {
          paceChunk(priorityOf(pageNumber), () => {
            if (!cancelled) scheduleNext()
          })
        }
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

    const build = async (): Promise<void> => {
      await waitForScrollIdle()
      if (cancelled) return
      const content = await page.getTextContent()
      if (cancelled) return
      container.textContent = ''
      const textLayer = new TextLayer({
        textContentSource: chunkedText(content),
        container,
        viewport,
      })
      layer = textLayer
      await textLayer.render()
      if (cancelled) return
      // 校正选区框要逐 span 量一次尺寸（一次强制布局），同样别落在滚动帧上。
      await waitForScrollIdle()
      if (cancelled) return
      fitSelectionBoxes(textLayer, content, viewport)
      moveLineBreaksOffscreen(container)
      textScaleRef.current = scale
    }
    void build().catch(() => undefined)

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
    onOutlineChange,
  } = props

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<{ ratio: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  /** 「正在滚动」标记的定时器：停手一会儿后把文本层放回屏幕上。 */
  const scrollingTimerRef = useRef<number | null>(null)
  /** 页面 top 缓存（页码定位用），见 `pageAt`。 */
  const topsRef = useRef<number[] | null>(null)
  /** 滚动容器可视高度（只随尺寸变，不随滚动变），免得每帧读一次 `clientHeight`。 */
  const viewportHeightRef = useRef(0)
  const selectionRef = useRef<{ text: string; x: number; y: number } | null>(null)
  /**
   * 上一次鼠标松开时的选区快照。
   *
   * 必须是 `cloneRange()`：浮条上的按钮一按，实时选区就可能被清掉，而位置、原文、
   * 排序键都要从这份 Range 里算。
   */
  const rangeRef = useRef<Range | null>(null)
  const [marking, setMarking] = useState(false)

  /**
   * 目录回调走 ref：加载 effect 只该随 url / 重试重跑，不该因为父级重渲染换了
   * 回调身份就重新解析一遍书签（每次解析都要等一个 `getOutline`）。
   */
  const outlineRef = useRef(onOutlineChange)
  outlineRef.current = onOutlineChange

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
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  const [activePages, setActivePages] = useState<ReadonlySet<number>>(EMPTY_PAGES)
  const [retainedPages, setRetainedPages] = useState<ReadonlySet<number>>(EMPTY_PAGES)

  selectionRef.current = selection
  const currentPageRef = useRef(1)
  currentPageRef.current = currentPage

  /** 队列优先级：离当前页越近越先画；读 ref，避免滚动时重建回调打破子树 memo。 */
  const priorityOf = useCallback((pageNumber: number) => Math.abs(pageNumber - currentPageRef.current), [])

  const url = source?.url ?? ''

  const { resumePage, notePage } = useReadPosition(source?.attachmentKey ?? null)
  /** 已经为哪个 url 做过续读跳转（同一个 url 只跳一次，避免和用户滚动打架）。 */
  const resumedUrlRef = useRef('')
  /** 用户是否真的滚动过：没滚动就不写进度，免得「打开又关掉」盖掉 Zotero 的位置。 */
  const scrolledRef = useRef(false)

  useEffect(() => {
    if (url === '') {
      setPdf(null)
      setLoading(false)
      setError(null)
      return
    }
    let disposed = false
    // 失败解释只认这一条 url 对应的附件（effect 创建时的闭包值，与 url 同源）。
    const key = source?.attachmentKey ?? ''
    /** 换文档/卸载时把探测请求一起取消，别让它在后台白跑。 */
    const probe = new AbortController()
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
        // 书签单独解析、不 await：目录晚一两帧没有关系，别拖住首屏。
        void readOutline(proxy).then((items) => {
          if (!disposed) outlineRef.current?.(items)
        })
      })
      .catch((loadError: unknown) => {
        if (disposed) return
        // 先上 pdf.js 原文（带状态码），再去问一次真正的原因；探测慢一点也不碍事，
        // 有「重试 / 在 Zotero 中打开」两个按钮兜着。
        setError(tpl(t('viewer.failed'), { message: tidyLoadError(errorText(loadError)) }))
        setLoading(false)
        // 明确报「没有目录」：不然面板会永远停在「正在读取目录…」。
        outlineRef.current?.([])
        // 只读这一条 url 对应的附件；effect 的依赖里不放 `t` / `source`，
        // 否则切语言或每次渲染新建的 source 对象都会把 PDF 重新加载一遍。
        void explainLoadFailure(loadError, key, t, probe.signal).then((reason) => {
          if (!disposed && reason !== null) setError(reason)
        })
      })

    return () => {
      disposed = true
      probe.abort()
      void task.destroy()
    }
  }, [url, retry, onReady])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect === undefined) return
      if (rect.width > 0) setContainerWidth(rect.width)
      viewportHeightRef.current = rect.height
    })
    observer.observe(element)
    setContainerWidth(element.clientWidth)
    viewportHeightRef.current = element.clientHeight
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

  /**
   * 页码 top 缓存：页面总高变了（尺度、页数、个别页与估算尺寸不同）就作废。
   *
   * 观察的是页面容器的总高，一次改动只回调一次，比每页各挂一个观察器便宜。
   */
  useEffect(() => {
    const pages = scrollRef.current?.firstElementChild
    if (pages === null || pages === undefined) return
    topsRef.current = null
    const observer = new ResizeObserver(() => {
      topsRef.current = null
    })
    observer.observe(pages)
    return () => observer.disconnect()
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

  /**
   * 续读：PDF 就绪后滚到上次那页。
   *
   * 页面 wrapper 先按估算尺寸占位，`offsetTop` 一提交就能算，所以不必等 canvas
   * 画完；用 rAF 轮询等占位出现（最多约两秒），超时就算了 —— 定位失败比卡在
   * 空白页好。
   */
  useEffect(() => {
    if (url === '' || pageCount === 0 || resumePage === null) return
    if (resumedUrlRef.current === url) return
    const target = resumePage + 1
    if (target < 1 || target > pageCount) {
      resumedUrlRef.current = url
      return
    }
    let frames = 0
    let cancelled = false
    const apply = (): void => {
      if (cancelled) return
      if (!scrollToPage(target)) {
        if (frames++ < 120) window.requestAnimationFrame(apply)
        return
      }
      resumedUrlRef.current = url
      if (target > 1) showToast(tpl(t('viewer.resumed'), { n: target }))
    }
    window.requestAnimationFrame(apply)
    return () => {
      cancelled = true
    }
  }, [url, pageCount, resumePage, t])

  /** 翻页就记。防抖与去重都在 hook 里，这里只喂当前页。 */
  useEffect(() => {
    if (!scrolledRef.current || pageCount === 0) return
    notePage(currentPage)
  }, [currentPage, pageCount, notePage])

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

  /**
   * 视口中线落在第几页（1 基）。
   *
   * 页面 top 缓存成数组，滚动帧里只做二分。不读 `offsetTop`：一旦有 DOM 改动
   * （画布、文本层刚插进来）读它就会强制整棵树同步布局，正好压在滚动帧上。
   */
  const pageAt = useCallback((element: HTMLDivElement): number => {
    const pages = element.firstElementChild
    if (pages === null) return 1
    const count = pages.children.length
    let tops = topsRef.current
    if (tops === null || tops.length !== count) {
      const next = new Array<number>(count)
      for (let index = 0; index < count; index += 1) {
        next[index] = (pages.children[index] as HTMLElement).offsetTop
      }
      tops = next
      topsRef.current = next
    }
    const middle = element.scrollTop + viewportHeightRef.current / 2
    let low = 0
    let high = count - 1
    while (low <= high) {
      const index = (low + high) >> 1
      if ((tops[index] ?? 0) <= middle) low = index + 1
      else high = index - 1
    }
    return Math.max(1, low)
  }, [])

  /**
   * 滚动监听：更新页码，并给容器打上「正在滚动」标记。
   *
   * 用原生 passive 监听而不是 React 合成事件：触控板/滚轮一秒能来上百条事件，
   * 合成事件每条都要过一遍 React 的派发与批量更新流程。
   * 标记走 `data-` 属性而不是 state —— 每个滚动动作都要改，不该引起重渲染；
   * CSS 据此在滚动期间把文本层撤下（见 `PDF_CSS`）。
   */
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    /**
     * 鼠标按住时不撤文本层：拖选到边缘会触发自动滚动，而 `visibility: hidden`
     * 的元素不参与命中测试，撤掉会让原生选区当场失去落点。
     */
    let pointerHeld = false
    const press = (): void => {
      pointerHeld = true
      // 一按下就把文本层放回来：接下来多半是划选，晚 140ms 会让这一次划选落空。
      if (scrollingTimerRef.current !== null) {
        window.clearTimeout(scrollingTimerRef.current)
        scrollingTimerRef.current = null
      }
      delete element.dataset.zpScrolling
    }
    const release = (): void => {
      pointerHeld = false
    }
    const onScroll = (): void => {
      scrolledRef.current = true
      markScrollActivity()
      if (!pointerHeld) {
        if (element.dataset.zpScrolling !== '1') element.dataset.zpScrolling = '1'
        if (scrollingTimerRef.current !== null) window.clearTimeout(scrollingTimerRef.current)
        scrollingTimerRef.current = window.setTimeout(() => {
          scrollingTimerRef.current = null
          delete element.dataset.zpScrolling
        }, SCROLLING_FLAG_MS)
      }
      if (rafRef.current !== null) return
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null
        if (selectionRef.current !== null) {
          rangeRef.current = null
          setSelection(null)
        }
        const page = pageAt(element)
        setCurrentPage((previous) => (previous === page ? previous : page))
      })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      if (scrollingTimerRef.current !== null) {
        window.clearTimeout(scrollingTimerRef.current)
        scrollingTimerRef.current = null
      }
    }
  }, [pageAt])

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

  /**
   * 把某一页（1 基）滚到视口顶部。
   *
   * 页面占位还没提交（`data-zp-page` 不在）时返回 false，调用方据此重试 —— 续读与
   * 页码跳转都要等这一步。
   */
  function scrollToPage(page: number): boolean {
    const element = scrollRef.current
    const target = element?.firstElementChild?.children[page - 1] as HTMLElement | undefined
    if (element === null || target === undefined) return false
    element.scrollTop = target.offsetTop
    setCurrentPage(page)
    markScrollActivity()
    return true
  }

  function goToPage(page: number): void {
    if (page < 1 || page > pageCount) return
    scrollToPage(page)
  }

  useImperativeHandle(viewerRef, () => ({
    locate,
    currentPage: () => currentPageRef.current,
    goToPage,
    zoomIn,
    zoomOut,
    setZoom: (percent: number) => applyZoom(percent / 100),
    fitToWidth: () => setFitWidth(true),
  }))

  useEffect(() => () => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
  }, [])

  // 卡片开着时点别处 / 按 Esc 就收起，与快照渲染器共用同一套（见 `dismiss.ts`）。
  useDismiss(card !== null, cardRef, () => setCard(null))

  const estimateWidth = baseSize === null ? 0 : baseSize.width * scale
  const estimateHeight = baseSize === null ? 0 : baseSize.height * scale
  const rootWidth = rootRef.current?.clientWidth ?? 320
  const rootHeight = rootRef.current?.clientHeight ?? 400
  const cardLeft = card === null ? 0 : Math.max(8, Math.min(card.x, rootWidth - 268))
  const cardAbove = card !== null && card.y > rootHeight * 0.55

  /**
   * 卡片摆在点中的位置上方或下方。
   *
   * 内容是共用组件 {@link AnnotationCard}：里面只做换色 / 改评论 / 换类型 / 删除，
   * 版本号与最终结果一律由 `onChanged` 重取后回填。这些入口只在「开了写 + PDF 就绪 +
   * 高亮或划线」三者都成立时出现，其余类型只读。
   */
  function annotationCard(shown: ZoteroAnnotation, cardY: number): ReactElement {
    return (
      <AnnotationCard
        t={t}
        annotation={shown}
        cardRef={cardRef}
        style={cardAbove ? { left: cardLeft, bottom: rootHeight - cardY + 10 } : { left: cardLeft, top: cardY + 10 }}
        canEdit={detail.writeEnabled && source !== null && !loading && EDITABLE_TYPES.has(shown.type)}
        onClose={() => setCard(null)}
        onInsert={onInsertAnnotation}
        onOpenInZotero={() => onOpenInZotero((shown.position?.pageIndex ?? 0) + 1)}
        onChanged={onChanged}
      />
    )
  }

  return (
    <div ref={rootRef} style={rootStyle}>
      <style>{PDF_CSS}</style>
      <div
        ref={scrollRef}
        className="dsh-zotero-pdf-scroll"
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
            <p style={{ margin: '0 0 8px' }}>{error}</p>
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
  ...SOFT_BUTTON_STYLE,
  height: 22,
  padding: '0 8px',
  fontSize: 11.5,
  lineHeight: 1.2,
  borderRadius: 5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const
