/**
 * 插入草稿的文本模板（见设计方案 §3）。
 *
 * 每段文本都带稳定标识（`itemKey` / `collectionKey`），方便模型接着用
 * `mcp__zotero__*` 工具跟进。
 */

import type { Translate } from './locales'
import { tpl } from './locales'
import type { ShotMeta } from './viewer/shot/types'
import type { FulltextSlice } from './fulltextRange'
import type { DigestBatch, DigestPaper } from './annotationDigest'
import { commentPlain } from './annotationComment'
import { evidenceLink, makeEvidence } from './evidence'
import type {
  ZoteroAnnotation,
  ZoteroCollection,
  ZoteroFulltext,
  ZoteroItemDetail,
  ZoteroItemSummary,
  ZoteroNote,
} from '../zotero/types'

/** 整目录插入时最多列出多少条（完整清单交给模型的 MCP 工具）。 */
export const COLLECTION_PREVIEW_LIMIT = 50

function line(t: Translate, key: string, value: string): string {
  return tpl(t(key), { value })
}

/**
 * 单条目的引用文本。
 *
 * 不含摘要与标签：一次选中多条时这两段会把草稿撑得很长，模型拿着 itemKey
 * 就能取回全文元数据，不必在引用里重复。
 */
export function itemText(t: Translate, detail: ZoteroItemDetail): string {
  const head = tpl(t('cmp.item.header'), { key: detail.key, title: detail.title })
  const lines = [head]
  if (detail.creators.length > 0) lines.push(line(t, 'cmp.item.creators', detail.creators.join('、')))
  if (detail.year !== '') lines.push(line(t, 'cmp.item.year', detail.year))
  if (detail.publicationTitle !== '') lines.push(line(t, 'cmp.item.source', detail.publicationTitle))
  if (detail.doi !== '') lines.push(line(t, 'cmp.item.doi', detail.doi))
  if (detail.url !== '') lines.push(line(t, 'cmp.item.url', detail.url))
  // Host 已随详情下发 CSL 格式（style=apa），去标签后给模型一行可直接照抄的规范引用。
  const bib = detail.bib?.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim() ?? ''
  if (bib !== '') lines.push(line(t, 'cmp.item.bib', bib))
  return lines.join('\n')
}

/**
 * 全文提交时展开给模型的文本：出处头 + 截断警告 + 范围标注 + 声明 + 正文。
 *
 * `FulltextSlice` 自带 `scopeLabel` / `estimated` / `fallbackAll`，这里只负责
 * 拼装与翻译——定位的对错全在 `fulltextRange`，不在本函数重写一套判断。
 * 头部带稳定 key（模型可继续用 MCP 交叉引用），并显式声明不含图片与截断/估算，
 * 消除"模型不知道自己读到残篇 / 错位切片"的隐患（见设计文档 §3.3、§8）。
 *
 * 截断声明刻意**不是**一行轻描淡写的括号：早期版本写成「（全文已按长度截断…）」，
 * 模型会当成噪音跳过，然后对着半篇内容下结论。现在改成 ⚠️ 起头的独立行，并写清
 * 具体缺了多少字（`totalChars` 是截断前的真实长度），最后用「以下为正文」把元信息
 * 与正文隔开。
 */
export function fulltextText(
  t: Translate,
  detail: Pick<ZoteroItemDetail, 'key' | 'title'>,
  slice: FulltextSlice,
  fulltext: Pick<ZoteroFulltext, 'content' | 'truncated' | 'totalChars'>,
  attachmentTitle?: string,
): string {
  const lines = [
    tpl(t('cmp.fulltext.header'), { title: detail.title, key: detail.key, scope: slice.scopeLabel }),
  ]
  if (attachmentTitle) lines.push(tpl(t('fulltext.attachment'), { name: attachmentTitle }))
  if (fulltext.truncated) {
    const have = fulltext.content.length
    // 只重建 client 未重启 Host 时没有 totalChars：退化成「至少不比手上少」，不报 NaN。
    const total = Math.max(fulltext.totalChars ?? have, have)
    lines.push(tpl(t('cmp.fulltext.truncated'), {
      have: have.toLocaleString(),
      total: total.toLocaleString(),
      missing: (total - have).toLocaleString(),
    }))
  }
  if (slice.estimated) lines.push(t('cmp.fulltext.estimated'))
  if (slice.fallbackAll) lines.push(t('cmp.fulltext.headingFallback'))
  lines.push(t('cmp.fulltext.noImages'))
  lines.push(t('cmp.fulltext.bodyLabel'))
  lines.push(slice.text)
  return lines.join('\n')
}

