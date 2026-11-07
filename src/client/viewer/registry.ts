/**
 * 渲染器注册表：按顺序匹配，第一个命中的负责渲染。
 *
 * 顺序有讲究：网页快照排在 PDF 之前（两者不会同时匹配同一附件，但语义上更具体），
 * 「网页条目兜底」排在 PDF 之后 —— 这样挂了大 PDF 的 webpage 条目仍然走 PDF。
 *
 * 以后加 Word / EPUB 时，实现一个 `DocumentRenderer` 并插到文本兜底之前即可，
 * `DocumentView` 与版面都不需要改。
 *
 * 新渲染器若要支持「新建 + 修改高亮」，直接复用两件现成的东西，别再各写一套：
 * - 划选浮条：`SelectionBar`（传 `annotate` 即出现色块与类型 chip）
 * - 点标注的编辑卡片：`AnnotationCard`（换色 / 评论 / 换类型 / 删除）
 * 渲染器自己只负责「选区从哪来」与「点在哪个标注上」这两件事。
 *
 * 浮层的「点别处 / Esc 收起」也不用渲染器操心：`dismiss.ts` 订阅父页面 `document`
 * 已经覆盖 PDF / 文本这类跑在父 DOM 里的渲染器；只有**自带独立文档表面**的渲染器
 * （快照 iframe，将来的 canvas / 外挂窗口等）要在自己的指针事件里额外调一次
 * `notifyDocumentPress()`，否则浮层在它里面点不掉。
 */

import type { ZoteroItemDetail } from '../../zotero/types'
import { PdfViewer } from './PdfViewer'
import { SnapshotViewer } from './SnapshotViewer'
import { TextViewer } from './TextViewer'
import { WebpageViewer } from './WebpageViewer'
import { isHtml, isPdf, type DocumentRenderer, type DocumentSource } from './types'

export const RENDERERS: readonly DocumentRenderer[] = [
  {
    id: 'snapshot',
    capabilities: { zoom: false, pageNavigation: false },
    match: (source) => source !== null && isHtml(source),
    Component: SnapshotViewer,
  },
  {
    id: 'pdf',
    capabilities: { zoom: true, pageNavigation: true },
    match: (source) => source !== null && isPdf(source),
    Component: PdfViewer,
  },
  {
    /**
     * 网页条目但没有可渲染的附件（没有快照，或只剩 Zotero 索引的纯文本）。
     * 必须排在 pdf 之后：挂了大 PDF 的 webpage 条目应该看 PDF 而不是这句提示。
     */
    id: 'webpage',
    capabilities: { zoom: false, pageNavigation: false },
    match: (source, detail) =>
      detail.itemType === 'webpage' && (source === null || (!isPdf(source) && !isHtml(source))),
    Component: WebpageViewer,
  },
  {
    id: 'text',
    capabilities: { zoom: false, pageNavigation: false },
    match: () => true,
    Component: TextViewer,
  },
]

export function pickRenderer(source: DocumentSource | null, detail: ZoteroItemDetail): DocumentRenderer {
  return RENDERERS.find((renderer) => renderer.match(source, detail)) ?? RENDERERS[RENDERERS.length - 1] as DocumentRenderer
}
