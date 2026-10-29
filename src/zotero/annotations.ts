/**
 * 把标注原文锚定到全文纯文本上。
 *
 * PDF 抽取的全文会在汉字之间插空格，`annotationText` 原串因此通常直接搜不到。
 * 这里做「去空白 + 全角 ASCII 转半角」的 1:1 折叠，再在折叠串上查找，
 * 通过 map 把折叠下标还原成原文下标。
 */

import type { ZoteroFulltext } from './types.js'

/** Host 侧归一化后的标注（已过滤为非高亮/划线之外的条目）。 */
export interface RawAnnotation {
  key: string
  attachmentKey: string
  type: string
  text: string
  comment: string
  color: string
  pageLabel: string
  /** 零填充的 `annotationSortIndex`，可按字典序比较。 */
  sortIndex: string
}

/** 原文中的一个字符在折叠串里的位置映射。 */
interface Folded {
  text: string
  /** 折叠下标 → 原文下标。 */
  map: Int32Array
}

/** 空白与软连字符：PDF 抽取会插入，匹配时忽略。 */
const IGNORED = /[\s\u00ad]/u

/** 单条标注最多收集多少个候选位置（防止单字标注把内存打满）。 */
const MAX_HITS = 2000

/** 折叠：去空白，全角 ASCII 转半角；保持一个字符对回一个原文下标。 */
function fold(source: string): Folded {
  const map = new Int32Array(source.length)
  let text = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string
    if (IGNORED.test(char)) continue
    const code = char.charCodeAt(0)
    map[text.length] = index
    text += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : char
  }
  return { text, map: map.subarray(0, text.length) }
}

/** 在折叠串里找出全部候选位置。 */
function findHits(haystack: string, needle: string): number[] {
  const hits: number[] = []
  if (needle === '') return hits
  let at = haystack.indexOf(needle)
  while (at !== -1 && hits.length < MAX_HITS) {
    hits.push(at)
    at = haystack.indexOf(needle, at + 1)
  }
  return hits
}

/**
 * 在多候选中挑一个：只接受唯一结果。
 *
 * `prevEnd` 是上一条已锚定标注的原文结束位置——同一篇 PDF 里标注按阅读顺序
 * 排列，落在它之前的候选直接排除；排除后仍不唯一就放弃（宁可置灰也不跳错位置）。
 */
function pick(hits: number[], map: Int32Array, prevEnd: number): number | null {
  if (hits.length === 0) return null
  if (hits.length === 1) return hits[0] as number
  let chosen: number | null = null
  for (const hit of hits) {
    if ((map[hit] as number) < prevEnd) continue
    if (chosen !== null) return null
    chosen = hit
  }
  return chosen
}

/**
 * 为每条标注计算它在 `fulltext.content` 里的区间。
 *
 * 传入顺序即展示顺序（按附件、再按 `annotationSortIndex`），锚定依赖这个顺序。
 */
export function anchorAnnotations(
  annotations: RawAnnotation[],
  fulltext: ZoteroFulltext | null,
): (RawAnnotation & { range: { start: number; end: number } | null })[] {
  const folded = fulltext === null ? null : fold(fulltext.content)
  const attachmentKey = fulltext?.attachmentKey ?? ''
  let prevEnd = 0

  return annotations.map((annotation) => {
    if (folded === null || annotation.attachmentKey !== attachmentKey || annotation.text === '') {
      return { ...annotation, range: null }
    }
    const query = fold(annotation.text).text
    const hit = pick(findHits(folded.text, query), folded.map, prevEnd)
    if (hit === null) return { ...annotation, range: null }
    const start = folded.map[hit] as number
    const end = (folded.map[hit + query.length - 1] as number) + 1
    prevEnd = end
    return { ...annotation, range: { start, end } }
  })
}