/** 全文 chip 的标签：范围标注，过长截断。 */
export function fulltextChipLabel(t: Translate, scope: string): string {
  const label = tpl(t('cmp.fulltext.chipLabel'), { value: scope })
  const chars = Array.from(label)
  return chars.length > CHIP_LABEL_LIMIT
    ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…`
    : label
}

/**
 * 一张截图提交时展开给模型的说明文本。
 *
 * 图片附件与本段文本由宿主组装成**同一条消息**，所以模型既看到图，也知道是哪个
 * 文献、哪一部分。四项元数据共用 `ShotMeta`，与水印条、chip label 事实源一致。
 * 末尾明确「以图片为准、文本只用于定位」，避免模型拿摘要当原文引用。
 */
export function shotText(t: Translate, meta: ShotMeta): string {
  const none = t('cmp.shot.none')
  const lines = [
    tpl(t('cmp.shot.header'), { title: meta.title, key: meta.key }),
    tpl(t('cmp.shot.byline'), { value: meta.byline || none }),
    // 网页快照 / 纯文本 / 笔记没有页码，「未定位到」会被模型读成定位失败，整行省掉。
    ...(meta.pages === '' ? [] : [tpl(t('cmp.shot.pages'), { value: meta.pages })]),
    tpl(t('cmp.shot.section'), { value: meta.section || none }),
    tpl(t('cmp.shot.digest'), { value: meta.digest || t('cmp.shot.digestNone') }),
    t('cmp.shot.note'),
  ]
  return lines.join('\n')
}

/** chip 上唯一可见的文字；hover 的 title 由宿主按 label 显示。 */
export function shotChipLabel(t: Translate, meta: ShotMeta): string {
  const chars = Array.from(meta.title)
  const title = chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : meta.title
  const where = meta.pages === '' ? '' : ` · ${tpl(t('cmp.shot.pageTag'), { value: meta.pages })}`
  return tpl(t('cmp.shot.chipLabel'), { value: `${title}${where}` })
}

/**
 * 图片内底部水印条：图片被单独转发时也不丢「哪个文献、哪一部分」。
 *
 * 必须以工具署名开头。只写「《标题》 · P1 · 章节」时，模型会把它当成文档
 * 自带的页脚 / 页签标注（实测如此），而不是工具加的元数据。
 */
export function shotWatermark(t: Translate, meta: ShotMeta): string {
  const parts = [t('cmp.shot.watermark'), `《${meta.title}》`]
  if (meta.pages !== '') parts.push(`P${meta.pages}`)
  if (meta.section !== '') parts.push(meta.section)
  return parts.join(' · ')
}

/**
 * 选中片段的摘录文本。
 *
 * 只需要 key 与标题：提交时 codec 从摘录 chip 的 ref 里取回这两段，不再重新
 * 请求 Zotero，所以参数放宽到 {@link ZoteroItemDetail} 的最小子集。
 */
export function excerptText(
  t: Translate,
  detail: Pick<ZoteroItemDetail, 'key' | 'title'>,
  quote: string,
): string {
  const head = tpl(t('cmp.excerpt.header'), { title: detail.title, key: detail.key })
  const body = tpl(t('cmp.excerpt.quote'), { value: quote })
  return `${head}\n${body}`
}

/**
 * 摘录 chip 的标签：只放原文开头，胶囊自己会省略过长部分。
 *
 * PDF 抽取会在汉字之间插空格，标签里顺手清掉（展开给模型的原文不动）。
 */
export function excerptChipLabel(t: Translate, quote: string): string {
  return tpl(t('cmp.excerpt.chipLabel'), { value: summarize(quote) })
}

/**
 * 一段「原文 + 译文」的引用文本。
 *
 * 与纯摘录不同，这里把译文单独成段：模型读到的是对照文本，不需要自己再翻一遍。
 */
export function translationText(
  t: Translate,
  detail: Pick<ZoteroItemDetail, 'key' | 'title'>,
  quote: string,
  translated: string,
): string {
  const head = tpl(t('cmp.translation.header'), { title: detail.title, key: detail.key })
  const source = tpl(t('cmp.translation.quote'), { value: quote })
  const target = tpl(t('cmp.translation.translated'), { value: translated })
  return `${head}\n${source}\n${target}`
}

/** 翻译 chip 的标签：用译文开头，比原文更能说明这块内容是什么。 */
export function translationChipLabel(t: Translate, translated: string): string {
  return tpl(t('cmp.translation.chipLabel'), { value: summarize(translated) })
}

/** 截到 chip 能显示的长度；胶囊自己还会再省略，这里只是让 ref 前的标签短一点。 */
function summarize(text: string): string {
  const source = tidyAnnotation(text)
  const chars = Array.from(source)
  return chars.length > CHIP_LABEL_LIMIT ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…` : source
}

