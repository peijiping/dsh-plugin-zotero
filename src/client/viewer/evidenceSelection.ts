import { normalizeEvidenceChar, normalizeEvidenceText } from './reviewLocation'

function selectRange(root: HTMLElement, range: Range): boolean {
  const selection = root.ownerDocument.getSelection()
  if (selection === null) return false
  selection.removeAllRanges()
  selection.addRange(range)
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  return true
}

export function offsetsWithin(root: HTMLElement, range: Range): { start: number; end: number } | undefined {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined
  const prefix = root.ownerDocument.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  prefix.setEnd(range.endContainer, range.endOffset)
  const end = prefix.toString().length
  return start < end ? { start, end } : undefined
}

export function revealOffsets(root: HTMLElement, offsets: { start: number; end: number }, quote: string): boolean {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = root.ownerDocument.createRange()
  let consumed = 0
  let started = false
  let node = walker.nextNode() as Text | null
  while (node !== null) {
    const limit = consumed + node.length
    if (!started && offsets.start < limit) {
      range.setStart(node, offsets.start - consumed)
      started = true
    }
    if (started && offsets.end <= limit) {
      range.setEnd(node, offsets.end - consumed)
      return range.toString().trimStart().startsWith(quote) && selectRange(root, range)
    }
    consumed = limit
    node = walker.nextNode() as Text | null
  }
  return false
}

/** Restore a unique text fragment and leave it selected in the reader. */
export function revealQuote(
  root: HTMLElement,
  quote: string,
  separateNodes = false,
  normalize = false,
): boolean {
  const needle = normalize ? normalizeEvidenceText(quote) : quote.replace(/\s+/gu, ' ').trim()
  if (needle === '') return false
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const offsets: { node: Text; offset: number; end: number }[] = []
  let text = ''
  let node = walker.nextNode() as Text | null
  while (node !== null) {
    const value = node.data
    if (separateNodes && text !== '' && !text.endsWith(' ') && value !== '') {
      offsets.push({ node, offset: 0, end: 1 })
      text += ' '
    }
    let offset = 0
    for (const point of value) {
      const char = normalize ? normalizeEvidenceChar(point) : /\s/u.test(point) ? ' ' : point
      const end = offset + point.length
      if (char !== ' ' || !text.endsWith(' ')) {
        text += char
        for (let index = 0; index < char.length; index += 1) offsets.push({ node, offset, end })
      }
      offset = end
    }
    node = walker.nextNode() as Text | null
  }
  const start = text.indexOf(needle)
  if (start < 0 || text.indexOf(needle, start + 1) >= 0) return false
  const from = offsets[start]
  const to = offsets[start + needle.length - 1]
  if (from === undefined || to === undefined) return false
  const range = root.ownerDocument.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.end)
  return selectRange(root, range)
}
