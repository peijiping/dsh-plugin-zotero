/**
 * PDF 渲染器：基于 pdf.js 官方 Viewer（`web/pdf_viewer`）的连续滚动阅读视图。
 *
 * 页面绘制、页面缓存、预渲染、文本层、缩放与页面定位都交给 `PDFViewer`：
 * - canvas 使用 `width/height:100%`，缩放时旧画面先被 CSS 拉伸，再异步重绘；
 * - 文本层属于页面渲染的一部分，滚动/缩放期间不会被撤下；
 * - 高倍缩放由 `PDFPageDetailView` 只重绘可见区域，避免整页 canvas 失控；
 * - 页面缓存与渲染优先级由 `PDFRenderingQueue` 管理。
 *
 * 本组件只保留阅读器外壳与 Zotero 特有能力：加载/错误提示、目录联动、续读、
 * 划词、标注叠加层、标注卡片、翻译与截图。标注层挂到 `.pdfViewer` 上，
 * 按页面 DOM 的实时几何定位，所以缩放时与页面同步移动。
 */

import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'

import { getDocument, type PDFDocumentProxy, type PageViewport } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'

import type { ApiFix, ZoteroAnnotation } from '../../zotero/types'
import { EDITABLE_TYPES } from '../annotationRuns'
import { ApiFailure, createAnnotations, fetchAttachmentInfo, openSystemSettings } from '../api'
import { useDismiss } from '../dismiss'
import { SOFT_BUTTON_STYLE } from '../styles'
import { tpl, type Translate } from '../locales'
import { showToast } from '../paneStore'
import { AnnotationCard, ANNOTATION_CARD_OUTER_WIDTH } from './AnnotationCard'
import { draftsFromSelection } from './annotationFactory'
import { AnnotationOverlay } from './AnnotationOverlay'
import { viewportBox } from './geometry'
import { OpenInZoteroIcon } from './OpenInZoteroIcon'
import { pageActiveIndex } from './outline'
import { readPdfOutline } from './pdfOutline'
import { PDF_ASSET_BASE, PDF_CSS } from './pdfjs'
import type { EvidenceLocation, EvidenceTarget } from '../evidence'
import { offsetsWithin, revealOffsets, revealQuote } from './evidenceSelection'
import { SelectionBar, type MarkType } from './SelectionBar'
import { TranslationCard } from './TranslationCard'
import { useTranslation } from './useTranslation'
import type { DocumentOutlineItem, DocumentRendererProps } from './types'
import { useReadPosition } from './useReadPosition'

const MIN_ZOOM = 50
const MAX_ZOOM = 300
const ZOOM_STEPS = [50, 67, 80, 100, 125, 150, 200, 300]
const FLASH_MS = 1600
/** pdf.js 的定位选择器；页码存在 `data-page-number`（1 基）。 */
const PAGE_SELECTOR = '.page[data-page-number]'
const EMPTY_ANNOTATIONS: ZoteroAnnotation[] = []

/**
 * `pdf_viewer.css` 正文只取一次（同一个 Promise 供 StrictMode 双挂载复用）。
 * 失败返回空串：阅读器仍能用 `PDF_CSS` 里的页面骨架显示，只是文本层样式不全。
 */
let viewerCssPromise: Promise<string> | null = null

function loadViewerCss(): Promise<string> {
  viewerCssPromise ??= fetch(`${PDF_ASSET_BASE}pdf_viewer.css`)
    .then((response) => (response.ok ? response.text() : ''))
    .catch(() => '')
  return viewerCssPromise
}

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
 * 一次加载失败的展示内容。
 *
 * `fix` 有值时表示「这个错误可以一键去修」——比如 macOS 的目录授权，
 * 界面上会在「重试 / 在 Zotero 中打开」旁边多出一个跳转按钮。
 */
interface LoadError {
  text: string
  fix?: ApiFix
}

