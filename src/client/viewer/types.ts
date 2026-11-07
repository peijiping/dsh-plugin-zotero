/**
 * 文档渲染器的统一契约。
 *
 * `ItemDetail` 只认这层接口：按附件 MIME / 扩展名选一个渲染器，渲染器自己负责
 * 加载、缩放、分页与标注叠加。新增 Word / Markdown / EPUB 等格式时，
 * 实现一个 `DocumentRenderer` 并注册到 `registry.ts` 即可，不需要改版面。
 */

import type { ComponentType, MutableRefObject } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail } from '../../zotero/types'
import type { Translate } from '../locales'

/** 当前展示的一份文档。 */
export interface DocumentSource {
  attachmentKey: string
  /** Zotero 给的 MIME；可能为空。 */
  contentType: string
  /** 小写扩展名（不含点）；MIME 缺失时用于兜底匹配。 */
  ext: string
  title: string
  /** 该渲染器可用的同源地址：PDF 是 `/dsh-zotero/api/file?key=`，快照是目录形快照路由。 */
  url: string
}

export interface ViewerCapabilities {
  /** 是否支持缩放；不支持时工具条隐藏缩放控件。 */
  zoom: boolean
  /** 是否有分页概念；影响页码显示。 */
  pageNavigation: boolean
}

/** 外层通过 ref 调用的命令。 */
export interface ViewerHandle {
  /** 滚动到指定标注；未就绪或标注无位置时返回 false。 */
  locate(annotationKey: string): boolean
  currentPage(): number
  /** 跳到指定页（1 基）。不支持分页的渲染器是空实现。 */
  goToPage(page: number): void
  zoomIn(): void
  zoomOut(): void
  setZoom(percent: number): void
  fitToWidth(): void
}

export interface ZoomState {
  percent: number
  fitWidth: boolean
}

/**
 * 文档目录的一项（PDF 书签）。
 *
 * 渲染器把树拍平上报：面板只按 `depth` 缩进，不重建嵌套 —— 长目录真正要的是
 * 「一眼看完 + 点一下跳过去」，折叠交互换不来这个，却要多养一套开合状态。
 */
export interface DocumentOutlineItem {
  /** 书签标题，PDF 里原样存着的（多数自带「1.2.3」这类编号）。 */
  title: string
  /** 目标页（1 基）；`null` 表示这条书签只有外链，或目标解析不出来。 */
  page: number | null
  /** 层级：0 为顶层。 */
  depth: number
}

export interface DocumentRendererProps {
  t: Translate
  detail: ZoteroItemDetail
  source: DocumentSource | null
  annotations: ZoteroAnnotation[]
  viewerRef: MutableRefObject<ViewerHandle | null>
  onReady(): void
  onZoomChange(state: ZoomState): void
  onPageChange(page: number, total: number): void
  onInsertExcerpt(quote: string): void
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  onOpenInZotero(page: number): void
  /**
   * 上报文档目录（PDF 书签）。
   *
   * 只有**带页内跳转**的渲染器需要实现：不实现就永远不报，面板里显示「没有目录」。
   * 实现时一律上报**完整的一份**（不是增量），没有书签就明确报空数组 —— 空数组与
   * 「还没读到」是两种状态，面板显示的话不一样。
   */
  onOutlineChange?(outline: DocumentOutlineItem[]): void
  /**
   * 写成功后的重取。
   *
   * 渲染器只在建标注时用得到（写完要让列表与叠加层看到库里那条新建的），但契约上
   * 一律要求：漏传一次就是「写进去了但界面上看不见」，那种 bug 最难查。
   */
  onChanged(): void
}

export interface DocumentRenderer {
  id: string
  capabilities: ViewerCapabilities
  match(source: DocumentSource | null, detail: ZoteroItemDetail): boolean
  Component: ComponentType<DocumentRendererProps>
}

/** 附件是否可交给 PDF 渲染器。 */
export function isPdf(source: { contentType: string; ext: string }): boolean {
  return source.contentType.split(';')[0].trim().toLowerCase() === 'application/pdf'
    || source.ext === 'pdf'
}

/** 附件是否是网页快照（HTML），可交给 iframe 渲染器。 */
export function isHtml(source: { contentType: string; ext: string }): boolean {
  const mime = source.contentType.split(';')[0].trim().toLowerCase()
  return mime === 'text/html' || mime === 'application/xhtml+xml'
    || source.ext === 'html' || source.ext === 'htm' || source.ext === 'xhtml'
}

/** 从文件名取小写扩展名。 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}
