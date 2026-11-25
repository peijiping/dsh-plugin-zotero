/**
 * 「Zotero key → 给模型的完整引用文本」。
 *
 * 侧栏插入的是引用 chip（输入框里只有一个胶囊），真正的文本在**提交那一刻**
 * 由引用源的 codec 回调这里生成。因此取数失败必须分两类处理：
 *
 * - 条目 / 目录 / 笔记 / 标注已不在文库里 → 返回一行带 key 的标记。数据缺失不是故障，
 *   为它阻断发送会把用户困在输入框里。
 * - Zotero 没开、Host 不可达 → 抛出。宿主会还原草稿并提示，用户启动 Zotero
 *   后重发即可；静默降级成 `@item:KEY` 等于给模型发一个裸 key。
 */

import type { ReviewEvidenceRecord } from '../zotero/review-evidence-types'
import type { ZoteroFulltext, ZoteroItemDetail } from '../zotero/types'
import type { Translate } from './locales'
import { tpl } from './locales'
import { ApiFailure, fetchFulltext, fetchItem, fetchItems, fetchTags, fetchTree, saveReviewEvidence } from './api'
import type { DigestBatch, DigestPaper } from './annotationDigest'
import { annotationChars, noteChars } from './annotationDigest'
import {
  COLLECTION_PREVIEW_LIMIT,
  annotationSetText,
  annotationText,
  collectionText,
  excerptText,
  fulltextText,
  itemText,
  noteText,
  shotText,
  tagSetText,
  tagText,
  translationText,
} from './compose'
import { decodeRefBody, type AnnotationSetRef } from './reference'
import type { ShotMeta } from './viewer/shot/types'
import { evidenceLine, makeEvidence, type EvidenceTarget } from './evidence'
import { parseFulltextRange, sliceFulltext } from './fulltextRange'
import { reviewEvidenceHref, reviewFragments } from './reviewEvidence'

/** 文库里已经没有这个对象（与「连不上 Zotero」区分开）。 */
function isMissing(error: unknown): boolean {
  return error instanceof ApiFailure && error.code === 'zotero_not_found'
}

export async function itemCitation(
  t: Translate,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return itemText(t, await fetchItem(key, 'apa', signal))
  } catch (error) {
    if (isMissing(error)) return tpl(t('cmp.missing.item'), { key })
    throw error
  }
}

/**
 * 一段全文的引用：ref body 是 `<编码后的 key>:<范围表达式>`。
 *
 * 正文走面板自己的 `fetchItem()` 现取（与条目 chip 同一条 HTTP 通道，不依赖 MCP），
 * 再按范围切片。key 是父条目 key——Host 已把首选附件的全文挂在父条目 detail 上，
 * 直接 `fetchItem(key)` 即可拿到 `detail.fulltext`。
 */
export async function fulltextCitation(
  t: Translate,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const at = body.indexOf(':')
  if (at < 0) throw new Error(`无法识别的全文引用：${body}`)
  const key = decodeRefPart('全文', body.slice(0, at))
  const expr = body.slice(at + 1)

  let detail
  try {
    detail = await fetchItem(key, 'apa', signal)
  } catch (error) {
    if (isMissing(error)) return tpl(t('cmp.missing.item'), { key })
    throw error
  }
  if (detail.attachments.length > 1) throw new Error(tpl(t('fulltext.legacyAttachment'), { name: detail.title }))
  if (detail.fulltext === null) return tpl(t('cmp.fulltext.noFulltext'), { key })

  if (parseFulltextRange(expr).mode === 'pages') throw new Error(t('review.chapterReselect'))
  const slice = sliceFulltext(detail.fulltext.content, expr)
  return fulltextText(t, detail, slice, detail.fulltext)
}

export interface AttachmentCitation {
  key: string
  title: string
  attachmentKey: string
  attachmentTitle: string
  revision: string
  range: string
  evidence?: EvidenceTarget
  chapters?: { start: number; end: number; evidence: EvidenceTarget }[]
}

