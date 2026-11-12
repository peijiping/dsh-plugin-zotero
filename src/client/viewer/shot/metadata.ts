/**
 * 由「当前文献 + 采集帧 + 选区」反查四项出处信息，纯函数、不碰 DOM 与宿主。
 *
 * 四项：文献身份（零额外请求）、PDF 起止页码、最近章节标题、选区文字摘要。
 * 结果写进 `ShotMeta`，再派生水印条 / chip label / 提交给模型的完整文本。
 */

import type { ZoteroItemDetail } from '../../../zotero/types'
import { tidyAnnotation } from '../../compose'
import type { DocumentOutlineItem, DocumentSource } from '../types'
import { SHOT_DIGEST_CHARS, SHOT_PART_LIMITS, type CaptureFrame, type ClientRect, type ShotMeta } from './types'

/** 按编码后的字节预算裁一段（中文经 encodeURIComponent 会膨胀约 9 倍）。 */
export function clipForRef(text: string, limit: number): string {
  const chars = Array.from(text)
  let used = 0
  const kept: string[] = []
  for (const char of chars) {
    const cost = encodeURIComponent(char).length
    if (used + cost > limit) break
    used += cost
    kept.push(char)
  }
  return kept.join('')
}

function intersects(a: ClientRect, b: ClientRect): boolean {
  return a.left < b.left + b.width
    && a.left + a.width > b.left
    && a.top < b.top + b.height
    && a.top + a.height > b.top
}

/** 选区里命中的文本，按阅读顺序（采集帧已排好序）拼成一行。 */
function regionDigest(frame: CaptureFrame, rect: ClientRect): string {
  const parts: string[] = []
  for (const box of frame.boxes) {
    if (!intersects(box.rect, rect)) continue
    const text = box.text.trim()
    if (text !== '') parts.push(text)
    if (parts.join(' ').length > SHOT_DIGEST_CHARS * 2) break
  }
  const cleaned = tidyAnnotation(parts.join(' ')).replace(/\s+/gu, ' ')
  const chars = Array.from(cleaned)
  return chars.length > SHOT_DIGEST_CHARS
    ? `${chars.slice(0, SHOT_DIGEST_CHARS).join('')}…`
    : cleaned
}

/** PDF 起止页码：印刷标签优先，无标签时退回页号。 */
function pageRange(frame: CaptureFrame, rect: ClientRect): string {
  const hits = frame.pages
    .filter((page) => intersects(page.rect, rect))
    .sort((a, b) => a.pageNumber - b.pageNumber)
  if (hits.length === 0) return ''
  const first = hits[0]
  const last = hits[hits.length - 1]
  if (first === undefined || last === undefined) return ''
  const label = (value: typeof first): string => value.label.trim() || String(value.pageNumber)
  return first.pageNumber === last.pageNumber
    ? label(first)
    : `${label(first)}-${label(last)}`
}

/** 最近章节：PDF 按书签页号（不晚于起始页的最后一条），其它按标题元素的纵向位置。 */
function nearestSection(
  frame: CaptureFrame,
  rect: ClientRect,
  outline: readonly DocumentOutlineItem[] | null,
): string {
  const startPage = frame.pages
    .filter((page) => intersects(page.rect, rect))
    .sort((a, b) => a.pageNumber - b.pageNumber)[0]?.pageNumber
  if (startPage !== undefined) {
    let best = ''
    for (const item of outline ?? []) {
      if (item.target?.kind !== 'page') continue
      if (item.target.page <= startPage) best = item.title.trim()
      else break
    }
    if (best !== '') return best
  }
  let best: { title: string; top: number } | null = null
  for (const heading of frame.headings) {
    if (heading.rect.top > rect.top + rect.height) continue
    if (best === null || heading.rect.top >= best.top) best = { title: heading.title, top: heading.rect.top }
  }
  return best?.title.trim() ?? ''
}

export interface BuildShotMetaInput {
  detail: ZoteroItemDetail
  source: DocumentSource | null
  outline: readonly DocumentOutlineItem[] | null
  frame: CaptureFrame
  rect: ClientRect
}

/**
 * Zotero 给附件起的默认名，当出处说明的补充没有信息量。
 *
 * 只有「原文 / 译本」这类真名字才值得带上，否则「Full Text PDF」会让模型
 * 以为那是文献类型。
 */
const GENERIC_ATTACHMENT_TITLES = new Set([
  'full text pdf',
  'full text',
  '全文 pdf',
  '全文',
  'snapshot',
  '网页快照',
  'preprint pdf',
  'submitted version',
  'accepted version',
])

function attachmentLabel(source: DocumentSource | null, detail: ZoteroItemDetail): string {
  const title = source?.title.trim() ?? ''
  if (title === '' || title === detail.title) return ''
  return GENERIC_ATTACHMENT_TITLES.has(title.toLowerCase()) ? '' : title
}

export function buildShotMeta({ detail, source, outline, frame, rect }: BuildShotMetaInput): ShotMeta {
  const byline = [
    detail.creators.join('、'),
    detail.year,
    detail.publicationTitle,
    detail.doi !== '' ? `DOI ${detail.doi}` : '',
    attachmentLabel(source, detail),
  ].filter((part) => part !== '').join(' · ')

  return {
    key: detail.key,
    title: clipForRef(detail.title, SHOT_PART_LIMITS.title),
    byline: clipForRef(byline, SHOT_PART_LIMITS.byline),
    pages: clipForRef(pageRange(frame, rect), SHOT_PART_LIMITS.pages),
    section: clipForRef(nearestSection(frame, rect, outline), SHOT_PART_LIMITS.section),
    digest: clipForRef(regionDigest(frame, rect), SHOT_PART_LIMITS.digest),
    shotId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
  }
}
