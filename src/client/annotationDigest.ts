/**
 * 笔记与标注汇总的纯逻辑：装箱与续批。
 *
 * 选择发生在弹层里（逐条勾选、默认全选），这里只做一件事：把用户勾好的内容
 * 按预算切成若干批。因此与前一版的关键差别是 **没有 cap / 没有 dropped** ——
 * 用户勾了什么就必须全部送达，宁可同一篇出现在两批里（标「（续）」），
 * 也不能静默砍掉几条。
 *
 * 三条约定：
 *
 * 1. **按篇装箱**，一篇尽量不拆；只有这一篇单独就超过单批预算时才按条续批。
 * 2. **顺序即弹层顺序**：标注按页、笔记按更新时间，排序由 {@link sortAnnotations}
 *    与 {@link sortNotes} 统一提供，装箱阶段不再重排。
 * 3. **字符预算按估算**：实际文本要 i18n、要 base64 证据链接，装箱时还没生成；
 *    这里按「原文 + 评论 + 一条证据链接的典型长度」估，偏保守。
 */

import type { ZoteroAnnotation, ZoteroNote } from '../zotero/types'
import { commentPlain, hasComment } from './annotationComment'
import { noteHtmlToText } from './compose'

/** 单批正文字符预算（约 4k token）。 */
export const ANNSET_BATCH_CHARS = 6000
/** 单批篇数上限：防止一堆短篇把批次切得太碎。 */
export const ANNSET_PAPERS_PER_BATCH = 6
/** 一次汇总的篇数上限。 */
export const ANNSET_MAX_PAPERS = 40
/** 一次汇总的条目上限（标注 + 笔记），同时决定 ref 体积上限。 */
export const ANNSET_MAX_ITEMS = 400

/**
 * 一条证据链接的典型字符成本。
 *
 * 链接是 base64 后的 JSON（key / id / 附件 key / 标注 key / 页码），不含原文，
 * 实测 120–160 字符。87 条标注光链接就一万多字符，不计进去会让批次严重超编。
 */
const EVIDENCE_COST = 150

/** 一条标注除原文与评论之外的固定开销（前缀、类型、页码、换行）。 */
const ANNOTATION_BASE = 40

/** 一条笔记除标题正文之外的固定开销（书名号、字数、日期、key）。 */
const NOTE_BASE = 60

export interface DigestPaperInput {
  key: string
  title: string
  /** 已拼好的作者串（`detail.creators.join('、')`）。 */
  creators: string
  year: string
  /** 用户勾选的标注，调用方已按 {@link sortAnnotations} 排好。 */
  annotations: readonly ZoteroAnnotation[]
  /** 用户勾选的笔记，调用方已按 {@link sortNotes} 排好。 */
  notes: readonly ZoteroNote[]
  /** 条目已不在文库：不参与内容，只记一笔。 */
  missing?: boolean
}

export interface DigestPaper {
  key: string
  title: string
  creators: string
  year: string
  /** 本批要投递的条目。 */
  annotations: ZoteroAnnotation[]
  notes: ZoteroNote[]
  /** 本篇在整组中的编号。提交时用于保留已删除文献之前的编号。 */
  number?: number
  /** 本篇在此前批次中已安排的标注和笔记数。 */
  evidenceOffset?: number
  /** 本篇被选中的总数（跨批），用于「续，本篇共 N 条」。 */
  annotationTotal: number
  noteTotal: number
  /** 本篇在本批是「续篇」：前面已经有同一篇的另一段。 */
  continued: boolean
  /** 本篇在本批之后还有内容。 */
  hasMore: boolean
  chars: number
  missing: boolean
}

export interface DigestBatch {
  papers: DigestPaper[]
  chars: number
  annotations: number
  notes: number
}

export interface DigestPlan {
  batches: DigestBatch[]
  total: {
    /** 有内容、实际进入批次的篇数。 */
    papers: number
    annotations: number
    notes: number
    chars: number
    /** 条目已不在文库的篇数。 */
    missing: number
    missingKeys: string[]
  }
}

/** 一条标注在投喂包里的粗略字符数。 */
export function annotationChars(annotation: ZoteroAnnotation): number {
  return ANNOTATION_BASE
    + annotation.text.length
    + commentPlain(annotation.comment).length
    + annotation.pageLabel.length
    + EVIDENCE_COST
}

/** 一条笔记在投喂包里的粗略字符数。 */
export function noteChars(note: ZoteroNote): number {
  return NOTE_BASE + note.title.length + noteHtmlToText(note.html).length
}

function pageIndexOf(annotation: ZoteroAnnotation): number {
  return annotation.position === null ? Number.MAX_SAFE_INTEGER : annotation.position.pageIndex
}

/**
 * 篇内标注排序：按页，同页按 Zotero 的 `sortIndex`，再按 key 兜底。
 *
 * 网页标注没有 `pageIndex`（排到最后），但 `sortIndex` 仍能给出文档顺序。
 */
