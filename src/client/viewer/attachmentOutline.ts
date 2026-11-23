import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

import type { ZoteroAttachment } from '../../zotero/types'
import { fileUrl, snapshotUrl } from '../api'
import { headingDepths, OUTLINE_MAX_ITEMS, parseMarkdownHeadings } from './outline'
import { readPdfOutline } from './pdfOutline'
import { PDF_ASSET_BASE } from './pdfjs'
import { extensionOf, isHtml, isPdf, type DocumentOutlineItem } from './types'

/** Read headings from the selected attachment without mounting its reader. */
export async function readAttachmentOutline(
  attachment: ZoteroAttachment | undefined,
  content: string,
  signal: AbortSignal,
): Promise<DocumentOutlineItem[]> {
  const source = attachment && {
    contentType: attachment.contentType,
    ext: extensionOf(attachment.filename || attachment.title),
  }
  if (attachment && source && isPdf(source)) {
    const task = getDocument({
      url: fileUrl(attachment.key),
      cMapUrl: `${PDF_ASSET_BASE}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDF_ASSET_BASE}standard_fonts/`,
      wasmUrl: `${PDF_ASSET_BASE}wasm/`,
    })
    const cancel = (): void => { void task.destroy().catch(() => undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const pdf = await task.promise
      const outline = await readPdfOutline(pdf)
      return outline.length > 0 ? outline : parseMarkdownHeadings(content)
    } finally {
      signal.removeEventListener('abort', cancel)
      await task.destroy()
    }
  }
  if (attachment && source && isHtml(source)) {
    const response = await fetch(snapshotUrl(attachment.key), { signal })
    if (!response.ok) throw new Error(`Cannot read attachment headings (HTTP ${response.status})`)
    const document = new DOMParser().parseFromString(await response.text(), 'text/html')
    const headings = [...document.body.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .map((node) => ({ title: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '', level: Number(node.tagName[1]) }))
      .filter((heading) => heading.title !== '')
      .slice(0, OUTLINE_MAX_ITEMS)
    const depths = headingDepths(headings.map((heading) => heading.level))
    // The mounted reader filters headings by visibility. Its anchor ids may differ
    // from this inert document, so evidence uses the quoted text to locate the source.
    return headings.map((heading, index) => ({
      title: heading.title, depth: depths[index], target: null,
    }))
  }
  return parseMarkdownHeadings(content)
}
