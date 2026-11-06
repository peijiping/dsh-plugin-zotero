/**
 * 渲染器注册表：按顺序匹配，第一个命中的负责渲染。
 *
 * PDF 排在文本兜底之前；以后加 Word / EPUB 时，实现一个 `DocumentRenderer`
 * 并插到文本兜底之前即可，`DocumentView` 与版面都不需要改。
 */

import type { ZoteroItemDetail } from '../../zotero/types'
import { PdfViewer } from './PdfViewer'
import { TextViewer } from './TextViewer'
import { isPdf, type DocumentRenderer, type DocumentSource } from './types'

export const RENDERERS: readonly DocumentRenderer[] = [
  {
    id: 'pdf',
    capabilities: { zoom: true, pageNavigation: true },
    match: (source) => source !== null && isPdf(source),
    Component: PdfViewer,
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
