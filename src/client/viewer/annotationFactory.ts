/**
 * 选区 → 待写入 Zotero 的标注。
 *
 * 只有客户端手里有三样东西：pdf.js 的 viewport、文本层的 DOM、以及当前的缩放，
 * 所以位置、排序键、原文都在这里算完，Host 只负责校验和序列化。
 *
 * 算法逐条对齐本机 Zotero 10.0.7 阅读器的实现（`resource/reader/reader.js`），
 * 「复刻」而非「自创」，插件建的标注才会和 Zotero 自建的那条画在同一个矩形、
 * 排在同一个顺序上：
 *
 * - `rects`：`v2p()` —— 对角点各 `convertToPdfPoint` 再取包围盒（见 `pdfBox`）；
 * - 精度：`roundPositionValues()` —— 3 位小数；
 * - 排序键：`getSortIndex()` —— `页码|字符偏移|距页顶的整点数`；
 * - 跨页选区：每页一条，与 Zotero 的 selectionRange 切分一致。
 */

import type { PageViewport, PDFDocumentProxy } from 'pdfjs-dist'

import type { ZoteroAnnotationDraft } from '../../zotero/types'
import { pdfBox, roundPosition } from './geometry'

/** 同一行两段之间允许的空隙（CSS px）：超过它就不并，两栏版式因此不会被拉通。 */
const SAME_LINE_GAP = 4
/** 一次提交最多的页数：正常选区用不到，只挡「全选整本书」级别的误操作。 */
const MAX_PAGES = 20
/** 原文长度上限，与 Host 的正文体量校验同一意图。 */
const MAX_TEXT_CHARS = 20_000

const PAGE_SELECTOR = '[data-zp-page]'

/** 页面元素左上角为原点的矩形（即 viewport 坐标）。 */
interface PageBox {
  left: number
  top: number
  width: number
  height: number
}

interface PageGroup {
  pageNumber: number
  pageElement: HTMLElement
  boxes: PageBox[]
  text: string
  /** 该页第一个被选中字符：排序键中间的偏移段由它算。 */
  anchor: { node: Node; offset: number } | null
}

function pad(value: number, length: number): string {
  return String(value).slice(0, length).padStart(length, '0')
}

