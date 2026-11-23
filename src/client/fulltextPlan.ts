/** 按目录标题在索引正文中定位，保留不相邻的选区。 */

import type { DocumentOutlineItem, OutlineTarget } from './viewer/types'
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
  depth: number
}

export interface ChapterPlan {
  range: string
  scope: string
  chars: number
  estimated: boolean
  fallbackAll: boolean
  target?: OutlineTarget
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
function indexHeadings(content: string, titles: ReadonlyMap<string, number>): {
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
      lines.push({ start: offset, end: offset + line.length, markdown, depth: titles.get(tidy) ?? 0 })
      const bucket = lineIndex.get(tidy)
      if (bucket === undefined) lineIndex.set(tidy, [offset])
      else bucket.push(offset)
    }
    offset += line.length + 1
  }

  // 紧邻的同级导航标题应排除。父标题直接跟子标题属于正文结构，必须保留。
  // Markdown `#` 标题只可能来自正文，不参与判定。
  const navStarts = new Set<number>()
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i] as HeadingLine
    if (current.markdown) continue
    const prev = lines[i - 1]
    const next = lines[i + 1]
    const touchesPrev = prev !== undefined && prev.depth >= current.depth && !prev.markdown && current.start - prev.end <= NAV_HEADING_GAP
    const touchesNext = next !== undefined && next.depth <= current.depth && !next.markdown && next.start - current.end <= NAV_HEADING_GAP
    if (touchesPrev || touchesNext) navStarts.add(current.start)
  }
  return { lineIndex, navStarts }
}

/**
 * 计算选中章节的范围表达式。
 *
 * 用标题逐行定位而不是 outline 的 target.id：快照/笔记的 anchor id 是元素锚点序号、
 * 只有纯文本才是字符偏移，语义不统一；标题文本配 `fulltext.content` 才是同一个
 * 字符空间。必须确认每组章节的边界，页码不能区分同一页里的多个章节。
 */
export function planChapters(
  content: string,
  items: DocumentOutlineItem[],
  selected: ReadonlySet<number>,
  t: Translate,
): ChapterPlan | null {
  const indices = sortedIndices(selected).filter((i) => i < items.length)
  if (indices.length === 0) return null

  const known = new Map(items.map((item) => [tidyHeading(item.title), item.depth]))
  const { lineIndex, navStarts } = indexHeadings(content, known)
  const counts = new Map<string, number>()
  for (const item of items) {
    const title = tidyHeading(item.title)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const matches = new Map<string, number[]>()
  for (const [title, positions] of lineIndex) {
    const bodyPositions = positions.filter((position) => !navStarts.has(position))
    if (bodyPositions.length === counts.get(title)) matches.set(title, bodyPositions)
  }

  const titles = indices.map((i) => items[i]?.title ?? '')
  const label = titles.join(' · ')
  let previous = -1
  const offsets = items.map((item) => {
    const offset = matches.get(tidyHeading(item.title))?.shift()
    if (offset === undefined || offset <= previous) return null
    previous = offset
    return offset
  })
  const groups: { first: number; last: number }[] = []
  for (const index of indices) {
    // A parent chapter includes its descendants. Merge overlapping selections so
    // selecting both a parent and a child never duplicates their text.
    let last = index
    while (last + 1 < items.length && items[last + 1].depth > items[index].depth) last += 1
    const group = groups.at(-1)
    if (group !== undefined && group.last + 1 >= index) group.last = Math.max(group.last, last)
    else groups.push({ first: index, last })
  }
  const segments = groups.map(({ first, last }) => ({
    start: offsets[first],
    end: last === items.length - 1 ? content.length : offsets[last + 1],
    located: offsets.slice(first, last + 1).every((offset) => offset !== null),
  }))
  if (segments.every(({ start, end, located }) => start !== null && end !== null && located)) {
    const [first] = segments
    const range = segments.length === 1
      ? `o:${first.start}:${first.end}`
      : `m:${segments.map(({ start, end }) => `${start}-${end}`).join(',')}`
    return {
      range,
      scope: tpl(t('fulltext.scope.chapters'), { value: label }),
      chars: segments.reduce((total, { start, end }) => total + (end ?? 0) - (start ?? 0), (segments.length - 1) * 2),
      estimated: false,
      fallbackAll: false,
      target: items[indices[0]]?.target ?? undefined,
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