export async function attachmentCitation(
  t: Translate,
  source: AttachmentCitation,
  signal?: AbortSignal,
): Promise<string> {
  return attachmentCitationText(t, source, await verifiedFulltext(t, source, signal))
}

async function verifiedFulltext(
  t: Translate,
  source: AttachmentCitation,
  signal?: AbortSignal,
): Promise<ZoteroFulltext> {
  const fulltext = await fetchFulltext(source.attachmentKey, signal)
  if (fulltext === null || fulltext.attachmentKey !== source.attachmentKey || fulltext.revision !== source.revision) {
    throw new Error(tpl(t('fulltext.changed'), { name: source.attachmentTitle }))
  }
  return fulltext
}

export function attachmentCitationText(t: Translate, source: AttachmentCitation, fulltext: ZoteroFulltext): string {
  if (parseFulltextRange(source.range).mode === 'pages') throw new Error(t('review.chapterReselect'))
  const slice = sliceFulltext(fulltext.content, source.range)
  if (source.chapters?.length) {
    slice.text = source.chapters.map(({ start, end, evidence }) =>
      `${evidenceLine(t, evidence)}\n${fulltext.content.slice(start, end)}`,
    ).join('\n\n')
  }
  const text = fulltextText(t, source, slice, fulltext, source.attachmentTitle)
  return source.evidence === undefined ? text : withEvidence(t, text, source.evidence)
}

function withEvidence(t: Translate, text: string, target: EvidenceTarget): string {
  const end = text.indexOf('\n')
  return end < 0 ? `${text}\n${evidenceLine(t, target)}`
    : `${text.slice(0, end)}\n${evidenceLine(t, target)}${text.slice(end)}`
}

export interface ReviewSource {
  key: string
  title: string
  creators: string
  year: string
  attachmentTitle?: string
  coverage: 'text' | 'metadata' | 'missing' | 'error'
  missingIndex?: boolean
  text?: AttachmentCitation
}

export function reviewSourceText(t: Translate, source: ReviewSource, body?: string): string {
  const name = [source.title, source.creators, source.year].filter(Boolean).join(' · ')
  const header = tpl(t('review.source'), { name, key: source.key })
  if (body !== undefined) return `${header}\n${body}`
  const attachment = source.attachmentTitle
    ? tpl(t('fulltext.attachment'), { name: source.attachmentTitle })
    : ''
  const indexStatus = source.missingIndex ? t('review.indexMissing') : ''
  return [header, attachment, t(`review.coverage.${source.coverage}`), indexStatus].filter(Boolean).join('\n')
}

export function reviewText(t: Translate, sections: readonly string[]): string {
  return [t('review.title'), t('review.instructions'), ...sections].join('\n\n')
}

export function reviewEvidenceSource(
  t: Translate,
  source: ReviewSource,
  fulltext: ZoteroFulltext,
  run: string,
  paper: number,
): { section: string; records: ReviewEvidenceRecord[] } {
  const attachment = source.text
  if (attachment === undefined) return { section: reviewSourceText(t, source), records: [] }
  const slice = sliceFulltext(fulltext.content, attachment.range)
  const records = reviewFragments(fulltext.content, attachment.range).map((fragment, index) => ({
    ...fragment,
    id: `Z${paper}.${index + 1}`,
    key: source.key,
    attachmentKey: attachment.attachmentKey,
    revision: attachment.revision,
  }))
  slice.text = records.map(({ id, excerpt }) => `[${id}](${reviewEvidenceHref({ run, id })})\n${excerpt}`).join('\n\n')
  const body = fulltextText(t, source, slice, fulltext, attachment.attachmentTitle)
  return { section: reviewSourceText(t, source, body), records }
}

