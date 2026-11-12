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
import type { CaptureAdapter, CaptureKind } from './shot/types'

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
  /**
   * 是否提供目录。
   *
   * 目录按钮只有一份（`OutlinePanel`），这里只决定它出不出现：PDF 书签、网页标题、
   * 笔记标题都由各自的渲染器解析后上报，与「有没有页码」无关。
   */
  outline: boolean
  /**
   * 截图采集能力。按钮可用性由它决定，不猜 `renderer.id`：
   * `pdf` 读页 canvas、`dom` 序列化父 DOM、`iframe` 需二期桥接、`none` 无可截内容。
   */
  capture: CaptureKind
}

/**
 * 一条目录项的跳转目标。
 *
 * - `page`：PDF 书签，交给 {@link ViewerHandle.goToPage}；
 * - `anchor`：HTML / 笔记 / 纯文本里的标题，`id` 的含义由渲染器自己定（元素锚点序号、
 *   文本字符偏移等）——面板只负责把它原样传回来，不解释。
 *
 * `null` 表示这条只有标题、跳不过去（例如只有外链的 PDF 书签），面板会置灰。
 */
export type OutlineTarget =
  | { kind: 'page'; page: number }
  | { kind: 'anchor'; id: string }

/** 外层通过 ref 调用的命令。 */
export interface ViewerHandle {
  /** 滚动到指定标注；未就绪或标注无位置时返回 false。 */
  locate(annotationKey: string): boolean
  currentPage(): number
  /** 跳到指定页（1 基）。不支持分页的渲染器是空实现。 */
  goToPage(page: number): void
  /** 跳到一条目录项：PDF 按页，HTML / 笔记按锚点；类型不匹配的渲染器忽略。 */
  goToOutline(target: OutlineTarget | null): void
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
 * 文档目录的一项（PDF 书签 / 网页标题 / 笔记标题共用）。
 *
 * 渲染器把树拍平上报：面板只按 `depth` 缩进，不重建嵌套 —— 长目录真正要的是
 * 「一眼看完 + 点一下跳过去」，折叠交互换不来这个，却要多养一套开合状态。
 */
export interface DocumentOutlineItem {
  /** 标题原文（PDF 书签多数自带「1.2.3」这类编号；HTML 标题取纯文本）。 */
  title: string
  /** 跳转目标；`null` 表示只有标题、定位不了，面板置灰。 */
  target: OutlineTarget | null
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
  /** 划词翻译的「加入对话」：原文与译文一起成一条 chip。 */
  onInsertTranslation(quote: string, translated: string): void
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  onOpenInZotero(page: number): void
  /**
   * 上报文档目录（PDF 书签、网页 h1–h6、笔记标题）。
   *
   * 凡是 `capabilities.outline` 为 true 的渲染器都要实现：不报就永远停在「正在读取目录…」。
   * 一律上报**完整的一份**（不是增量），没有标题就明确报空数组 —— 空数组与
   * 「还没读到」是两种状态，面板显示的话不一样。解析逻辑尽量复用 `outline.ts`。
   */
  onOutlineChange?(outline: DocumentOutlineItem[]): void
  /**
   * 采集能力自注册。
   *
   * PDF / 纯文本的采集由 `shot/` 按正文容器自己做，不需要渲染器参与；网页快照
   * 例外——它必须经由 iframe 里的桥接脚本，而只有 `SnapshotViewer` 拿得到那个
   * iframe 与消息通道。所以它在挂载时把适配器写进这个 ref，卸载时清空；
   * `ItemDetail` 侧只认接口，不认具体渲染器。
   */
  captureRef?: MutableRefObject<CaptureAdapter | null>
  /**
   * 采集能力变化（`captureRef` 里的适配器换了状态）。
   *
   * 网页快照的按钮要等桥接脚本 `ready` 才可用，而那个状态住在 `SnapshotViewer`
   * 内部。父级据此重渲染一次，按钮就从禁用变可用——状态不冒泡的话它会一直是禁用。
   */
  onCaptureChange?(): void
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
