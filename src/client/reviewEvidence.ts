import {
  isReviewEvidenceId,
  isReviewEvidenceRun,
  REVIEW_FRAGMENT_MAX,
} from '../zotero/review-evidence-types'
import { fetchReviewEvidence } from './api'
import { EVIDENCE_LINK_PREFIX, makeEvidence, type EvidenceTarget } from './evidence'
import { parseFulltextRange } from './fulltextRange'

export const REVIEW_EVIDENCE_PREFIX = `${EVIDENCE_LINK_PREFIX}r/`
const MARKDOWN = /^\[(Z[1-9]\d{0,5}\.[1-9]\d{0,5})\]\((https:\/\/zotero-evidence\.invalid\/r\/[^)]+)\)$/u
const MIN_FRAGMENT = 280

export interface ReviewEvidenceRef {
  run: string
  id: string
}

export function createReviewRun(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function reviewEvidenceHref(ref: ReviewEvidenceRef): string {
  return `${REVIEW_EVIDENCE_PREFIX}${ref.run}/${ref.id}`
}

export function parseReviewEvidenceHref(href: string): ReviewEvidenceRef | null {
  if (!href.startsWith(REVIEW_EVIDENCE_PREFIX)) return null
  const [run, id, rest] = href.slice(REVIEW_EVIDENCE_PREFIX.length).split('/')
  return isReviewEvidenceRun(run) && isReviewEvidenceId(id) && rest === undefined ? { run, id } : null
}

/** Split only selected text. Prefer headings, table captions and paragraph or sentence boundaries. */
export function reviewFragments(content: string, range: string): { start: number; end: number; excerpt: string }[] {
  const selected = parseFulltextRange(range)
  let ranges: [number, number][]
  switch (selected.mode) {
    case 'all': ranges = [[0, content.length]]; break
    case 'chars':
    case 'offsets': ranges = [[selected.start, selected.end]]; break
    case 'segments': ranges = selected.offsets; break
    default: throw new Error('Invalid review selection')
  }
  const result: { start: number; end: number; excerpt: string }[] = []
  for (const [start, end] of ranges) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > content.length || end < start) {
      throw new Error('Invalid review selection')
    }
    const text = content.slice(start, end)
    const breaks = [...text.matchAll(/(?:^|\n)[ \t]*(?=#{1,6}[ \t]|(?:表\s*\d+|Table\s+\d+)\b)/gimu)]
      .map((match) => match.index + match[0].length)
      .filter((offset) => offset > 0)
    breaks.push(text.length)
    let cursor = 0
    for (const boundary of breaks) {
      if (boundary < cursor) continue
      while (cursor < boundary) {
        const limit = Math.min(boundary, cursor + REVIEW_FRAGMENT_MAX)
        const tail = text.slice(cursor + MIN_FRAGMENT, limit)
        const separators = [...tail.matchAll(/\n\s*\n|[。！？；]|[.!?;](?=\s)|\n/gu)]
        const last = separators.at(-1)
        const stop = limit === boundary || last === undefined
          ? limit : cursor + MIN_FRAGMENT + last.index + last[0].length
        // Never split a UTF-16 surrogate pair.
        const next = /[\uDC00-\uDFFF]/u.test(text.charAt(stop)) ? stop - 1 : stop
        const excerpt = text.slice(cursor, next)
        if (excerpt.trim() !== '') result.push({ start: start + cursor, end: start + next, excerpt })
        cursor = next
      }
    }
  }
  return result
}

export async function loadReviewEvidence(ref: ReviewEvidenceRef): Promise<EvidenceTarget | null> {
  const record = await fetchReviewEvidence(ref.run, ref.id)
  if (record === null) return null
  const { key, attachmentKey, ...review } = record
  return { ...makeEvidence(key, { attachmentKey }), review }
}

export function reviewEvidenceGroups(text: string): { title: string; links: ReviewEvidenceRef[] }[] {
  const groups: { title: string; links: ReviewEvidenceRef[] }[] = []
  let title = ''
  let group: (typeof groups)[number] | undefined
  for (const line of text.split('\n')) {
    const heading = /^(?:文献 |Paper )(.+?)(?:｜| \| )Zotero [A-Z2-9]{8}$/u.exec(line)
    if (heading !== null) {
      title = heading[1]
      group = undefined
    }
    const match = MARKDOWN.exec(line)
    const ref = match === null ? null : parseReviewEvidenceHref(match[2])
    if (ref === null || ref.id !== match?.[1] || title === '') continue
    if (group === undefined) {
      group = { title, links: [] }
      groups.push(group)
    }
    group.links.push(ref)
  }
  return groups
}

export function displayReviewEvidence(text: string): string {
  return text.split('\n').map((line) => MARKDOWN.exec(line)?.[1] ?? line).join('\n')
}