export async function reviewCitation(
  t: Translate,
  sources: readonly ReviewSource[],
  signal: AbortSignal,
  run?: string,
): Promise<string> {
  const sections: string[] = []
  const records: ReviewEvidenceRecord[] = []
  for (let start = 0; start < sources.length; start += 4) {
    const group = await Promise.all(sources.slice(start, start + 4).map(async (source, index) => {
      if (source.text === undefined) return { section: reviewSourceText(t, source), records: [] }
      const fulltext = await verifiedFulltext(t, source.text, signal)
      if (run !== undefined) return reviewEvidenceSource(t, source, fulltext, run, start + index + 1)
      return { section: reviewSourceText(t, source, attachmentCitationText(t, source.text, fulltext)), records: [] }
    }))
    for (const entry of group) {
      sections.push(entry.section)
      records.push(...entry.records)
    }
  }
  if (run !== undefined && records.length > 0) {
    signal.throwIfAborted()
    try {
      await saveReviewEvidence(run, records, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ApiFailure && error.code === 'bad_request' && error.message.includes('未知 action')) {
        throw new Error(t('review.hostOutdated'))
      }
      throw new Error(t('review.evidenceSaveFailed'))
    }
    signal.throwIfAborted()
  }
  return reviewText(t, sections)
}

export async function collectionCitation(
  t: Translate,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const tree = await fetchTree(signal)
  const collection = tree.collections.find((node) => node.key === key)
  if (collection === undefined) return tpl(t('cmp.missing.collection'), { key })
  const data = await fetchItems({
    scope: collection.scope,
    collectionKey: collection.scope === undefined ? collection.key : undefined,
    limit: COLLECTION_PREVIEW_LIMIT,
  }, signal)
  return collectionText(t, collection, data.items, data.total)
}

/** 引用 body 里的「父 key/子 key」；`childKey` 也是 chip 标签为空时的兜底标识。 */
interface ChildRef {
  parentKey: string
  childKey: string
}

/**
 * 拆子条目 ref。
 *
 * 结构坏了（缺分隔符或某一段为空）说明这个 chip 不是本插件写的，抛出去让宿主
 * 还原草稿；这与「对象已不在文库里」不同，后者只发一行标记。
 */
function parseChildRef(body: string): ChildRef {
  const at = body.indexOf('/')
  const parentKey = at < 0 ? '' : body.slice(0, at)
  const childKey = at < 0 ? '' : body.slice(at + 1)
  if (parentKey === '' || childKey === '') {
    throw new Error(`无法识别的 Zotero 子条目引用：${body}`)
  }
  return { parentKey, childKey }
}

/**
 * 笔记 / 标注的取数都落在父条目的详情上，代价与条目引用同量级：`fetchItem` 会带上
 * 附件全文与标注分页。Host 侧取标注失败时返回空数组，所以「取不到」既可能是真被删
 * 了，也可能是那次请求降级——两者都发一行标记，不值得为区分它阻断发送。
 */
export async function noteCitation(
  t: Translate,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const { parentKey, childKey } = parseChildRef(body)
  let detail
  try {
    detail = await fetchItem(parentKey, 'apa', signal)
  } catch (error) {
    if (isMissing(error)) return tpl(t('cmp.missing.note'), { key: childKey })
    throw error
  }
  const note = detail.notes.find((child) => child.key === childKey)
  if (note === undefined) return tpl(t('cmp.missing.note'), { key: childKey })
  return noteText(t, detail, note)
}

/** 一条标注的引用；chip 的 label 是原文摘要，提交时重建为完整引用文本。 */
export async function annotationCitation(
  t: Translate,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const colon = body.indexOf(':')
  const { parentKey, childKey } = parseChildRef(colon < 0 ? body : body.slice(0, colon))
  let detail
  try {
    detail = await fetchItem(parentKey, 'apa', signal)
  } catch (error) {
    if (isMissing(error)) return tpl(t('cmp.missing.annotation'), { key: childKey })
    throw error
  }
  const annotation = detail.annotations.find((child) => child.key === childKey)
  if (annotation === undefined) return tpl(t('cmp.missing.annotation'), { key: childKey })
  const text = annotationText(t, detail, annotation)
  if (colon >= 0) return withEvidence(t, text, JSON.parse(decodeURIComponent(body.slice(colon + 1))))
  return withEvidence(t, text, makeEvidence(parentKey, {
    attachmentKey: annotation.attachmentKey,
    annotationKey: annotation.key,
    page: annotation.position === null ? undefined : annotation.position.pageIndex + 1,
    pageLabel: annotation.pageLabel || undefined,
    quote: annotation.text.slice(0, 240),
  }))
}

