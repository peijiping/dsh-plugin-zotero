/**
 * 「按章节」范围 → 范围表达式的规划。
 *
 * 从 `fulltextScope.tsx` 里抽出来的纯函数：不碰 React，就能按 PDF / 网页快照 /
 * Markdown / 纯文本四种输入逐个验（`local/fulltext-scenarios.mts`）。
 *
 * 定位策略：选中章节后用**章节标题**在 `detail.fulltext.content` 里逐行定位，
 * 起点是首个选中标题、终点是紧随其后的下一章节标题，于是产出精确的
 * `o:start:end` 字符区间。定位不到时：PDF（page target）退到 `p:` 让 codec
 * 按页码估算，其他文档退到整篇并标注——都不静默给错位切片。
 *
 * 网页快照的侧栏 / 文内目录会在抽取文本里把标题再列一遍，而且列的往往是别的
 * 页面的标题（`基础使用`、`创建参考文献`…）。这些行一行挨一行，正文标题之间
 * 却隔着大段正文——据此把「紧跟着另一条标题」的行判为导航，不拿它当章节起点，
 * 否则会切出十几个字的导航残片（见 `local/fulltext-scenarios.ts` [3d]）。
 */

import type { DocumentOutlineItem } from './viewer/types'
import { tidyHeading } from './fulltextRange'
import type { Translate } from './locales'
import { tpl } from './locales'

/** 两条标题行之间只隔换行 / 空行（≤ 2 个字符）时，前一条算导航区。 */
const NAV_HEADING_GAP = 2

/** 标题行在正文里的字符区间。 */
interface HeadingLine {
  start: number
  end: number
  /** Markdown `#` 标题：只可能是正文（导航链接不会带 `#`），不参与导航判定。 */
  markdown: boolean
}

export interface ChapterPlan {
  range: string
  scope: string
  chars: number
  estimated: boolean
  /**
   * 退成了整篇（标题在正文里一个都定位不到）。
   *
   * 与 `estimated` 分开：PDF 的 `p:` 是「按页码估算」，内容仍是选中那几节；
   * 这个标记是「你要的章节没找到，给的其实是全文」，浮层必须明说。
   */
  fallbackAll: boolean
}

/** 章节下标按 outline 顺序排序去重。 */
function sortedIndices(selected: ReadonlySet<number>): number[] {
  return [...selected].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
}

/**
 * 正文里可当章节起点的标题行 → 首次出现的偏移。
 *
 * 一次扫描建好两张表：`lines` 是所有「整行等于某条目录标题」的行（按出现顺序），
 * `lineIndex` 是标题 → 全部出现位置。之后每个标题的定位都是查表，不再重复扫正文。
 */
function indexHeadings(content: string, titles: ReadonlySet<string>): {
  lineIndex: Map<string, number[]>
  navStarts: Set<number>
} {
  const lineIndex = new Map<string, number[]>()
  const lines: HeadingLine[] = []
  let offset = 0
  for (const line of content.split('\n')) {
    const tidy = tidyHeading(line)
    if (tidy !== '' && titles.has(tidy)) {
      const markdown = /^[ \t]{0,3}#{1,6}[ \t]/u.test(line)
      lines.push({ start: offset, end: offset + line.length, markdown })
      const bucket = lineIndex.get(tidy)
      if (bucket === undefined) lineIndex.set(tidy, [offset])
      else bucket.push(offset)
    }
    offset += line.length + 1
  }

  // 前后任一侧紧挨着另一条（非 Markdown）标题就算导航：侧栏最后一条往往直接接
  // 正文首标题，只看「后面」会漏掉它。误伤正文首标题时最多退整篇并明示，
  // 不会插入错位切片。Markdown `#` 标题只可能来自正文，不参与判定。
  const navStarts = new Set<number>()
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i] as HeadingLine
    if (current.markdown) continue
    const prev = lines[i - 1]
    const next = lines[i + 1]
    const touchesPrev = prev !== undefined && !prev.markdown && current.start - prev.end <= NAV_HEADING_GAP
    const touchesNext = next !== undefined && !next.markdown && next.start - current.end <= NAV_HEADING_GAP
    if (touchesPrev || touchesNext) navStarts.add(current.start)
  }
  return { lineIndex, navStarts }
}

