import { DIGEST_EVIDENCE_ID, evidenceIn, noteEvidence, type EvidenceTarget } from './evidence'
import { tpl, type Translate } from './locales'

const DIGEST_HEADER = /^(?:【笔记与标注汇总】[ \t]*第|\[Notes & annotations\] Batch )/mu
const PAPER = /^(?:文献《(.+)》｜Zotero |Paper "(.+)" \| Zotero )([A-Z2-9]{8})(?:｜| \| )/u
const ANNOTATION = /^- (?:\[[^\]]+\] )?([^：:\n]+)[：:]\s*(.*)$/u
const NOTE = new RegExp(String.raw`^- (?:《(.+)》|"(.*)")[ \t]*· [\d,]+ (?:字 · 更新 .*?　笔记 key |chars · updated .*? \| note key )([A-Z2-9]{8})(?:　\[(N-[A-Z2-9]{8}|${DIGEST_EVIDENCE_ID})\])?$`, 'u')
const NOTE_BODY = /^ {2}(?:正文：|Body: )(.*)$/u

interface DigestSource {
  paperKey: string
  target: EvidenceTarget
  label: string
}

function excerpt(text: string): string {
  const chars = Array.from(text.replace(/\s+/gu, ' ').trim())
  return chars.length > 52 ? chars.slice(0, 52).join('') + '…' : chars.join('')
}

/** Read the sources from the submitted text, including summaries saved before links were supported. */
export function digestEvidenceIn(t: Translate, body: string): DigestSource[] | null {
  if (!DIGEST_HEADER.test(body)) return null
  const sources: DigestSource[] = []
  const lines = body.split('\n')
  let paper: RegExpExecArray | null = null
  let annotation: RegExpExecArray | null = null
  for (const [index, line] of lines.entries()) {
    const heading = PAPER.exec(line)
    if (heading !== null) {
      paper = heading
      annotation = null
      continue
    }
    if (paper === null) continue
    const paperTitle = paper[1] ?? paper[2]
    const note = NOTE.exec(line)
    if (note !== null) {
      const title = note[1] ?? note[2]
      const first = NOTE_BODY.exec(lines[index + 1] ?? '')?.[1]?.trim()
      const next = lines[index + 2] ?? ''
      const quote = (first === title && next.trim() !== '' && !NOTE.test(next) ? next : first)
        ?.replace(/^- /u, '').trim()
      const label = title === paperTitle ? title : [paperTitle, title].filter(Boolean).join(' · ')
      const id = note[4]?.startsWith('E') ? note[4] : undefined
      sources.push({ paperKey: paper[3], target: noteEvidence(note[3], quote || undefined, id), label: [t('type.note'), label].join(' · ') })
      annotation = null
      continue
    }
    if (line.startsWith('- ')) {
      annotation = ANNOTATION.exec(line)
      continue
    }
    if (annotation === null || !/^ {2}(?:证据：|Evidence: )/u.test(line)) continue
    for (const target of evidenceIn(line)) {
      if (target.key !== paper[3]) continue
      const page = target.pageLabel || target.page
      const location = page === undefined ? '' : tpl(t('digest.cmp.evidencePage'), { page })
      const label = [paperTitle, location, annotation[1], excerpt(annotation[2])].filter(Boolean).join(' · ')
      sources.push({ paperKey: paper[3], target, label })
    }
    annotation = null
  }
  return sources
}