/**
 * 一段划选摘录的引用。
 *
 * 与按 key 现取的引用不同，摘录没有「文库里被删掉」这回事：itemKey、标题、
 * 原文都在 ref 里定格，所以这里不请求 Host，也不需要 AbortSignal。
 * 结构坏了（不是三段 / 某段解码失败）说明这个 chip 不是本插件写的，抛出去让
 * 宿主还原草稿，别把一截乱码发给模型。
 */
export async function excerptCitation(t: Translate, body: string): Promise<string> {
  const parts = body.split(':')
  const [rawKey, rawTitle, rawQuote] = parts
  if ((parts.length !== 3 && parts.length !== 4) || rawKey === undefined || rawTitle === undefined || rawQuote === undefined) {
    throw new Error(`无法识别的 Zotero 摘录引用：${body}`)
  }
  const text = excerptText(t, {
    key: decodeRefPart('摘录', rawKey),
    title: decodeRefPart('摘录', rawTitle),
  }, decodeRefPart('摘录', rawQuote))
  return parts[3] === undefined ? text : withEvidence(t, text, JSON.parse(decodeURIComponent(parts[3])))
}

/**
 * 一段「原文 + 译文」的引用。
 *
 * 四段自包含（key / 标题 / 原文 / 译文），不请求 Host：译文是用户当下看到的那一版，
 * 重新翻译不会改写已插入的 chip。
 */
export async function translationCitation(t: Translate, body: string): Promise<string> {
  const parts = body.split(':')
  const [rawKey, rawTitle, rawQuote, rawTranslated] = parts
  if (
    (parts.length !== 4 && parts.length !== 5)
    || rawKey === undefined
    || rawTitle === undefined
    || rawQuote === undefined
    || rawTranslated === undefined
  ) {
    throw new Error(`无法识别的 Zotero 翻译引用：${body}`)
  }
  const text = translationText(t, {
    key: decodeRefPart('翻译', rawKey),
    title: decodeRefPart('翻译', rawTitle),
  }, decodeRefPart('翻译', rawQuote), decodeRefPart('翻译', rawTranslated))
  return parts[4] === undefined ? text : withEvidence(t, text, JSON.parse(decodeURIComponent(parts[4])))
}

/**
 * 一张截图的引用：7 段全自包含，不请求 Host，也不依赖图片对象是否还在。
 *
 * 图片附件与这段文本由宿主组装成同一条消息；chip 被删掉时模型仍能看到图，
 * 图片被删掉时这段文本也不会假装自己有图（末尾那行说明已写明这一点）。
 */
export async function shotCitation(t: Translate, body: string): Promise<string> {
  const parts = body.split(':')
  if ((parts.length !== 7 && parts.length !== 8) || parts.some((part) => part === undefined)) {
    throw new Error(`无法识别的 Zotero 截图引用：${body}`)
  }
  const [key, title, byline, pages, section, digest, shotId, evidence] = parts.map(
    (part) => decodeRefPart('截图', part ?? ''),
  )
  const meta: ShotMeta = {
    key: key ?? '', title: title ?? '', byline: byline ?? '', pages: pages ?? '',
    section: section ?? '', digest: digest ?? '', shotId: shotId ?? '',
  }
  const text = shotText(t, meta)
  return evidence === undefined ? text : withEvidence(t, text, JSON.parse(evidence))
}

