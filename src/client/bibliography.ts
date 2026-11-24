import { BIBLIOGRAPHY_STYLES, type BibliographyStyle } from '../zotero/bibliography'
import type { Translate } from './locales'

export function bibliographyStyles(t: Translate): { id: BibliographyStyle; label: string }[] {
  return BIBLIOGRAPHY_STYLES.map(({ id, label }) => ({
    id,
    label: id === 'apa' ? label : `${label} (${t('bibliography.numeric')})`,
  }))
}

export function bibliographySkipReason(itemType: string): string {
  switch (itemType) {
    case 'attachment': return 'bibliography.skipAttachment'
    case 'note': return 'bibliography.skipNote'
    case 'annotation': return 'bibliography.skipAnnotation'
    default: return 'bibliography.skipUnavailable'
  }
}

const CSL_TAGS = new Set(['div', 'span', 'em', 'i', 'b', 'strong', 'sup', 'sub', 'u', 's', 'br'])
const CSL_STYLES = [
  'clear', 'float', 'line-height', 'margin-bottom', 'margin-left', 'padding-right', 'text-indent',
  'font-style', 'font-variant', 'font-weight', 'text-decoration', 'vertical-align',
]

/** Only copy rendered CSL markup and its typographic styles into the preview/clipboard. */
function copyCslNodes(source: ParentNode, target: HTMLElement): void {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.textContent ?? '')
      continue
    }
    if (!(node instanceof HTMLElement) || node.matches('.Z3988, script, style, template')) continue
    const tag = node.localName
    if (!CSL_TAGS.has(tag)) {
      copyCslNodes(node, target)
      continue
    }
    const clean = document.createElement(tag)
    const classes = [...node.classList].filter((name) => /^csl-[a-z-]+$/u.test(name))
    if (classes.length > 0) clean.className = classes.join(' ')
    for (const property of CSL_STYLES) {
      const value = node.style.getPropertyValue(property)
      if (/^[\w.%+ -]+$/u.test(value)) clean.style.setProperty(property, value)
    }
    copyCslNodes(node, clean)
    target.append(clean)
  }
}

export function formatBibliography(html: string): { html: string; text: string; count: number } {
  const source = document.createElement('template')
  source.innerHTML = html
  const clean = document.createElement('div')
  copyCslNodes(source.content, clean)
  const entries = [...clean.querySelectorAll<HTMLElement>('.csl-entry')]
  const text = entries.map((entry) => {
    const copy = entry.cloneNode(true) as HTMLElement
    for (const margin of copy.querySelectorAll('.csl-left-margin')) margin.after(' ')
    for (const lineBreak of copy.querySelectorAll('br')) lineBreak.replaceWith(' ')
    return (copy.textContent ?? '').replace(/\s+/gu, ' ').trim()
  }).join('\n')
  return { html: clean.innerHTML, text, count: entries.length }
}
