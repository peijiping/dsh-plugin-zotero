const MAX_PDF_PAGES = 100
const QUOTE_LENGTH = 44
const MIN_QUOTE_LENGTH = 18

/** Zotero and the PDF text layer often disagree about line breaks and CJK spacing. */
export function normalizeEvidenceChar(char: string): string {
  return char.normalize('NFKC').replace(/[\s\u00ad\u200b-\u200d\ufeff]/gu, '')
}

export function normalizeEvidenceText(text: string): string {
  return Array.from(text, normalizeEvidenceChar).join('')
}

export interface ReviewPdfLocation {
  page: number
  quote: string
}

/** An excerpt can cross a page or column. Locate a unique, contiguous part of it. */
export async function findReviewPdfLocation(
  excerpt: string,
  pageCount: number,
  readPage: (page: number) => Promise<string>,
  signal: AbortSignal,
): Promise<ReviewPdfLocation | null> {
  if (pageCount > MAX_PDF_PAGES) return null
  const normalized = normalizeEvidenceText(excerpt)
  const length = Math.min(QUOTE_LENGTH, normalized.length)
  if (length < MIN_QUOTE_LENGTH) return null
  const windows = Math.min(16, Math.ceil(normalized.length / (length * 0.65)))
  const quotes = new Map<string, { page: number; count: number }>()
  for (let index = 0; index < windows; index += 1) {
    const start = Math.round(index * (normalized.length - length) / Math.max(1, windows - 1))
    quotes.set(normalized.slice(start, start + length), { page: 0, count: 0 })
  }
  for (let page = 1; page <= pageCount; page += 1) {
    signal.throwIfAborted()
    const text = await readPage(page)
    for (const [quote, match] of quotes) {
      if (match.count > 1) continue
      const index = text.indexOf(quote)
      if (index < 0) continue
      match.page = page
      match.count += text.indexOf(quote, index + 1) < 0 ? 1 : 2
    }
  }
  signal.throwIfAborted()
  const unique = [...quotes].filter(([, match]) => match.count === 1)
  if (unique.length === 0) return null
  const [quote, match] = unique[Math.floor(unique.length / 2)]
  return { page: match.page, quote }
}