function pageNumberOf(element: Element): number {
  const raw = Number.parseInt(element.getAttribute('data-zp-page') ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * 把同一行的相邻文本段并成一段。
 *
 * 一行由多个文本项 span 拼成，Zotero 按字符算出的是一条整行矩形；我们按 DOM 取，
 * 不并就会一条行拆成几段。判定只看纵向重叠过半 + 横向相接，两栏版式里同高的两段
 * 之间隔着栏宽，不会被误并。
 */
function mergeLines(boxes: PageBox[]): PageBox[] {
  const lines: PageBox[] = []
  for (const box of boxes) {
    const matched = lines.find((line) => {
      const overlap = Math.min(line.top + line.height, box.top + box.height) - Math.max(line.top, box.top)
      if (overlap <= Math.min(line.height, box.height) * 0.5) return false
      const gap = Math.max(line.left, box.left) - Math.min(line.left + line.width, box.left + box.width)
      return gap <= SAME_LINE_GAP
    })
    if (matched === undefined) {
      lines.push({ ...box })
      continue
    }
    const left = Math.min(matched.left, box.left)
    const top = Math.min(matched.top, box.top)
    matched.width = Math.max(matched.left + matched.width, box.left + box.width) - left
    matched.height = Math.max(matched.top + matched.height, box.top + box.height) - top
    matched.left = left
    matched.top = top
  }
  return lines
}

/** 从属文本层容器往回找页元素。 */
function pageElementOf(node: Node): HTMLElement | null {
  const parent = node.parentElement
  return parent === null ? null : parent.closest<HTMLElement>(PAGE_SELECTOR)
}

/** 换行占位 span 里的 `\n` 不是 Zotero 字符表里的字符，数偏移时要跳过。 */
function charCountOf(node: Node): number {
  if (node instanceof Element && node.classList.contains('dsh-zotero-pdf-eol')) return 0
  return node.textContent?.length ?? 0
}

/**
 * 数容器里某个字符节点之前有多少个字符。
 *
 * 递归下去的那一层要把前面兄弟节点已经数到的量带上，否则返回值就成了「段内偏移」。
 */
function countBefore(host: Node, node: Node, offset: number): number {
  if (host === node) return offset
  let total = 0
  for (const child of Array.from(host.childNodes)) {
    if (child === node) return total + offset
    if (child.contains(node)) {
      const deeper = countBefore(child, node, offset)
      return deeper >= 0 ? total + deeper : total
    }
    total += charCountOf(child)
  }
  return -1
}

/**
 * 排序键里的字符偏移段。
 *
 * Zotero 用 `getClosestOffset()` 在整页字符数组里找与首个矩形最近的下标；对一段连续
 * 选区，那个下标就是选中首字符在页内的位置。文本层的 span 与 pdf.js 文本项一一对应、
 * 顺序也一致，所以直接数整页 DOM 字符等价，且省掉一次 `getTextContent()`。
 */
function charOffsetOf(pageElement: HTMLElement, anchor: { node: Node; offset: number }): number {
  const layer = pageElement.querySelector<HTMLElement>('.dsh-zotero-pdf-text')
  if (layer === null || !layer.contains(anchor.node)) return 0
  const before = countBefore(layer, anchor.node, anchor.offset)
  return before >= 0 ? before : 0
}

/** Zotero 的 `getTopMostRectFromPosition()`：按索引 2 降序取第一个（源码即如此）。 */
function topMostRect(rects: [number, number, number, number][]): [number, number, number, number] | null {
  if (rects.length === 0) return null
  return [...rects].sort((a, b) => b[2] - a[2])[0] ?? null
}

/**
 * Zotero 形态的排序键：`页码|页内字符偏移|距页顶的整点数`。
 *
 * `top` 用 PDF 用户空间（y 轴朝上）算，页高取 `page.view` 的上下边之差 —— 与它
 * `pdfPages[i].viewBox` 同一份数。越靠页面上方越小，Zotero 列表即按它排序。
 */
function sortIndex(
  pageIndex: number,
  rects: [number, number, number, number][],
  view: readonly number[],
  offset: number,
): string {
  const rect = topMostRect(rects)
  let top = 0
  if (rect !== null) {
    const pageHeight = view[3] - view[1]
    top = Math.max(0, Math.floor(pageHeight - rect[3]))
  }
  return [pad(pageIndex, 5), pad(Math.max(0, offset), 6), pad(top, 5)].join('|')
}

export interface SelectionDraftInput {
  /** 必须来自 `Range.cloneRange()`：实时选区 Range 会被清掉。 */
  range: Range
  pdf: PDFDocumentProxy
  /** 页面 wrapper 所在的那层，用于限定归属范围。 */
  pagesRoot: HTMLElement
  /** 当前缩放；页面元素的实际尺寸就是同一 scale 下的 viewport。 */
  scale: number
  annotationType: string
  annotationColor: string
  annotationComment?: string
}

/**
 * 把一次选区换成「每页一条」的待写标注。
 *
 * 返回空数组表示这段选区没落在任何已渲染的 PDF 页面上（例如选到了信息面板）。
 */
export async function draftsFromSelection(input: SelectionDraftInput): Promise<ZoteroAnnotationDraft[]> {
  const { range, pdf, pagesRoot, scale, annotationType, annotationColor, annotationComment } = input
  if (range.collapsed || pagesRoot.querySelector(PAGE_SELECTOR) === null) return []

  const groups = new Map<number, PageGroup>()
  // TreeWalker 的 root 只能给 Node：选区正好落在单个文本节点里时，公共祖先就是那个
  // 节点本身，得往上一层才走得到它。
  const common = range.commonAncestorContainer
  const walkRoot = common.nodeType === Node.TEXT_NODE ? common.parentElement : (common as Element)
  if (walkRoot === null) return []
  const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT, {
    acceptNode: (candidate) => (range.intersectsNode(candidate) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  let node = walker.nextNode() as Text | null
  // 边界节点只被选中一部分，按 startOffset / endOffset 切。
  while (node !== null) {
    const data = node.data
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : data.length
    const text = data.slice(Math.max(0, Math.min(start, data.length)), Math.max(0, Math.min(end, data.length)))
    const pageElement = pageElementOf(node)
    if (text !== '' && pageElement !== null && pagesRoot.contains(pageElement)) {
      const pageNumber = pageNumberOf(pageElement)
      let group = groups.get(pageNumber)
      if (group === undefined) {
        group = { pageNumber, pageElement, boxes: [], text: '', anchor: null }
        groups.set(pageNumber, group)
      }
      if (group.anchor === null) {
        group.anchor = { node, offset: Math.max(0, Math.min(start, data.length)) }
      }
      group.text += text
      // 换行占位 span 被挪到了页外（left:-9999px），只出 \n，不能进矩形。
      if (node.parentElement?.classList.contains('dsh-zotero-pdf-eol') !== true) {
        const sub = document.createRange()
        sub.selectNode(node)
        if (node === range.startContainer) sub.setStart(node, start)
        if (node === range.endContainer) sub.setEnd(node, end)
        const rect = sub.getBoundingClientRect()
        const origin = pageElement.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          group.boxes.push({
            left: rect.left - origin.left,
            top: rect.top - origin.top,
            width: rect.width,
            height: rect.height,
          })
        }
      }
    }
    node = walker.nextNode() as Text | null
  }

  const labels = await pageLabels(pdf)
  const drafts: ZoteroAnnotationDraft[] = []
  for (const pageNumber of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(pageNumber)
    if (group === undefined || group.boxes.length === 0 || group.anchor === null) continue
    const text = group.text.replace(/\r\n?/gu, '\n').replace(/\n/gu, ' ').trim()
    if (text === '') continue
    const page = await pdf.getPage(pageNumber)
    const viewport: PageViewport = page.getViewport({ scale })
    const rects = mergeLines(group.boxes).map((box) => pdfBox(viewport, box).map(roundPosition) as [number, number, number, number])
    const pageIndex = pageNumber - 1
    const position = { pageIndex, rects }
    drafts.push({
      annotationType,
      annotationText: text.slice(0, MAX_TEXT_CHARS),
      annotationColor,
      annotationPageLabel: labels[pageIndex] ?? String(pageNumber),
      annotationSortIndex: sortIndex(pageIndex, rects, page.view, charOffsetOf(group.pageElement, group.anchor)),
      position,
      ...(annotationComment === undefined || annotationComment === '' ? {} : { annotationComment }),
    })
    if (drafts.length >= MAX_PAGES) break
  }
  return drafts
}

/**
 * 印刷页码标签（`2` / `iii` 这类）。
 *
 * 没有标签的 PDF 占多数，`getPageLabels()` 会给 null 或全空数组，那时退回物理页号 ——
 * Zotero 自己存的也是这个值。
 */
async function pageLabels(pdf: PDFDocumentProxy): Promise<string[]> {
  try {
    const labels = await pdf.getPageLabels()
    return labels ?? []
  } catch {
    return []
  }
}
