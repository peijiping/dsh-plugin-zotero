import { reviewEvidenceHref } from './reviewEvidence'

export const REVIEW_CITATION_DATA = 'data-dsh-zp-review-citations'
const FLOW = '[data-chat-flow]'
const ROW = '[data-chat-flow-kind][data-chat-turn]'
const ANSWER = '[data-chat-flow-kind="assistant-step"] [data-text-interaction-source]'
const CITATION = /\[(Z[1-9]\d{0,5}\.[1-9]\d{0,5})\]/gu

/** DSH exposes the settled text surface, but has no Markdown transform for assistant text. */
export function linkReviewAnswers(): () => void {
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
        for (const marker of flow.querySelectorAll<HTMLElement>(`[${REVIEW_CITATION_DATA}]`)) {
          if (marker.closest(ROW)?.getAttribute('data-chat-turn') !== turn) continue
          const [run, ...ids] = (marker.getAttribute(REVIEW_CITATION_DATA) ?? '').split(' ')
          runs.add(run)
          for (const id of ids) {
            const other = refs.get(id)
            refs.set(id, other === undefined || other === run ? run : null)
          }
        }
        if (runs.size === 0) continue
        linked.add(answer)
        const fallback = runs.size === 1 ? runs.values().next().value : undefined
        const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        let node = walker.nextNode() as Text | null
        while (node !== null) {
          if (!node.parentElement?.closest('a, code, pre, button')) nodes.push(node)
          node = walker.nextNode() as Text | null
        }
        for (const text of nodes) {
          const fragment = document.createDocumentFragment()
          let end = 0
          for (const match of text.data.matchAll(CITATION)) {
            const id = match[1]
            const run = refs.has(id) ? refs.get(id) : fallback
            if (!run) continue
            fragment.append(text.data.slice(end, match.index))
            const anchor = document.createElement('a')
            anchor.href = reviewEvidenceHref({ run, id })
            anchor.textContent = match[0]
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
    attributeFilter: ['data-text-interaction-source', REVIEW_CITATION_DATA],
  })
  schedule()
  return () => {
    observer.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
  }
}