/**
 * 计算选中章节的范围表达式。
 *
 * 用标题逐行定位而不是 outline 的 target.id：快照/笔记的 anchor id 是元素锚点序号、
 * 只有纯文本才是字符偏移，语义不统一；标题文本配 `fulltext.content` 才是同一个
 * 字符空间。定位成功给精确 `o:`，PDF 定位失败给 `p:`（codec 按页估算），其余失败
 * 退整篇。
 */
export function planChapters(
  content: string,
  items: DocumentOutlineItem[],
  selected: ReadonlySet<number>,
  isPdf: boolean,
  t: Translate,
): ChapterPlan | null {
  const indices = sortedIndices(selected).filter((i) => i < items.length)
  if (indices.length === 0) return null

  const known = new Set(items.map((item) => tidyHeading(item.title)).filter((title) => title !== ''))
  const { lineIndex, navStarts } = indexHeadings(content, known)
  /** 只认不在导航区的出现位置；导航里列着的标题（别的页面）视为未定位。 */
  const locate = (title: string, after = -1): number | null => {
    const target = tidyHeading(title)
    if (target === '') return null
    for (const start of lineIndex.get(target) ?? []) {
      if (start > after && !navStarts.has(start)) return start
    }
    return null
  }

  const titles = indices.map((i) => items[i]?.title ?? '')
  const firstOffset = locate(titles[0] ?? '')
  const label = titles.join(' · ')

  // 页码（PDF）用于 scope 标注；非 PDF 的 target 没有页码就不写。
  const pages = isPdf
    ? indices.map((i) => {
        const target = items[i]?.target
        return target?.kind === 'page' ? target.page : null
      }).filter((page): page is number => page !== null)
    : []
  const pageTag = pages.length > 0
    ? `（P${Math.min(...pages)}–P${Math.max(...pages)}）`
    : ''

  if (firstOffset !== null) {
    const lastIndex = indices[indices.length - 1] ?? 0
    // 终点：选中最后一项之后的第一个「能定位到」的章节标题；再没有就到全文末尾。
    let end = content.length
    for (let i = lastIndex + 1; i < items.length; i += 1) {
      const next = locate(items[i]?.title ?? '', firstOffset)
      if (next !== null) { end = next; break }
    }
    if (end <= firstOffset) end = content.length
    return {
      range: `o:${firstOffset}:${end}`,
      scope: tpl(t('fulltext.scope.chapters'), { value: `${label}${pageTag}` }),
      chars: end - firstOffset,
      estimated: false,
      fallbackAll: false,
    }
  }

  if (isPdf) {
    const startPage = pages[0] ?? 1
    const endPage = pages[pages.length - 1] ?? startPage
    // 总页用 outline 里最大的页码近似——书签通常覆盖到接近文末，够作比例分母。
    const total = items.reduce((max, item) => {
      const target = item.target
      return target?.kind === 'page' && target.page > max ? target.page : max
    }, endPage)
    const encoded = titles.map((title) => encodeURIComponent(title)).join('+')
    return {
      range: `p:${startPage}:${endPage}:${total}:${encoded}`,
      scope: tpl(t('fulltext.scope.chapters'), { value: `${label}${pageTag}` }),
      chars: Math.round(content.length * (endPage - startPage + 1) / Math.max(1, total)),
      estimated: true,
      fallbackAll: false,
    }
  }

  return {
    range: 'all',
    scope: tpl(t('fulltext.scope.headingFallback'), { value: label }),
    chars: content.length,
    estimated: true,
    fallbackAll: true,
  }
}