/**
 * 把「服务器返回 404」翻译成人话。
 *
 * `/api/file` 成功时发的是二进制流，失败时 pdf.js 只拿得到状态码，于是界面上
 * 只剩一句看不懂的 404。这里补一次 `/api/attachment-info` 探测：
 * - 探测失败 → 那条错误消息就是真相（「附件文件不存在：/path」「没有权限读取」），
 *   能一键修的错误还会带上 `fix`；
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
): Promise<LoadError | null> {
  const status = SERVER_RESPONSE.exec(errorText(error))?.[1]
  if (status === undefined || key === '') return null
  try {
    const info = await fetchAttachmentInfo(key, signal)
    // 415 之类由类型不支持引起：文件读得到也没用，别劝用户重试。
    if (!info.servable) {
      return { text: tpl(t('viewer.unsupported'), { type: info.contentType || info.filename }) }
    }
    return { text: tpl(t('viewer.serverResponse'), { status }) }
  } catch (probeError) {
    // 探测请求本身也可能失败（Host 没起来等），那就把它的原话带上。
    const fix = probeError instanceof ApiFailure ? probeError.fix : undefined
    return {
      text: tpl(t('viewer.attachmentUnavailable'), { message: tidyLoadError(errorText(probeError)) }),
      ...(fix === undefined ? {} : { fix }),
    }
  }
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

/**
 * 缩放锚点：屏幕上 (x, y) 这一点落在第 `page` 页的 (fx, fy) 处。
 *
 * fx / fy 是相对页左上角的比例，允许落在 0..1 之外（点在页外灰边时）；
 * 倍率改完后用同一页的新尺寸把它还原到 (x, y)，就是「按中心缩放」。
 */
interface ZoomAnchor {
  page: number
  fx: number
  fy: number
  x: number
  y: number
}

interface PageGeometry {
  pageNumber: number
  left: number
  top: number
  width: number
  height: number
  viewport: PageViewport
}

/**
 * 标注层：pdf.js 自带 `.page` DOM，每页的 canvas / 文本层由它维护。
 * 这里按页面当前的 `offset*` 与 `viewport` 给有标注的页叠一层绝对定位的 React 层，
 * 缩放或重绘后由外层触发重渲染，位置始终跟着页面走。
 */
