import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

import { OUTLINE_MAX_DEPTH, OUTLINE_MAX_ITEMS, pageTarget } from './outline'
import type { DocumentOutlineItem } from './types'

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
export async function readPdfOutline(pdf: PDFDocumentProxy): Promise<DocumentOutlineItem[]> {
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
      const page = await outlinePageOf(pdf, node.dest)
      out.push({
        title: (node.title ?? '').trim() || '(无标题)',
        target: page === null ? null : pageTarget(page),
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
