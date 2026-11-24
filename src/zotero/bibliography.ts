export const BIBLIOGRAPHY_STYLES = [
  { id: 'apa', label: 'APA 7' },
  { id: 'china-national-standard-gb-t-7714-2025-numeric', label: 'GB/T 7714-2025' },
] as const

export type BibliographyStyle = (typeof BIBLIOGRAPHY_STYLES)[number]['id']

export function isBibliographyStyle(value: string | null): value is BibliographyStyle {
  return BIBLIOGRAPHY_STYLES.some(({ id }) => id === value)
}

export function isBibliographicItem(type: string | undefined): boolean {
  return Boolean(type) && type !== 'attachment' && type !== 'note' && type !== 'annotation'
}

/** Keep the complete selection within a single Zotero request. */
export const MAX_BIBLIOGRAPHY_ITEMS = 50

export interface ZoteroBibliography {
  html: string
  count: number
  skippedKeys: string[]
}
