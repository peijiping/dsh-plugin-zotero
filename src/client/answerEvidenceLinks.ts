import { DIGEST_EVIDENCE_ID, EVIDENCE_LINK_PREFIX, evidenceFromHref } from './evidence'
import { reviewEvidenceHref } from './reviewEvidence'

export const REVIEW_CITATION_DATA = 'data-dsh-zp-review-citations'
export const DIGEST_CITATION_DATA = 'data-dsh-zp-digest-citations'
export type DigestCitation = [id: string, href: string, label: string, paperKey: string]

const FLOW = '[data-chat-flow]'
const ROW = '[data-chat-flow-kind][data-chat-turn]'
const ANSWER = '[data-chat-flow-kind="assistant-step"] [data-text-interaction-source]'
const LEGACY_DIGEST_ID = 'E-[0-9a-f]{12}|N-[A-Z2-9]{8}'
const LEGACY_DIGEST_LABEL = new RegExp(String.raw`^\[?(${LEGACY_DIGEST_ID})\]?$`, 'u')
const CITATION = new RegExp(String.raw`\[(Z[1-9]\d{0,5}\.[1-9]\d{0,5}|${DIGEST_EVIDENCE_ID}|${LEGACY_DIGEST_ID})\]`, 'gu')

function digestCitations(marker: Element): DigestCitation[] {
  try {
    const data: unknown = JSON.parse(marker.getAttribute(DIGEST_CITATION_DATA) ?? '')
    return Array.isArray(data) ? data.filter((entry): entry is DigestCitation =>
      Array.isArray(entry) && entry.length === 4 && typeof entry[0] === 'string'
      && typeof entry[1] === 'string' && entry[1].startsWith(EVIDENCE_LINK_PREFIX)
      && typeof entry[2] === 'string' && typeof entry[3] === 'string') : []
  } catch {
    return []
  }
}

function digestLinks(citations: DigestCitation[]) {
  const links = new Map<string, { href: string; label: string; display: string } | null>()
  const reserved = new Set(citations.map(([id]) => id))
  const papers = new Map<string, { number: number; count: number }>()
  for (const [id, href, label, paperKey] of citations) {
    const existing = links.get(id)
    if (existing !== undefined) {
      if (existing?.href !== href) links.set(id, null)
      continue
    }
    let paper = papers.get(paperKey)
    if (paper === undefined) {
      paper = { number: papers.size + 1, count: 0 }
      papers.set(paperKey, paper)
    }
    let display = id
    if (LEGACY_DIGEST_LABEL.test(id)) {
      do {
        display = `E${paper.number}.${++paper.count}`
      } while (reserved.has(display))
    }
    links.set(id, { href, label, display })
  }
  return links
}

/** DSH exposes the settled text surface, but has no Markdown transform for assistant text. */
export function linkEvidenceAnswers(): () => void {
  const linked = new WeakSet<Element>()
  let frame: number | undefined

  function update(): void {
    frame = undefined
    for (const flow of document.querySelectorAll(FLOW)) {
      for (const answer of flow.querySelectorAll(ANSWER)) {
        if (linked.has(answer)) continue
        const row = answer.closest(ROW)
        if (row === null) continue
        const turn = row.getAttribute('data-chat-turn')
        const refs = new Map<string, string | null>()
        const runs = new Set<string>()
        const digest = digestLinks([...flow.querySelectorAll(`[${DIGEST_CITATION_DATA}]`)]
          .filter((marker) => marker.closest(ROW)?.getAttribute('data-chat-turn') === turn)
          .flatMap(digestCitations))
        for (const marker of flow.querySelectorAll<HTMLElement>(`[${REVIEW_CITATION_DATA}]`)) {
          if (marker.closest(ROW)?.getAttribute('data-chat-turn') !== turn) continue
          const [run, ...ids] = (marker.getAttribute(REVIEW_CITATION_DATA) ?? '').split(' ')
          runs.add(run)
          for (const id of ids) {
            const other = refs.get(id)
            refs.set(id, other === undefined || other === run ? run : null)
          }
        }
        if (runs.size === 0 && digest.size === 0) continue
        linked.add(answer)
        const fallback = runs.size === 1 ? runs.values().next().value : undefined
        for (const anchor of answer.querySelectorAll<HTMLAnchorElement>('a[href]')) {
          const text = anchor.firstChild
          if (!(text instanceof Text) || text !== anchor.lastChild) continue
          const id = LEGACY_DIGEST_LABEL.exec(text.data)?.[1]
          const source = id === undefined ? undefined : digest.get(id)
          if (!source || evidenceFromHref(anchor.href)?.id !== id) continue
          anchor.href = source.href
          anchor.title = source.label
          anchor.classList.add('dsh-zp-answer-citation')
          text.data = `[${source.display}]`
        }
        const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        let node = walker.nextNode() as Text | null
        while (node !== null) {
          const parent = node.parentElement
          if (!parent?.closest('a, pre, button') && (!parent?.closest('code') || /^\[[^\]]+\]$/u.test(node.data))) {
            nodes.push(node)
          }
          node = walker.nextNode() as Text | null
        }
        for (const text of nodes) {
          const fragment = document.createDocumentFragment()
          let end = 0
          for (const match of text.data.matchAll(CITATION)) {
            const id = match[1]
            const source = digest.get(id)
            const run = id.startsWith('Z') ? (refs.has(id) ? refs.get(id) : fallback) : undefined
            const href = source?.href ?? (run ? reviewEvidenceHref({ run, id }) : undefined)
            if (href === undefined) continue
            fragment.append(text.data.slice(end, match.index))
            const anchor = document.createElement('a')
            anchor.href = href
            if (source) {
              anchor.className = 'dsh-zp-answer-citation'
              anchor.title = source.label
            }
            anchor.textContent = source ? `[${source.display}]` : match[0]
            fragment.append(anchor)
            end = match.index + match[0].length
          }
          if (end > 0) {
            // Keep React's original text node in place. Only decorate settled Markdown.
            text.before(fragment)
            text.data = text.data.slice(end)
          }
        }
      }
    }
  }

  function schedule(): void {
    if (frame === undefined) frame = requestAnimationFrame(update)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-text-interaction-source', REVIEW_CITATION_DATA, DIGEST_CITATION_DATA],
  })
  schedule()
  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