/** 解码 ref 里的一段；坏转义会抛 URIError，换成带来源的可辨认错误。 */
function decodeRefPart(kind: '摘录' | '标签' | '翻译' | '截图' | '全文', encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new Error(`无法识别的 Zotero ${kind}引用：${encoded}`)
  }
}

/** 解码标签名；ref 结构坏了直接抛出（不是「对象已删除」）。 */
function decodeTagName(encoded: string): string {
  return decodeRefPart('标签', encoded)
}

/**
 * 单个标签的引用（全库范围）。
 *
 * 标签引用与「筛选跟随当前分类」不同：同一 chip 在任何分类下提交都展开为全库
 * 带该标签的条目，保证引用稳定。
 */
export async function tagCitation(
  t: Translate,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const name = decodeTagName(body)
  const data = await fetchItems({
    tags: [name],
    tagMode: 'all',
    limit: COLLECTION_PREVIEW_LIMIT,
  }, signal)
  if (data.total > 0) return tagText(t, name, data.items, data.total)
  // 0 条：区分「标签已从文库消失」与「标签存在但没有条目」。
  const tags = await fetchTags(signal)
  return tags.tags.some((tag) => tag.name === name)
    ? tpl(t('cmp.tag.empty'), { name })
    : tpl(t('cmp.missing.tag'), { name })
}

/** 解析 `tags:` 的 body：`<all|any>:<enc1>,<enc2>,…`。 */
function parseTagSet(body: string): { mode: 'all' | 'any'; names: string[] } {
  const at = body.indexOf(':')
  const rawMode = at < 0 ? '' : body.slice(0, at)
  const rest = at < 0 ? '' : body.slice(at + 1)
  const names = rest.split(',').filter((part) => part !== '').map(decodeTagName)
  if ((rawMode !== 'all' && rawMode !== 'any') || names.length === 0) {
    throw new Error(`无法识别的 Zotero 标签组引用：${body}`)
  }
  return { mode: rawMode, names }
}

/**
 * 多个标签的引用（全库范围，AND/OR 按 ref 里定格的模式）。
 *
 * 同时取标签计数：既用于展开文本，也用来识别提交前被删掉的标签。
 */
export async function tagSetCitation(
  t: Translate,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const { mode, names } = parseTagSet(body)
  const [data, tags] = await Promise.all([
    fetchItems({ tags: names, tagMode: mode, limit: COLLECTION_PREVIEW_LIMIT }, signal),
    fetchTags(signal),
  ])
  const counts = new Map<string, number>()
  for (const tag of tags.tags) {
    if (names.includes(tag.name)) counts.set(tag.name, tag.count)
  }
  const missing = names.filter((name) => !counts.has(name))
  if (missing.length === names.length) {
    return tpl(t('cmp.missing.tagSet'), { names: names.join('、') })
  }
  return tagSetText(t, names, mode, counts, missing, data.items, data.total)
}

/**
 * 解析 `annset:` 的 body（v2：勾选清单）。
 *
 * 字段缺一个就抛：结构坏了说明这个 chip 不是本插件写的（或者被手改过），
 * 让宿主还原草稿，别把半份材料发给模型 —— 「以为读了 9 篇实际读 3 篇」比发送失败糟。
 * 旧版（v1，只存范围）从未发布，直接不认，提示重新插入。
 */
function parseAnnotationSetRef(body: string): AnnotationSetRef {
  let value: unknown
  try {
    value = decodeRefBody(body)
  } catch {
    throw new Error(`无法识别的 Zotero 汇总引用：${body.slice(0, 80)}`)
  }
  const ref = value as Partial<AnnotationSetRef> & { v?: number }
  if (ref.v !== 2) {
    throw new Error('汇总引用版本过旧，请删除该引用后重新插入')
  }
  const numbers = (input: unknown, length: number): boolean =>
    Array.isArray(input) && input.length === length
    && input.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
  const strings = (input: unknown): boolean =>
    Array.isArray(input) && input.every((item) => typeof item === 'string' && item !== '')
  const papersOk = Array.isArray(ref.papers) && ref.papers.length > 0
    && ref.papers.every((paper) => typeof paper?.key === 'string' && paper.key !== ''
      && strings(paper.anns) && strings(paper.notes))
  const optionalOk = [ref.continued, ref.more].every((list) => list === undefined || strings(list))
  const valid = papersOk && optionalOk
    && numbers(ref.batch, 2) && numbers(ref.range, 2) && numbers(ref.total, 4)
  if (!valid) throw new Error('无法识别的 Zotero 汇总引用：字段不完整')
  return ref as AnnotationSetRef
}

