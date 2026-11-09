/**
 * 目录（大纲）的公共契约与解析。
 *
 * 左上角那个目录浮层只有一份，三类文档都往里报：
 * - PDF：`PdfViewer` 读 pdf.js 的书签树，目标按页；
 * - 网页快照：`snapshot/runtime.js` 在 iframe 里扫 h1–h6，目标按锚点；
 * - 笔记 / 全文文本：这里解析 HTML 标题或 Markdown `#` 标题，目标按锚点 / 字符偏移。
 *
 * Zotero 本地 API 与集成 MCP 都**没有**目录端点（PDF 那条路早就查过，快照 / 笔记
 * 同样没有），所以三处一律自己从文档内容里提，不新造服务端接口。
 *
 * 快照 iframe 里的桥接脚本必须是纯 classic JS，import 不了本文件；约定（标题选择器、
 * 锚点属性名、层级归一化、上限）在 `snapshot/runtime.js` 里有一份等价实现，改这里
 * 记得同步改那边。
 */

import type { DocumentOutlineItem, OutlineTarget } from './types'

/** 单份文档的目录条目上限：几千条的目录没人翻得完，面板也画不动。 */
export const OUTLINE_MAX_ITEMS = 800
/** 缩进层级上限，再深就不再往外推。 */
export const OUTLINE_MAX_DEPTH = 8

/**
 * 加到标题元素上的临时锚点属性。
 *
 * 只出现在插件自己生成的 HTML 里（笔记正文经 {@link parseHtmlHeadings} 加工），
 * 不会写回 Zotero；不用原生 `id`，免得撞上笔记里本来就有的锚点。
 */
export const OUTLINE_ANCHOR_ATTR = 'data-dsh-zp-outline'

export function pageTarget(page: number): OutlineTarget {
  return { kind: 'page', page }
}

export function anchorTarget(id: string | number): OutlineTarget {
  return { kind: 'anchor', id: String(id) }
}

/**
 * 标题级别 → 缩进层级。
 *
 * 以整篇文档里**最小的标题级别**为 0：通篇只有 h3 的页面不该整体缩进两格，
 * 网页快照尤其常见（正文从 h2 起）。PDF 书签不用这个，它自带树形层级。
 */
export function headingDepths(levels: number[]): number[] {
  if (levels.length === 0) return []
  const base = Math.min(...levels)
  return levels.map((level) => Math.max(0, Math.min(OUTLINE_MAX_DEPTH - 1, level - base)))
}

const HTML_HEADING_TAGS: Record<string, number> = {
  H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6,
}

/** 元素纯文本或纯文本行里的 Markdown 标题（`# 标题`）。 */
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u
const MARKDOWN_LINE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u

function tidy(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export interface ParsedHtmlOutline {
  /** 加了锚点属性后的正文 HTML，交给 `dangerouslySetInnerHTML`。 */
  html: string
  items: DocumentOutlineItem[]
}

/**
 * 从 HTML 片段里提标题，并给每个标题打上锚点。
 *
 * 笔记是 Zotero 存的 HTML：标题通常是 `<h1>`–`<h6>`，但 Markdown 源码被原样贴进
 * 笔记时会变成 `<p># 标题</p>`，所以两种都认。解析用 `DOMParser` 的 inert 文档，
 * 只取节点与文本、不执行任何脚本；正文里危险的标签 Host 侧已经剥过。
 *
 * 返回加工后的 HTML 而不是只返回条目：标题节点要带锚点，跳转才有落点。
 */
export function parseHtmlHeadings(html: string): ParsedHtmlOutline {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const candidates = Array.from(
    doc.body.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,blockquote'),
  )
  const picked: { element: HTMLElement; level: number; title: string }[] = []
  const pickedElements = new Set<HTMLElement>()

  for (const element of candidates) {
    if (picked.length >= OUTLINE_MAX_ITEMS) break

    // `<li><p># 标题</p></li>` 之类会同时命中父与子，只留外层那个。
    let parent = element.parentElement
    let nested = false
    while (parent !== null && parent !== doc.body) {
      if (pickedElements.has(parent)) {
        nested = true
        break
      }
      parent = parent.parentElement
    }
    if (nested) continue

    const raw = tidy(element.textContent ?? '')
    const tagLevel = HTML_HEADING_TAGS[element.tagName] ?? 0
    const markdown = tagLevel === 0 ? MARKDOWN_HEADING.exec(raw) : null
    const level = tagLevel > 0 ? tagLevel : markdown === null ? 0 : markdown[1].length
    const title = tagLevel > 0 ? raw : tidy(markdown?.[2] ?? '')
    if (level === 0 || title === '') continue

    picked.push({ element, level, title })
    pickedElements.add(element)
  }

  const depths = headingDepths(picked.map((entry) => entry.level))
  const items: DocumentOutlineItem[] = picked.map((entry, index) => {
    entry.element.setAttribute(OUTLINE_ANCHOR_ATTR, String(index))
    return { title: entry.title, depth: depths[index], target: anchorTarget(index) }
  })
  return { html: doc.body.innerHTML, items }
}

/**
 * 从纯文本里提 Markdown 标题。
 *
 * 用于 PDF 全文索引、`.md` 附件的全文文本这类「只有字符串」的兜底视图。跳转目标
 * 记的是**标题行在全文里的字符偏移**，渲染时不改正文 DOM（标注高亮按同样的偏移
 * 切分，插锚点会打乱它），跳的时候再按偏移找回文字节点。
 */
export function parseMarkdownHeadings(text: string): DocumentOutlineItem[] {
  const levels: number[] = []
  const titles: string[] = []
  const offsets: number[] = []
  let offset = 0
  let fenced = false

  for (const line of text.split('\n')) {
    // 代码块里的 `#` 不是标题。
    if (/^\s*(?:```|~~~)/u.test(line)) {
      fenced = !fenced
    } else if (!fenced && levels.length < OUTLINE_MAX_ITEMS) {
      const match = MARKDOWN_LINE.exec(line)
      if (match !== null) {
        const title = tidy(match[2])
        if (title !== '') {
          levels.push(match[1].length)
          titles.push(title)
          offsets.push(offset)
        }
      }
    }
    offset += line.length + 1
  }

  const depths = headingDepths(levels)
  return titles.map((title, index) => ({
    title,
    depth: depths[index],
    target: anchorTarget(offsets[index]),
  }))
}