/**
 * PDF 抽取会在汉字之间插空格（`硫 化 氢`），展示与插入时去掉；
 * 只处理汉字与汉字之间的空格，避免动到西文词距。
 */
export function tidyAnnotation(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '')
    .trim()
}

/** 一条标注的引用文本：原文 + 类型 + 页码 + 评论 + 标注 key。 */
export function annotationText(
  t: Translate,
  detail: ZoteroItemDetail,
  annotation: ZoteroAnnotation,
): string {
  const comment = commentPlain(annotation.comment)
  const quote = tidyAnnotation(annotation.text) || comment
  const type = annotation.type === 'underline' ? t('annotation.type.underline') : t('annotation.type.highlight')
  const lines = [
    excerptText(t, detail, quote),
    tpl(t('cmp.annotation.type'), { value: type }),
  ]
  if (annotation.pageLabel !== '') lines.push(tpl(t('cmp.annotation.page'), { value: annotation.pageLabel }))
  if (comment !== '' && quote !== comment) lines.push(tpl(t('cmp.annotation.comment'), { value: comment }))
  lines.push(tpl(t('cmp.annotation.key'), { value: annotation.key }))
  return lines.join('\n')
}

/** chip 标签里原文摘要的长度上限（字符，非字节）。 */
const CHIP_LABEL_LIMIT = 40

/**
 * 标注 chip 的标签：原文摘要 + 页码。
 *
 * 标注没有标题字段，最能代表它的就是高亮那段原文；纯评论型标注退到评论。
 * 两者都空时返回空串，由 chip 构造处兜底成标注 key。
 */
