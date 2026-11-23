import type { Translate } from './locales'
import { tpl } from './locales'

export interface EvidenceLocation {
  attachmentKey?: string
  /** 1-based PDF file page number, independent of the printed label. */
  page?: number
  pageLabel?: string
  chapterStart?: boolean
  annotationKey?: string
  anchor?: string
  quote?: string
  pdfRange?: { start: number; end: number }
  snapshot?: { selector: string; start: number; end: number }
}

export interface EvidenceTarget extends EvidenceLocation {
  key: string
  id: string
}

export const EVIDENCE_LINK_PREFIX = 'https://zotero-evidence.invalid/'
const KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u
const ID = /^E-[0-9a-f]{12}$/u
const LINK = /\[(E-[0-9a-f]{12})\]\((https:\/\/zotero-evidence\.invalid\/[A-Za-z0-9_-]{1,2400})\)/gu

export function makeEvidence(key: string, location: EvidenceLocation = {}): EvidenceTarget {
  const random = crypto.getRandomValues(new Uint8Array(6))
  const id = `E-${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  const { snapshot, ...position } = location
  const target = { ...position, key, id }
  return snapshot && snapshot.selector.length > 0 && snapshot.selector.length <= 240
    ? { ...target, snapshot }
    : target
}

export function evidenceLink(target: EvidenceTarget): string {
  const bytes = new TextEncoder().encode(JSON.stringify(target))
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
  return `[${target.id}](${EVIDENCE_LINK_PREFIX}${encoded})`
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validRange(value: unknown): value is { start: number; end: number } {
  if (typeof value !== 'object' || value === null) return false
  const { start, end } = value as { start?: unknown; end?: unknown }
  return (start === 0 || positive(start)) && positive(end) && end > start
}

export function evidenceFromHref(href: string): EvidenceTarget | null {
  const encoded = href.slice(EVIDENCE_LINK_PREFIX.length)
  if (!href.startsWith(EVIDENCE_LINK_PREFIX) || !/^[A-Za-z0-9_-]{1,2400}$/u.test(encoded)) return null
  try {
    const decoded = atob(encoded.replace(/-/gu, '+').replace(/_/gu, '/'))
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, (char) => char.charCodeAt(0))))
    if (typeof value?.key !== 'string' || !KEY.test(value.key) || typeof value.id !== 'string' || !ID.test(value.id)) return null
    const target: EvidenceTarget = { key: value.key, id: value.id }
    if (typeof value.attachmentKey === 'string' && KEY.test(value.attachmentKey)) target.attachmentKey = value.attachmentKey
    if (typeof value.annotationKey === 'string' && KEY.test(value.annotationKey)) target.annotationKey = value.annotationKey
    if (positive(value.page)) target.page = value.page
    if (value.chapterStart === true) target.chapterStart = true
    if (typeof value.pageLabel === 'string') target.pageLabel = value.pageLabel.slice(0, 60)
    if (typeof value.anchor === 'string' && /^\d{1,10}$/u.test(value.anchor)) target.anchor = value.anchor
    if (typeof value.quote === 'string') target.quote = value.quote.slice(0, 240)
    if (validRange(value.pdfRange)) target.pdfRange = { start: value.pdfRange.start, end: value.pdfRange.end }
    const snapshot: { selector?: unknown } | undefined = value.snapshot
    if (typeof snapshot?.selector === 'string' && snapshot.selector.length <= 240 && validRange(snapshot)) {
      target.snapshot = { selector: snapshot.selector, start: snapshot.start, end: snapshot.end }
    }
    return target
  } catch {
    return null
  }
}

export function evidenceLine(t: Translate, target: EvidenceTarget): string {
  const link = evidenceLink(target)
  const label = target.pageLabel ?? target.page
  const page = label === undefined ? '' : tpl(t(target.chapterStart ? 'evidence.chapterPage' : 'evidence.page'), { page: label })
  return tpl(t('evidence.cite'), { link, page })
}

export function evidenceIn(text: string): EvidenceTarget[] {
  const targets = new Map<string, EvidenceTarget>()
  for (const match of text.matchAll(LINK)) {
    const target = evidenceFromHref(match[2])
    if (target?.id === match[1]) targets.set(target.id, target)
  }
  return [...targets.values()]
}

/** Display the evidence number while keeping the navigation controls in the history UI. */
export function evidenceDisplayText(text: string): string {
  return text.replace(LINK, '[$1]')
}
