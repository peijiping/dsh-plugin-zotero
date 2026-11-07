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
  /** 同源文件地址：`/dsh-zotero/api/file?key=...`。 */
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
  zoomIn(): void
  zoomOut(): void
  setZoom(percent: number): void
  fitToWidth(): void
}

export interface ZoomState {
  percent: number
  fitWidth: boolean
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

/** 从文件名取小写扩展名。 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}