export function sortAnnotations(annotations: readonly ZoteroAnnotation[]): ZoteroAnnotation[] {
  return [...annotations].sort((left, right) => {
    const page = pageIndexOf(left) - pageIndexOf(right)
    if (page !== 0) return page
    if (left.sortIndex !== right.sortIndex) return left.sortIndex < right.sortIndex ? -1 : 1
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
}

/** 篇内笔记排序：按更新时间倒序（最近的先看）。 */
export function sortNotes(notes: readonly ZoteroNote[]): ZoteroNote[] {
  return [...notes].sort((left, right) => right.dateModified.localeCompare(left.dateModified))
}

/** 一条标注值不值得进汇总：截图 / 墨迹常常既无原文也无评论，进来只是噪音。 */
export function hasAnnotationContent(annotation: ZoteroAnnotation): boolean {
  return annotation.text.trim() !== '' || hasComment(annotation.comment)
}

/** 一条笔记有没有正文（只有标题的占位不进汇总）。 */
export function hasNoteContent(note: ZoteroNote): boolean {
  return noteHtmlToText(note.html).trim() !== ''
}

function headerChars(paper: Pick<DigestPaperInput, 'title' | 'creators' | 'year'>): number {
  return 30 + paper.title.length + paper.creators.length + paper.year.length
}

function sectionOverhead(annotations: number, notes: number): number {
  return (annotations > 0 ? 24 : 0) + (notes > 0 ? 12 : 0)
}

interface Pending {
  kind: 'annotation' | 'note'
  cost: number
  annotation?: ZoteroAnnotation
  note?: ZoteroNote
}

/**
 * 按篇装箱。
 *
 * 内层循环负责「一篇能否装进当前批」，装不下就把它拆成「本批一段 + 下一批续段」；
 * 外层负责在篇与篇之间换批。单条内容本身就超预算时（Host 已限长，理论上不会）
 * 仍然独占一段，不截断。
 */
export function packBatches(papers: readonly DigestPaperInput[]): DigestBatch[] {
  const batches: DigestBatch[] = []
  let current: DigestBatch = { papers: [], chars: 0, annotations: 0, notes: 0 }

  const flush = (): void => {
    if (current.papers.length > 0) batches.push(current)
    current = { papers: [], chars: 0, annotations: 0, notes: 0 }
  }

  for (const paper of papers) {
    if (paper.missing === true) continue
    const pending: Pending[] = [
      ...paper.annotations.map((annotation) => ({ kind: 'annotation' as const, cost: annotationChars(annotation), annotation })),
      ...paper.notes.map((note) => ({ kind: 'note' as const, cost: noteChars(note), note })),
    ]
    if (pending.length === 0) continue
    if (current.papers.length >= ANNSET_PAPERS_PER_BATCH) flush()

    let cursor = 0
    let continued = false
    while (cursor < pending.length) {
      // 当前批装不下「本篇第一条」时先换批，别让续段无谓地裂成两枚空壳。
      const first = pending[cursor] as Pending
      if (current.papers.length > 0 && current.chars + headerChars(paper) + first.cost > ANNSET_BATCH_CHARS) {
        flush()
      }

      const entry: DigestPaper = {
        key: paper.key,
        title: paper.title,
        creators: paper.creators,
        year: paper.year,
        annotations: [],
        notes: [],
        evidenceOffset: cursor,
        annotationTotal: paper.annotations.length,
        noteTotal: paper.notes.length,
        continued,
        hasMore: false,
        chars: headerChars(paper),
        missing: false,
      }

      while (cursor < pending.length) {
        const next = pending[cursor] as Pending
        const filled = entry.annotations.length + entry.notes.length > 0
        if (filled && current.chars + entry.chars + next.cost > ANNSET_BATCH_CHARS) break
        if (next.kind === 'annotation') entry.annotations.push(next.annotation as ZoteroAnnotation)
        else entry.notes.push(next.note as ZoteroNote)
        entry.chars += next.cost
        cursor += 1
      }

      entry.chars += sectionOverhead(entry.annotations.length, entry.notes.length)
      entry.hasMore = cursor < pending.length
      current.papers.push(entry)
      current.chars += entry.chars
      current.annotations += entry.annotations.length
      current.notes += entry.notes.length

      if (entry.hasMore) {
        continued = true
        flush()
      }
    }
  }

  flush()
  return batches
}

/** 全流程：装箱 + 汇总统计。 */
export function planDigest(inputs: readonly DigestPaperInput[]): DigestPlan {
  const batches = packBatches(inputs)
  let annotations = 0
  let notes = 0
  let chars = 0
  let papers = 0
  for (const batch of batches) {
    annotations += batch.annotations
    notes += batch.notes
    chars += batch.chars
    papers += batch.papers.length
  }
  const missing = inputs.filter((input) => input.missing === true)
  return {
    batches,
    total: {
      papers,
      annotations,
      notes,
      chars,
      missing: missing.length,
      missingKeys: missing.map((input) => input.key),
    },
  }
}

export type GroupCheckState = 'all' | 'none' | 'partial'

/**
 * 组头勾选框的三态。
 *
 * 单拎出来是为了能在场景脚本里直接验：部分选中要落成 `partial`（组头画横线），
 * 全空与全满分别是 `none` / `all` —— 这三态画错，用户就看不出「这一篇还有没勾的」。
 */
export function groupCheckState(flags: readonly boolean[]): GroupCheckState {
  if (flags.length === 0) return 'none'
  const checked = flags.filter((flag) => flag).length
  if (checked === 0) return 'none'
  return checked === flags.length ? 'all' : 'partial'
}

/** 选中条目总数（标注 + 笔记），用于弹层的上限判断。 */
export function countItems(inputs: readonly DigestPaperInput[]): number {
  let total = 0
  for (const input of inputs) total += input.annotations.length + input.notes.length
  return total
}