/** 按 ref 里的 key 顺序取对象；找不到的跳过，由调用方计数。 */
function pickByKeys<T extends { key: string }>(keys: readonly string[], byKey: ReadonlyMap<string, T>): T[] {
  const out: T[] = []
  for (const key of keys) {
    const found = byKey.get(key)
    if (found !== undefined) out.push(found)
  }
  return out
}

/**
 * 一批笔记 / 标注的汇总文本。
 *
 * 取数口径与单条引用一致：逐篇 `fetchItem`（每 4 篇并发）。区别是**只交付 ref 里
 * 记下的那些 key** —— 用户勾选就是意图，插入之后库里新增的标注不该自动混进来。
 * 被删掉的条目/子条目逐类计数，写在 ⚠️ 行里，不阻断发送。
 */
export async function annotationSetCitation(
  t: Translate,
  body: string,
  signal?: AbortSignal,
): Promise<string> {
  const ref = parseAnnotationSetRef(body)
  const loaded = new Map<string, ZoteroItemDetail>()
  let missingPapers = 0
  let missingItems = 0

  for (let start = 0; start < ref.papers.length; start += 4) {
    const group = ref.papers.slice(start, start + 4)
    const results = await Promise.all(group.map(async (paper) => {
      try {
        return { key: paper.key, detail: await fetchItem(paper.key, 'apa', signal) }
      } catch (error) {
        if (isMissing(error)) return { key: paper.key, detail: null }
        throw error
      }
    }))
    for (const result of results) {
      if (result.detail === null) missingPapers += 1
      else loaded.set(result.key, result.detail)
    }
  }

  const papers: DigestPaper[] = []
  for (const entry of ref.papers) {
    const detail = loaded.get(entry.key)
    if (detail === undefined) continue
    const annotations = pickByKeys(entry.anns, new Map(detail.annotations.map((item) => [item.key, item])))
    const notes = pickByKeys(entry.notes, new Map(detail.notes.map((item) => [item.key, item])))
    missingItems += entry.anns.length - annotations.length
    missingItems += entry.notes.length - notes.length
    papers.push({
      key: detail.key,
      title: detail.title,
      creators: detail.creators.join('、'),
      year: detail.year,
      annotations,
      notes,
      annotationTotal: entry.annTotal ?? annotations.length,
      noteTotal: entry.noteTotal ?? notes.length,
      continued: ref.continued?.includes(entry.key) === true,
      hasMore: ref.more?.includes(entry.key) === true,
      chars: annotations.reduce((sum, item) => sum + annotationChars(item), 0)
        + notes.reduce((sum, item) => sum + noteChars(item), 0),
      missing: false,
    })
  }

  if (papers.length === 0) return t('digest.cmp.empty')

  const batch: DigestBatch = {
    papers,
    chars: papers.reduce((sum, paper) => sum + paper.chars, 0),
    annotations: papers.reduce((sum, paper) => sum + paper.annotations.length, 0),
    notes: papers.reduce((sum, paper) => sum + paper.notes.length, 0),
  }

  return annotationSetText(t, batch, {
    index: ref.batch[0],
    total: ref.batch[1],
    from: ref.range[0],
    to: ref.range[1],
    overall: {
      papers: ref.total[0],
      annotations: ref.total[1],
      notes: ref.total[2],
      chars: ref.total[3],
      missingItems,
      missingPapers,
    },
  })
}