export function annotationChipLabel(t: Translate, annotation: ZoteroAnnotation): string {
  const source = tidyAnnotation(annotation.text) || commentPlain(annotation.comment)
  if (source === '') return ''
  const chars = Array.from(source)
  const summary = chars.length > CHIP_LABEL_LIMIT
    ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…`
    : source
  return annotation.pageLabel === ''
    ? summary
    : `${summary}${tpl(t('cmp.annotation.pageTag'), { value: annotation.pageLabel })}`
}

/** 命名实体的最小集合（与 Host 清洗后的笔记 HTML 对齐）。 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: String.fromCharCode(38),
  lt: String.fromCharCode(60),
  gt: String.fromCharCode(62),
  quot: String.fromCharCode(34),
  apos: String.fromCharCode(39),
}

/** 解码 HTML 实体；未识别的实体原样保留。 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * 笔记 HTML → 纯文本：块级标签转换行、列表项加 `- `，剥标签后解码实体。
 *
 * 只保留段落与列表结构，图片等没有文本的可选内容自然消失。
 */
export function noteHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/(?:p|div|h[1-6]|blockquote|li|tr|ul|ol|table|figure|figcaption|pre)>/giu, '\n')
      .replace(/<li\b[^>]*>/giu, '- ')
      .replace(/<[^>]*>/gu, ''),
  )
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    // `<li>` 里常包着 `<p>`，块级换行会把列表标记顶成单独一行，这里并回去。
    .replace(/(^|\n)- *\n/gu, '$1- ')
    .replace(/\n{2,}(?=- )/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * 单条笔记的引用文本：所属条目 + 正文纯文本 + 截断提示 + 更新日期 + 笔记 key。
 */
export function noteText(t: Translate, detail: ZoteroItemDetail, note: ZoteroNote): string {
  const head = tpl(t('cmp.note.header'), { title: detail.title, key: detail.key })
  const body = noteHtmlToText(note.html)
  const lines = [head]
  if (body !== '') lines.push(body)
  if (note.truncated) lines.push(t('cmp.note.truncated'))
  const date = note.dateModified.slice(0, 10)
  if (date !== '') lines.push(tpl(t('cmp.note.date'), { value: date }))
  lines.push(tpl(t('cmp.note.key'), { value: note.key }))
  return lines.join('\n')
}

/** 条目清单里的一行（目录引用与标签引用共用）。 */
function itemLine(t: Translate, item: ZoteroItemSummary): string {
  const meta = [item.creators, item.year].filter((part) => part !== '').join(', ')
  return tpl(t('cmp.collection.line'), { title: item.title, meta })
}

/** 整目录的引用文本（标题清单 + 稳定标识）。 */
export function collectionText(
  t: Translate,
  collection: ZoteroCollection,
  items: ZoteroItemSummary[],
  total: number,
): string {
  const head = tpl(t('cmp.collection.header'), {
    name: collection.name,
    key: collection.key,
    n: total,
  })
  const preview = items.slice(0, COLLECTION_PREVIEW_LIMIT)
  const lines = preview.map((item) => itemLine(t, item))
  if (total > preview.length) {
    lines.push(tpl(t('cmp.collection.more'), { n: preview.length }))
  }
  return [head, ...lines].join('\n')
}

/** 标签名的展示形式。 */
const TAG_JOINER = '、'

/** 模式文案（全部 / 任一）。 */
function tagModeLabel(t: Translate, mode: 'all' | 'any'): string {
  return t(mode === 'any' ? 'tags.matchAny' : 'tags.matchAll')
}

/** 单个标签的引用文本：标签头 + 全库该标签下的条目清单。 */
export function tagText(
  t: Translate,
  name: string,
  items: ZoteroItemSummary[],
  total: number,
): string {
  const head = tpl(t('cmp.tag.header'), { name, n: total })
  const preview = items.slice(0, COLLECTION_PREVIEW_LIMIT)
  const lines = preview.map((item) => itemLine(t, item))
  if (total > preview.length) lines.push(tpl(t('cmp.tag.more'), { n: preview.length }))
  return [head, ...lines].join('\n')
}

/**
 * 多个标签的引用文本：标签头（含模式）+ 每个标签的计数 + 条目清单 + 缺失提示。
 *
 * `counts` 只含文库里仍存在的标签；`missing` 单列一行，不阻断其余内容。
 */
export function tagSetText(
  t: Translate,
  names: readonly string[],
  mode: 'all' | 'any',
  counts: ReadonlyMap<string, number>,
  missing: readonly string[],
  items: ZoteroItemSummary[],
  total: number,
): string {
  const head = tpl(t('cmp.tagSet.header'), {
    tags: names.join(TAG_JOINER),
    mode: tagModeLabel(t, mode),
    n: total,
  })
  const lines = [head]
  for (const name of names) {
    const count = counts.get(name)
    if (count !== undefined) lines.push(tpl(t('cmp.tagSet.tags'), { name, n: count }))
  }
  if (missing.length > 0) {
    lines.push(tpl(t('cmp.tagSet.missingSome'), { names: missing.join(TAG_JOINER) }))
  }
  const preview = items.slice(0, COLLECTION_PREVIEW_LIMIT)
  for (const item of preview) lines.push(itemLine(t, item))
  if (total > preview.length) lines.push(tpl(t('cmp.tagSet.more'), { n: preview.length }))
  return lines.join('\n')
}

/**
 * 标签组 chip 的标签：`标签：A、B（全部）`，过长时截断。
 *
 * chip 宽度有限，标签多时只保留开头，完整清单在提交后的展开文本里。
 */
export function tagSetChipLabel(t: Translate, names: readonly string[], mode: 'all' | 'any'): string {
  const label = tpl(t('cmp.tagSet.label'), {
    tags: names.join(TAG_JOINER),
    mode: tagModeLabel(t, mode),
  })
  const chars = Array.from(label)
  return chars.length > CHIP_LABEL_LIMIT
    ? `${chars.slice(0, CHIP_LABEL_LIMIT).join('')}…`
    : label
}

/**
 * 一批笔记 / 标注的汇总文本。
 *
 * 与单条引用不同，这里一个 chip 承载一整批（多篇、多条），因此：
 *
 * - 头部先写「第几批 / 共几批 + 本次合计 + 本批小计」，模型才知道自己拿到的是
 *   一份材料的一部分，不会把第 2 批当成另一项研究；
 * - 任务说明只写在**第 1 批**开头，多批重复写会把每批的正文往后推；
 * - 同一篇被拆到两批时，续批的篇头标「（续）」、段头写「续，本篇共 N 条」——
 *   缺了这个标记，模型会把同一项研究的前后两段当成两项。
 * - 提交时被删的条目用 ⚠️ 独立行写明；一行轻描淡写的括号会被模型当噪音跳过。
 */
export interface AnnotationSetOverall {
  /** 有内容、实际进入批次的篇数（「共 N 篇」）。 */
  papers: number
  annotations: number
  notes: number
  chars: number
  /** 提交时已不在文库的条目数（标注 + 笔记）。 */
  missingItems: number
  /** 提交时已不在文库的篇数。 */
  missingPapers: number
}

export interface AnnotationSetContext {
  /** 本批序号，1 基。 */
  index: number
  total: number
  /** 本批覆盖第几篇到第几篇（1 基，按传入顺序）。 */
  from: number
  to: number
  overall: AnnotationSetOverall
}

/** 汇总 chip 的标签：`笔记与标注 1/3 · 5 篇`。 */
export function annotationSetChipLabel(
  t: Translate,
  index: number,
  total: number,
  papers: number,
): string {
  return tpl(t('digest.chip'), { i: index, n: total, p: papers })
}

/** 标注类型的展示名；未知类型原样给出（与列表口径一致）。 */
function annotationTypeLabel(t: Translate, type: string): string {
  const key = `annotation.type.${type}`
  const label = t(key)
  return label === key ? type : label
}

/** 一条标注的页码：优先印刷页码，其次 PDF 文件页。 */
function annotationPage(annotation: ZoteroAnnotation): string {
  if (annotation.pageLabel !== '') return annotation.pageLabel
  return annotation.position === null ? '' : String(annotation.position.pageIndex + 1)
}

/**
 * 分段的「续」后缀。
 *
 * 只有本篇被拆开时才出现：读者（模型）必须知道这一段的上下文与总数，
 * 否则会把「第 2 段 8 条」当成这一篇的全部。
 */
function sectionPart(t: Translate, continued: boolean, hasMore: boolean, total: number): string {
  if (!continued && !hasMore) return ''
  if (continued && hasMore) return tpl(t('digest.cmp.partBoth'), { n: total })
  if (continued) return tpl(t('digest.cmp.partContinued'), { n: total })
  return tpl(t('digest.cmp.partMore'), { n: total })
}

/** 一篇的块头 + 标注段 + 笔记段。 */
function digestPaperText(t: Translate, paper: DigestPaper): { text: string; warnings: string[] } {
  const warnings: string[] = []
  const head = tpl(t('digest.cmp.paper'), {
    title: paper.title,
    key: paper.key,
    creators: paper.creators,
    year: paper.year,
  })
  const lines = [paper.continued ? head + t('digest.cmp.continuedMark') : head]

  const commented = paper.annotations.filter((annotation) => commentPlain(annotation.comment) !== '').length
  if (paper.annotations.length > 0) {
    lines.push(tpl(t('digest.cmp.annLine'), {
      n: paper.annotations.length,
      m: commented,
      part: sectionPart(t, paper.continued, paper.hasMore, paper.annotationTotal),
    }))
    for (const annotation of paper.annotations) {
      const page = annotationPage(annotation)
      const type = annotationTypeLabel(t, annotation.type)
      const quote = tidyAnnotation(annotation.text)
      const comment = commentPlain(annotation.comment)
      const prefix = page === ''
        ? tpl(t('digest.cmp.lineNoPage'), { type })
        : tpl(t('digest.cmp.line'), { page, type })
      lines.push(prefix + (quote !== '' ? quote : comment !== '' ? comment : '（无原文）'))
      if (comment !== '' && quote !== comment) {
        lines.push(`  ${tpl(t('digest.cmp.comment'), { value: comment })}`)
      }
      const target = makeEvidence(paper.key, {
        attachmentKey: annotation.attachmentKey,
        annotationKey: annotation.key,
        page: annotation.position === null ? undefined : annotation.position.pageIndex + 1,
        pageLabel: annotation.pageLabel || undefined,
      })
      lines.push(`  ${tpl(t('digest.cmp.evidence'), {
        link: evidenceLink(target),
        page: page === '' ? '' : tpl(t('digest.cmp.evidencePage'), { page }),
      })}`)
    }
  }

  if (paper.notes.length > 0) {
    lines.push(tpl(t('digest.cmp.noteLine'), {
      n: paper.notes.length,
      part: sectionPart(t, paper.continued, paper.hasMore, paper.noteTotal),
    }))
    for (const note of paper.notes) {
      const body = noteHtmlToText(note.html)
      const date = note.dateModified.slice(0, 10)
      lines.push(tpl(t('digest.cmp.noteMeta'), {
        title: note.title || note.key,
        chars: Array.from(body).length,
        date,
        key: note.key,
      }))
      lines.push(`  ${tpl(t('digest.cmp.noteBody'), { value: body })}`)
      if (note.truncated) {
        warnings.push(tpl(t('digest.cmp.noteTruncated'), { title: note.title || note.key }))
      }
    }
  }

  return { text: lines.join('\n'), warnings }
}

export function annotationSetText(
  t: Translate,
  batch: DigestBatch,
  ctx: AnnotationSetContext,
): string {
  const blocks: string[] = []
  if (ctx.index === 1) blocks.push(t('digest.cmp.instructions'))

  blocks.push([
    tpl(t('digest.cmp.header'), { i: ctx.index, n: ctx.total, a: ctx.from, b: ctx.to, p: ctx.overall.papers }),
    tpl(t('digest.cmp.subtotal'), {
      a: ctx.overall.annotations,
      n: ctx.overall.notes,
      chars: ctx.overall.chars.toLocaleString(),
      ba: batch.annotations,
      bn: batch.notes,
    }),
  ].join('\n'))

  const warnings: string[] = []
  for (const paper of batch.papers) {
    const compiled = digestPaperText(t, paper)
    blocks.push(compiled.text)
    warnings.push(...compiled.warnings)
  }

  // 全局口径只写在第 1 批：多批重复会稀释正文，而覆盖范围是「整组」的信息。
  if (ctx.index === 1) {
    if (ctx.overall.missingPapers > 0) {
      warnings.push(tpl(t('digest.cmp.missingPapers'), { n: ctx.overall.missingPapers }))
    }
    if (ctx.overall.missingItems > 0) {
      warnings.push(tpl(t('digest.cmp.missingItems'), { n: ctx.overall.missingItems }))
    }
  }

  if (warnings.length > 0) blocks.push(warnings.map((warning) => `⚠️ ${warning}`).join('\n'))
  return blocks.join('\n\n')
}