function AnnotationLayer({
  viewer,
  annotationsByPage,
  flashKey,
}: {
  viewer: PDFViewer
  annotationsByPage: ReadonlyMap<number, ZoteroAnnotation[]>
  flashKey: string | null
}): ReactElement {
  const pages: PageGeometry[] = []
  for (const pageIndex of annotationsByPage.keys()) {
    const pageView = viewer.getPageView(pageIndex)
    const element = pageView?.div as HTMLElement | undefined
    if (pageView === undefined || element === undefined) continue
    pages.push({
      pageNumber: pageIndex + 1,
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
      viewport: pageView.viewport,
    })
  }

  return (
    <>
      {pages.map((page) => (
        <div
          key={page.pageNumber}
          className="dsh-zotero-pdf-ann-page"
          style={{ left: page.left, top: page.top, width: page.width, height: page.height }}
        >
          <AnnotationOverlay
            annotations={annotationsByPage.get(page.pageNumber - 1) ?? EMPTY_ANNOTATIONS}
            viewport={page.viewport}
            flashKey={flashKey}
          />
        </div>
      ))}
    </>
  )
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
    onInsertTranslation,
    onInsertAnnotation,
    onOpenInZotero,
    onChanged,
    onOutlineChange,
    onOutlineActiveChange,
  } = props

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  /** pdf.js Viewer 实例；`element` 是它自己管理的 `.pdfViewer` 容器。 */
  const [viewerApi, setViewerApi] = useState<{ viewer: PDFViewer; element: HTMLDivElement } | null>(null)
  const viewerApiRef = useRef<typeof viewerApi>(null)
  viewerApiRef.current = viewerApi
  /** 页面 DOM 与尺寸已就绪（可以跳页、续读、挂标注层）。 */
  const [pagesReady, setPagesReady] = useState(false)
  /** 所有页都拿到了自己的真实尺寸（`pagesloaded`）；跳页在它之后才准。 */
  const [pagesSized, setPagesSized] = useState(false)
  /** 仅用于缩放/重绘后触发标注层按新几何重渲染。 */
  const [, setGeometryTick] = useState(0)
  /** 每次缩放前记下的锚点，在新布局里消费一次。 */
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null)
  const restoreRafRef = useRef<number | null>(null)
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
  /** 划词翻译浮层：选区变了就重开，正文滚动不影响它（相对 root 定位）。 */
  const translation = useTranslation(t)
  const translationLocation = useRef<EvidenceLocation>()
  const positionedEvidence = useRef<EvidenceTarget>()

  /**
   * 目录回调走 ref：加载 effect 只该随 url / 重试重跑，不该因为父级重渲染换了
   * 回调身份就重新解析一遍书签（每次解析都要等一个 `getOutline`）。
   */
  const outlineRef = useRef(onOutlineChange)
  outlineRef.current = onOutlineChange
  /**
   * 目录反向跟随：当前页 → 目录下标。
   *
   * 书签只带页码，所以「读到哪一节」是按页推的（见 `pageActiveIndex`）。这里同时
   * 记着**上一次报出去的下标**，同页有多条书签时用它把结论钉住，免得点了 `1.1`
   * 却被改判成同页的 `1.2`。
   */
  const outlineActiveRef = useRef(onOutlineActiveChange)
  outlineActiveRef.current = onOutlineActiveChange
  const outlineItemsRef = useRef<DocumentOutlineItem[]>([])
  const activeIndexRef = useRef<number | null>(null)

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LoadError | null>(null)
  const [retry, setRetry] = useState(0)
  const [pageCount, setPageCount] = useState(0)
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

  selectionRef.current = selection
  const currentPageRef = useRef(1)
  currentPageRef.current = currentPage
  /** 缩放事件的回调走 ref，避免因回调身份变化重建整个 Viewer。 */
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange

  const url = source?.url ?? ''

  const { resumePage, notePage } = useReadPosition(source?.attachmentKey ?? null)
  /** 已经为哪个 url 做过续读跳转（同一个 url 只跳一次，避免和用户滚动打架）。 */
  const resumedUrlRef = useRef('')
  /** 用户是否真的滚动过：没滚动就不写进度，免得「打开又关掉」盖掉 Zotero 的位置。 */
  const scrolledRef = useRef(false)

  /**
   * 按当前页重算目录高亮。
   *
   * 只在结论变化时上报：滚动一秒几十次 `currentPage` 更新，直接透传会让父级
   * （以及整块正文）跟着逐帧重渲染。书签还没解析出来时 `outlineItemsRef` 是空数组，
   * 结论 `null`，面板不高亮任何一条。
   */
  const reportOutlineActive = useCallback((page: number): void => {
    const next = pageActiveIndex(outlineItemsRef.current, page, activeIndexRef.current)
    if (next === activeIndexRef.current) return
    activeIndexRef.current = next
    outlineActiveRef.current?.(next)
  }, [])

  useEffect(() => {
    reportOutlineActive(currentPage)
  }, [currentPage, reportOutlineActive])

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
    setCurrentPage(1)
    setPagesReady(false)
    setPagesSized(false)
    // 换文档：旧的目录与高亮一起清掉，别让上一份书签的结论留在面板上。
    outlineItemsRef.current = []
    if (activeIndexRef.current !== null) {
      activeIndexRef.current = null
      outlineActiveRef.current?.(null)
    }

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
        setPdf(proxy)
        setPageCount(proxy.numPages)
        setLoading(false)
        onReady()
        // 书签单独解析、不 await：目录晚一两帧没有关系，别拖住首屏。
        void readPdfOutline(proxy).then((items) => {
          if (disposed) return
          outlineItemsRef.current = items
          outlineRef.current?.(items)
          // 目录可能比首屏晚到：到了就按当前页补一次高亮。
          reportOutlineActive(currentPageRef.current)
        })
      })
      .catch((loadError: unknown) => {
        if (disposed) return
        // 先上 pdf.js 原文（带状态码），再去问一次真正的原因；探测慢一点也不碍事，
        // 有「重试 / 在 Zotero 中打开」两个按钮兜着。
        setError({ text: tpl(t('viewer.failed'), { message: tidyLoadError(errorText(loadError)) }) })
        setLoading(false)
        // 明确报「没有目录」：不然面板会永远停在「正在读取目录…」。
        outlineItemsRef.current = []
        outlineRef.current?.([])
        reportOutlineActive(1)
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
  }, [url, retry, onReady, reportOutlineActive])

  /**
   * pdf_viewer.css 的正文只取一次。
   *
   * 它是一整套通用类名（`.dialog` / `.page` / `.textLayer` …），直接 `<link>` 进文档会
   * 改到 DSH 自己的界面，所以包进 `@scope (.dsh-zotero-pdf-scroll)` 再注入。
   * 作用域只限定匹配范围，不改选择器，pdf.js 后续升级样式也能照用。
   */
  const [viewerCssReady, setViewerCssReady] = useState(false)
  useEffect(() => {
    let disposed = false
    const done = (): void => {
      if (!disposed) setViewerCssReady(true)
    }
    void loadViewerCss().then((css) => {
      if (!disposed && css !== '' && document.querySelector('style[data-dsh-zotero-pdf-viewer]') === null) {
        const style = document.createElement('style')
        style.dataset.dshZoteroPdfViewer = 'true'
        style.textContent = `@scope (.dsh-zotero-pdf-scroll) {\n${css}\n}`
        document.head.appendChild(style)
      }
      done()
    })
    return () => {
      disposed = true
    }
  }, [])

  /**
   * 创建 pdf.js Viewer。
   *
   * 页面 DOM、渲染队列、文本层、缩放与页面定位全部由 `PDFViewer` 维护；
   * 这里只把事件桥接回 React 状态，并在销毁时清干净（StrictMode 双挂载也安全）。
   */
  useEffect(() => {
    const container = scrollRef.current
    if (container === null || pdf === null || !viewerCssReady) return

    container.replaceChildren()
    const element = document.createElement('div')
    element.className = 'pdfViewer'
    container.appendChild(element)

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    /**
     * `abortSignal` 会让 pdf.js 自己解绑容器上的 scroll / resize 监听与渲染任务；
     * 它运行期支持，但类型声明里还没导出，所以先组成对象再传入（避免多余属性检查）。
     */
    const abort = new AbortController()
    const viewerOptions = {
      container,
      viewer: element,
      eventBus,
      linkService,
      textLayerMode: 1,
      annotationMode: 1,
      imageResourcesPath: `${PDF_ASSET_BASE}images/`,
      abortSignal: abort.signal,
    }
    const viewer = new PDFViewer(viewerOptions)
    linkService.setDocument(pdf, null)
    linkService.setViewer(viewer)

    let disposed = false
    let raf: number | null = null

    const bumpGeometry = (): void => {
      if (disposed || raf !== null) return
      raf = window.requestAnimationFrame(() => {
        raf = null
        if (!disposed) setGeometryTick((value) => value + 1)
      })
    }

    const reportZoom = (): void => {
      onZoomChangeRef.current({
        percent: Math.round(viewer.currentScale * 100),
        fitWidth: viewer.currentScaleValue === 'page-width',
      })
    }

    const applyPageLabels = (): void => {
      void pdf.getPageLabels().then((labels) => {
        if (disposed || labels === null) return
        labels.forEach((label, index) => {
          const page = element.querySelector<HTMLElement>(`.page[data-page-number="${index + 1}"]`)
          if (page !== null) page.dataset.zpPageLabel = label
        })
      }).catch(() => undefined)
    }

    eventBus.on('pagesinit', () => {
      viewer.currentScaleValue = 'page-width'
      setPagesReady(true)
      reportZoom()
      bumpGeometry()
      applyPageLabels()
    }, { signal: abort.signal })
    eventBus.on('pagesloaded', () => {
      setPagesSized(true)
      bumpGeometry()
    }, { signal: abort.signal })
    eventBus.on('pagechanging', (event: { pageNumber: number }) => {
      setCurrentPage(event.pageNumber)
    }, { signal: abort.signal })
    eventBus.on('scalechanging', () => {
      reportZoom()
      bumpGeometry()
    }, { signal: abort.signal })
    eventBus.on('pagerendered', () => {
      bumpGeometry()
    }, { signal: abort.signal })
    eventBus.on('textlayerrendered', (event: { pageNumber: number }) => {
      const pageView = viewer.getPageView(event.pageNumber - 1)
      const layer = pageView?.textLayer?.div as HTMLElement | undefined
      if (layer !== undefined) moveLineBreaksOffscreen(layer)
    }, { signal: abort.signal })

    viewer.setDocument(pdf)
    setViewerApi({ viewer, element })

    return () => {
      disposed = true
      abort.abort()
      if (raf !== null) window.cancelAnimationFrame(raf)
      viewer.cleanup()
      element.remove()
      setViewerApi(null)
      setPagesReady(false)
      setPagesSized(false)
    }
  }, [pdf, viewerCssReady])

  useEffect(() => {
    onPageChange(currentPage, pageCount)
  }, [currentPage, pageCount, onPageChange])

  /**
   * 续读：PDF 就绪后滚到上次那页。
   *
   * pdf.js 在 `pagesinit` 后异步把每页的真实尺寸写进页面 DOM；等 `pagesloaded`
   * 再跳，目标页的 `offsetTop` 才是准的。仍保留 rAF 轮询兜底（最多约两秒），
   * 超时就算了 —— 定位失败比卡在空白页好。
   */
  useEffect(() => {
    if (url === '' || pageCount === 0 || resumePage === null || !pagesReady || !pagesSized) return
    if (resumedUrlRef.current === url) return
    const target = resumePage + 1
    if (target < 1 || target > pageCount) {
      resumedUrlRef.current = url
      return
    }
    let frames = 0
    let cancelled = false
    const apply = (): void => {
      if (cancelled || resumedUrlRef.current === url) return
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
  }, [url, pageCount, resumePage, t, pagesReady, pagesSized])

  /** 翻页就记。防抖与去重都在 hook 里，这里只喂当前页。 */
  useEffect(() => {
    if (!scrolledRef.current || pageCount === 0) return
    notePage(currentPage)
  }, [currentPage, pageCount, notePage])

  /**
   * 改倍率前先固定屏幕上 (x, y) 这一点的文档位置。
   *
   * 只记「第几页 + 页内相对坐标」：混排 PDF 里各页高宽不同，按 scrollHeight
   * 比例还原会偏；按页记则不管页怎么变，同一个字仍落在同一个屏幕位置。
   * 点落在页间空隙或灰边上时就归到最近的一页，比例允许超出 0..1。
   */
  const captureZoomAnchor = useCallback((x: number, y: number): void => {
    const element = scrollRef.current
    const viewerElement = viewerApiRef.current?.element
    if (element === null || viewerElement === undefined) return
    const pages = Array.from(viewerElement.querySelectorAll<HTMLElement>(PAGE_SELECTOR))
    if (pages.length === 0) return
    const box = element.getBoundingClientRect()
    const docX = element.scrollLeft + x
    const docY = element.scrollTop + y
    let chosen = pages[0]
    for (const page of pages) {
      chosen = page
      const rect = page.getBoundingClientRect()
      const top = rect.top - box.top + element.scrollTop
      if (docY <= top + rect.height) break
    }
    const rect = chosen.getBoundingClientRect()
    const left = rect.left - box.left + element.scrollLeft
    const top = rect.top - box.top + element.scrollTop
    if (rect.width <= 0 || rect.height <= 0) return
    zoomAnchorRef.current = {
      page: Number(chosen.dataset.pageNumber),
      fx: (docX - left) / rect.width,
      fy: (docY - top) / rect.height,
      x,
      y,
    }
  }, [])

  /** 新布局落地后，把锚点那个文档点放回原来的屏幕位置（横竖两轴一起调）。 */
  const restoreZoomAnchor = useCallback((): void => {
    if (restoreRafRef.current !== null) window.cancelAnimationFrame(restoreRafRef.current)
    restoreRafRef.current = window.requestAnimationFrame(() => {
      restoreRafRef.current = null
      const anchor = zoomAnchorRef.current
      const element = scrollRef.current
      const viewerElement = viewerApiRef.current?.element
      if (anchor === null || element === null || viewerElement === undefined) return
      zoomAnchorRef.current = null
      const target = viewerElement.querySelector<HTMLElement>(
        `.page[data-page-number="${anchor.page}"]`,
      )
      if (target === null) return
      const box = element.getBoundingClientRect()
      const rect = target.getBoundingClientRect()
      element.scrollLeft = Math.max(
        0,
        element.scrollLeft + (rect.left - box.left) + anchor.fx * rect.width - anchor.x,
      )
      element.scrollTop = Math.max(
        0,
        element.scrollTop + (rect.top - box.top) + anchor.fy * rect.height - anchor.y,
      )
    })
  }, [])

  // 容器宽度变化：只有「适应宽度」需要重算倍率；重排前先记下视口中的文档点。
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    let width = element.clientWidth
    const observer = new ResizeObserver(() => {
      const next = element.clientWidth
      if (Math.abs(next - width) < 0.5) return
      width = next
      const api = viewerApiRef.current
      if (api === null || api.viewer.currentScaleValue !== 'page-width') return
      captureZoomAnchor(next / 2, element.clientHeight / 2)
      api.viewer.currentScaleValue = 'page-width'
      restoreZoomAnchor()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [captureZoomAnchor, restoreZoomAnchor])

  /** 按钮 / 命令行缩放按视口中心锚定；Ctrl+滚轮按鼠标位置锚定。 */
  const applyZoom = useCallback((next: number, at?: { x: number; y: number }): void => {
    const element = scrollRef.current
    const api = viewerApiRef.current
    if (element === null || api === null) return
    captureZoomAnchor(at?.x ?? element.clientWidth / 2, at?.y ?? element.clientHeight / 2)
    const percent = Math.min(Math.max(Math.round(next), MIN_ZOOM), MAX_ZOOM)
    api.viewer.currentScaleValue = String(percent / 100)
    restoreZoomAnchor()
  }, [captureZoomAnchor, restoreZoomAnchor])

  const fitToWidth = useCallback((): void => {
    const element = scrollRef.current
    const api = viewerApiRef.current
    if (element === null || api === null) return
    captureZoomAnchor(element.clientWidth / 2, element.clientHeight / 2)
    api.viewer.currentScaleValue = 'page-width'
    restoreZoomAnchor()
  }, [captureZoomAnchor, restoreZoomAnchor])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const api = viewerApiRef.current
      if (api === null) return
      const rect = element.getBoundingClientRect()
      const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
      // 触控板捏合等合成事件偶尔带 0 坐标，夹回可视区内，免得锚点落到屏外把页面推偏。
      applyZoom(api.viewer.currentScale * 100 * factor, {
        x: Math.min(Math.max(event.clientX - rect.left, 0), element.clientWidth),
        y: Math.min(Math.max(event.clientY - rect.top, 0), element.clientHeight),
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [applyZoom])

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

  /** 点中标注时打开卡片；命中测试用 pdf.js 页面当前 viewport，和覆盖层保持同一套坐标。 */
  const onViewerClick = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    if (window.getSelection()?.toString().trim() !== '') return
    const target = (event.target as Element | null)?.closest<HTMLElement>(PAGE_SELECTOR)
    const api = viewerApiRef.current
    if (target === null || target === undefined || api === null) return
    const pageNumber = Number(target.dataset.pageNumber)
    if (!Number.isFinite(pageNumber)) return
    const pageView = api.viewer.getPageView(pageNumber - 1)
    const list = annotationsByPage.get(pageNumber - 1)
    if (pageView === undefined || list === undefined) return
    const rect = target.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    for (const annotation of list) {
      for (const source of annotation.position?.rects ?? []) {
        const box = viewportBox(pageView.viewport, source)
        if (
          x >= box.left
          && x <= box.left + box.width
          && y >= box.top
          && y <= box.top + box.height
        ) {
          onAnnotationClick(annotation, event.clientX, event.clientY)
          return
        }
      }
    }
  }, [annotationsByPage, onAnnotationClick])

  /**
   * 滚动只做两件事：标记「用户读过」，以及收起浮条。
   * 当前页由 pdf.js 的 `pagechanging` 事件维护，不需要自己再算一遍页面位置。
   */
  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return
    const onScroll = (): void => {
      scrolledRef.current = true
      if (selectionRef.current !== null) {
        rangeRef.current = null
        setSelection(null)
      }
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

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
        viewportOf: (pageNumber) => viewerApiRef.current?.viewer.getPageView(pageNumber - 1)?.viewport ?? null,
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
    const target = element.querySelector<HTMLElement>(`.page[data-page-number="${pageIndex + 1}"]`)
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
    const current = Math.round((viewerApiRef.current?.viewer.currentScale ?? 1) * 100)
    const next = ZOOM_STEPS.find((step) => step > current) ?? MAX_ZOOM
    applyZoom(next)
  }

  function zoomOut(): void {
    const current = Math.round((viewerApiRef.current?.viewer.currentScale ?? 1) * 100)
    const next = [...ZOOM_STEPS].reverse().find((step) => step < current) ?? MIN_ZOOM
    applyZoom(next)
  }

  /**
   * 把某一页（1 基）滚到视口顶部。
   *
   * 页面 DOM 还没建好（`setDocument` 尚未跑完）时返回 false，调用方据此重试 ——
   * 续读与页码跳转都要等这一步。
   */
  function scrollToPage(page: number): boolean {
    const element = scrollRef.current
    const target = element?.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`)
    if (element === null || target === null || target === undefined) return false
    const rect = target.getBoundingClientRect()
    const box = element.getBoundingClientRect()
    element.scrollTop += rect.top - box.top
    setCurrentPage(page)
    return true
  }

  function selectionLocation(text: string): EvidenceLocation {
    const range = rangeRef.current
    const start = range?.startContainer
    const element = start instanceof Element ? start : start?.parentElement
    const page = element?.closest<HTMLElement>('.page[data-page-number]')
    const layer = element?.closest<HTMLElement>('.textLayer')
    const pdfRange = range && layer ? offsetsWithin(layer, range) : undefined
    const number = Number(page?.dataset.pageNumber)
    return {
      page: Number.isInteger(number) && number > 0 ? number : undefined,
      pageLabel: page?.dataset.zpPageLabel || undefined,
      quote: (pdfRange && range ? range.toString().trimStart() : text).slice(0, 240),
      pdfRange,
    }
  }

  function goToEvidence(target: EvidenceTarget): boolean {
    const page = target.page
    if (page === undefined || page > pageCount || !pagesSized) return false
    if (positionedEvidence.current !== target) {
      if (!scrollToPage(page)) return false
      resumedUrlRef.current = url
      positionedEvidence.current = target
    }
    if (!target.quote) return true
    const layer = scrollRef.current?.querySelector<HTMLElement>(`.page[data-page-number="${page}"] .textLayer`)
    return layer !== null && layer !== undefined
      && ((target.pdfRange !== undefined && revealOffsets(layer, target.pdfRange, target.quote))
        || revealQuote(layer, target.quote, true) || revealQuote(layer, target.quote))
  }

  function goToPage(page: number): void {
    if (page < 1 || page > pageCount) return
    scrollToPage(page)
  }

  useImperativeHandle(viewerRef, () => ({
    locate,
    goToEvidence,
    currentPage: () => currentPageRef.current,
    goToPage,
    goToOutline: (target) => {
      if (target?.kind === 'page') goToPage(target.page)
    },
    zoomIn,
    zoomOut,
    setZoom: (percent: number) => applyZoom(percent),
    fitToWidth,
  }))

  useEffect(() => () => {
    if (restoreRafRef.current !== null) window.cancelAnimationFrame(restoreRafRef.current)
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
  }, [])

  // 卡片开着时点别处 / 按 Esc 就收起，与快照渲染器共用同一套（见 `dismiss.ts`）。
  useDismiss(card !== null, cardRef, () => setCard(null))

  const rootWidth = rootRef.current?.clientWidth ?? 320
  const rootHeight = rootRef.current?.clientHeight ?? 400
  const cardLeft = card === null ? 0 : Math.max(8, Math.min(card.x, rootWidth - ANNOTATION_CARD_OUTER_WIDTH - 8))
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
        onClick={onViewerClick}
      >
        {viewerApi !== null && createPortal(
          <AnnotationLayer
            viewer={viewerApi.viewer}
            annotationsByPage={annotationsByPage}
            flashKey={flashKey}
          />,
          viewerApi.element,
        )}
      </div>

      {loading && (
        <div style={hintOverlayStyle}>
          <span>{t('viewer.loading')}</span>
        </div>
      )}

      {error !== null && (
        <div style={hintOverlayStyle}>
          <div style={{ maxWidth: 300, textAlign: 'center', pointerEvents: 'auto' }}>
            <p style={{ margin: '0 0 8px', lineHeight: 1.5 }}>{error.text}</p>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setRetry((value) => value + 1)} style={smallButtonStyle}>
                {t('action.retry')}
              </button>
              <button
                type="button"
                onClick={() => onOpenInZotero(1)}
                style={zoteroButtonStyle}
              >
                <OpenInZoteroIcon />
                {t('viewer.openInZotero')}
              </button>
              {error.fix !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    openSystemSettings(error.fix as ApiFix).catch((reason: unknown) => {
                      showToast(tpl(t('viewer.openSettingsFailed'), { message: errorText(reason) }))
                    })
                  }}
                  style={smallButtonStyle}
                >
                  {t('viewer.openPrivacySettings')}
                </button>
              )}
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
          onInsert={(text) => onInsertExcerpt(text, selectionLocation(text))}
          onDismiss={() => {
            rangeRef.current = null
            setSelection(null)
          }}
          annotate={
            detail.writeEnabled && source !== null && !loading
              ? { busy: marking, onCreate: (type, color, comment) => void createMark(type, color, comment) }
              : undefined
          }
          translate={{ onTranslate: (text, x, y) => {
            translationLocation.current = selectionLocation(text)
            translation.open(text, x, y)
          } }}
        />
      )}

      {translation.view !== null && (
        <TranslationCard
          t={t}
          view={translation.view}
          bounds={{ width: rootWidth, height: rootHeight }}
          engine={translation.engine}
          onEngineChange={translation.setEngine}
          onClose={translation.close}
          onRetry={translation.retry}
          onInsert={(text, translated) => onInsertTranslation(text, translated, translationLocation.current)}
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

/** 只有跳 Zotero 这个按钮带图标：单独补 flex 对齐，不动旁边的「重试 / 打开系统设置」。 */
const zoteroButtonStyle = {
  ...smallButtonStyle,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
} as const
