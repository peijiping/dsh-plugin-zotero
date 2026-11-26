/**
 * Zotero 引用 chip（宿主的 ReferenceInsert 机制）。
 *
 * 侧栏点「引用」不再往输入框灌一大段纯文本，而是插一个胶囊样式的 chip；
 * 真正的文本在提交那一刻由这里的 `codec.serialize` 现取现拼（见 cite.ts），
 * 所以输入框干净、模型拿到的内容和以前完全一样。
 *
 * 两件事需要留意：
 *
 * 1. **必须注册一个 input-trigger 源**，哪怕我们根本不进 `@` 菜单。宿主按
 *    chip 的 `source` 去源注册表找 codec，找不到就 reject 整次发送。注册表是
 *    codec 的唯一入口。`candidates()` 恒空即可——空候选的源在菜单里整组不渲染。
 * 2. **插 chip 走的是会话事件 `slash/input-insert-reference`**，它在宿主的类型
 *    契约里已声明（`dsh-client-ui-conversation/client` 的 Events 增强），但没有
 *    作为插件 API 文档化；官方 `dsh-client-ui-commands` 有同类用法先例。宿主升级
 *    若改名或改语义，全项目只有 {@link insertChip} 这一处需要跟着改。
 */

import { isReviewEvidenceRun } from '../zotero/review-evidence-types'
import type { Translate } from './locales'
import { makeEvidence, type EvidenceLocation } from './evidence'
import type { InsertionSpan } from './inline'
import {
  annotationCitation,
  annotationSetCitation,
  attachmentCitation,
  type AttachmentCitation,
  collectionCitation,
  excerptCitation,
  fulltextCitation,
  itemCitation,
  noteCitation,
  reviewCitation,
  type ReviewSource,
  shotCitation,
  tagCitation,
  tagSetCitation,
  translationCitation,
} from './cite'
import { MAX_SHOT_REF_CHARS } from './viewer/shot/types'
import type { ShotMeta } from './viewer/shot/types'

/**
 * 写进 chip 的持久标识：一旦发布就不能改名，老草稿里的 chip 靠它找回 codec。
 */
export const REF_SOURCE = 'zotero'

/**
 * 模型文本里引用块的起止标记。
 *
 * codec 展开出来的是一大段引用，会话历史读到的是这份文本；要让历史也收成胶囊，
 * 就必须有稳定的块边界——摘录 / 笔记的正文可以是任意文本，只靠行首格式猜边界
 * 会把用户自己写的话也吞进胶囊。标签对模型无歧义，只多占一行。
 */
export const CITATION_OPEN = '<zotero-ref>'
export const CITATION_CLOSE = '</zotero-ref>'

/** 把引用文本包成模型文本里的一个带边界的块（见 {@link CITATION_OPEN}）。 */
export function wrapCitation(text: string): string {
  return `${CITATION_OPEN}\n${text}\n${CITATION_CLOSE}\n`
}

const ITEM_PREFIX = 'item:'
const COLLECTION_PREFIX = 'col:'
const NOTE_PREFIX = 'note:'
const ANNOTATION_PREFIX = 'ann:'
/**
 * 一批笔记 / 标注的汇总：`annset:<编码后的 JSON>`。
 *
 * 与 `full:` 不同，ref 存的是**用户勾选的条目 key 清单**，而不是范围：弹层里
 * 逐条勾选之后，「这篇 12 条里不要第 3、7 条」这种减法没法用范围表达式表达。
 * 内容本身仍然在提交时现取（key 找不到就记一笔），所以草稿放几天也不会
 * 把旧文本发给模型。
 *
 * 一个 chip 只装一批：分批在插入时切好（见 `annotationDigest.packBatches`），
 * 因为「分几枚 chip」必须插入那一刻就定下来，而 codec 只能在提交时被调用。
 */
const ANNSET_PREFIX = 'annset:'
/**
 * 全文引用：`full:<编码后的 itemKey>:<范围表达式>`。
 *
 * 与条目 chip 同属「现取类」：ref 只存 key + 范围，正文在提交时由 codec 现取
 * 并按范围切片，不把 20 万字正文编码进草稿。范围表达式有两种形态：
 * `all`（整篇）、`c:start:end` / `o:start:end`（字符或偏移）、`h:起:止`（标题）、
 * `p:起页:止页:总页:标题列表`（PDF 书签章节，标题用 `+` 分隔）。
 *
 * 解析不能按 `:` 全拆——范围表达式自身含 `:`。约定第一段是 key、其余整体是
 * 表达式，交给 `fulltextCitation` 拆；key 是 Zotero key，天然不含 `:`。
 */
const FULLTEXT_PREFIX = 'full:'
const ATTACHMENT_FULLTEXT_PREFIX = 'full2:'
const REVIEW_PREFIX = 'review:'
/**
 * 划选摘录：`exc:<编码后的 itemKey>:<编码后的标题>:<编码后的原文>`。
 *
 * 与按 key 现取的引用不同，摘录是插入那一刻定格的文本，文库里根本没有对应对象，
 * 所以三段数据全部自包含在 ref 里：草稿跨重启恢复后照样能展开，也不依赖 Zotero 在线。
 * `encodeURIComponent` 把 `:` 与所有空白都编码掉，用 `:` 分段不会歧义。
 */
const EXCERPT_PREFIX = 'exc:'
/**
 * 划词翻译：`tr:<编码后的 itemKey>:<编码后的标题>:<编码后的原文>:<编码后的译文>`。
 *
 * 和摘录同理由：译文只存在于插入那一刻，文库里没有对应对象，四段全自包含。
 */
const TRANSLATION_PREFIX = 'tr:'
/** 单个标签：`tag:<编码后的标签名>`。 */
const TAG_PREFIX = 'tag:'
/** 标签组：`tags:<all|any>:<编码后的标签名>,…`。 */
const TAG_SET_PREFIX = 'tags:'
/**
 * 一次截图的出处：`shot:<key>:<title>:<byline>:<pages>:<section>:<digest>:<shotId>`。
 *
 * 7 段全部 `encodeURIComponent`，与 `exc:` / `tr:` 一样自包含、不请求 Host、
 * 草稿跨重启可展开。图片本体走宿主附件通道，这里只存「哪个文献、哪一部分」。
 */
const SHOT_PREFIX = 'shot:'

/** 一次最多引用的标签数（防止 URL 与提示文本过长）。 */
export const MAX_TAG_REFERENCE = 20

/**
 * 单段摘录的字符上限。
 *
 * ref 与 chip 的 clipboardText 都会带着编码后的原文存进会话草稿，划选整页时
 * 不做限制会把草稿撑到几十万字符。超限时提示缩小选区，不静默截断原文。
 */
export const MAX_EXCERPT_CHARS = 4000

/** 笔记 / 标注是子条目，单靠自身 key 取不到所属条目，ref 存「父 key/子 key」。 */
const REF_SEPARATOR = '/'

/** chip 的结构（宿主 ReferenceInsert 中本插件用到的部分）。 */
export interface ReferenceInsert {
  source: string
  ref: string
  label: string
  appearance?: 'session' | 'file' | 'folder'
  clipboardText: string
}

/** 插入请求：chip + 目标选区（宿主 InsertReferenceRequest）。 */
export interface InsertReferenceRequest {
  reference: ReferenceInsert
  span: InsertionSpan
}

/** 会话作用域 ctx 中插 chip 用到的那部分。 */
export interface InputScopedContext {
  bail(thisArg: unknown, name: 'slash/input-insert-reference', request: InsertReferenceRequest): true | undefined
}

/** `ctx.sessions` 中插 chip 用到的那部分。 */
export interface SessionsFace {
  scope(id: string): InputScopedContext | undefined
}

/** 引用源的 codec（宿主 ReferenceCodec）。 */
export interface ReferenceCodec {
  clipboardText(ref: string): string
  serialize(ref: string, signal: AbortSignal): Promise<string>
}

/** 宿主 InputTriggerSource 中本插件实现的部分；其余钩子不实现即不参与。 */
export interface ZoteroTriggerSource {
  readonly trigger: '@'
  readonly name: string
  readonly codec: ReferenceCodec
  candidates(): Promise<readonly never[]>
  onPick(): undefined
}

/** 按 ref 前缀分派到对应的引用文本构建。 */
export function citationForRef(t: Translate, ref: string, signal: AbortSignal): Promise<string> {
  if (ref.startsWith(ITEM_PREFIX)) return itemCitation(t, ref.slice(ITEM_PREFIX.length), signal)
  if (ref.startsWith(ATTACHMENT_FULLTEXT_PREFIX)) {
    const source: AttachmentCitation = JSON.parse(decodeURIComponent(ref.slice(ATTACHMENT_FULLTEXT_PREFIX.length)))
    return attachmentCitation(t, source, signal)
  }
  if (ref.startsWith(REVIEW_PREFIX)) {
    const value: ReviewSource[] | { run: string; sources: ReviewSource[] } =
      JSON.parse(decodeURIComponent(ref.slice(REVIEW_PREFIX.length)))
    if (Array.isArray(value)) return reviewCitation(t, value, signal)
    if (!isReviewEvidenceRun(value.run) || !Array.isArray(value.sources)) throw new Error('Invalid review reference')
    return reviewCitation(t, value.sources, signal, value.run)
  }
  if (ref.startsWith(FULLTEXT_PREFIX)) return fulltextCitation(t, ref.slice(FULLTEXT_PREFIX.length), signal)
  if (ref.startsWith(COLLECTION_PREFIX)) return collectionCitation(t, ref.slice(COLLECTION_PREFIX.length), signal)
  if (ref.startsWith(NOTE_PREFIX)) return noteCitation(t, ref.slice(NOTE_PREFIX.length), signal)
  if (ref.startsWith(ANNSET_PREFIX)) return annotationSetCitation(t, ref.slice(ANNSET_PREFIX.length), signal)
  if (ref.startsWith(ANNOTATION_PREFIX)) {
    return annotationCitation(t, ref.slice(ANNOTATION_PREFIX.length), signal)
  }
  if (ref.startsWith(EXCERPT_PREFIX)) return excerptCitation(t, ref.slice(EXCERPT_PREFIX.length))
  if (ref.startsWith(TRANSLATION_PREFIX)) {
    return translationCitation(t, ref.slice(TRANSLATION_PREFIX.length))
  }
  if (ref.startsWith(TAG_SET_PREFIX)) return tagSetCitation(t, ref.slice(TAG_SET_PREFIX.length), signal)
  if (ref.startsWith(TAG_PREFIX)) return tagCitation(t, ref.slice(TAG_PREFIX.length), signal)
  if (ref.startsWith(SHOT_PREFIX)) return shotCitation(t, ref.slice(SHOT_PREFIX.length))
  return Promise.reject(new Error(`无法识别的 Zotero 引用：${ref}`))
}

export function createZoteroSource(t: Translate): ZoteroTriggerSource {
  return {
    trigger: '@',
    name: REF_SOURCE,
    // 恒空：本插件不进 @ 菜单，注册只为让 chip 有 codec 可展开。
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    codec: {
      clipboardText: (ref) => `@${ref}`,
      serialize: async (ref, signal) => wrapCitation(await citationForRef(t, ref, signal)),
    },
  }
}

function reference(prefix: string, key: string, title: string, appearance: 'file' | 'folder'): ReferenceInsert {
  const ref = `${prefix}${key}`
  return {
    source: REF_SOURCE,
    ref,
    label: title === '' ? key : title,
    appearance,
    // clipboardText 是 chip 在草稿里占的那段文本，必须无空格，否则偏移量与
    // 「草稿中该段等于 clipboardText」的还原校验会错位。
    clipboardText: `@${ref}`,
  }
}

/** 一条文献的 chip。 */
export function itemReference(key: string, title: string): ReferenceInsert {
  return reference(ITEM_PREFIX, key, title, 'file')
}

/**
 * 一段全文的 chip。
 *
 * `range` 是范围表达式（见 {@link FULLTEXT_PREFIX}），连同 key 一起存进 ref；
 * key 先 `encodeURIComponent`（Zotero key 本身安全，但保持与其余 chip 一致）。
 * `label` 是胶囊上显示的短标签，由调用方给出（如「全文」或「3 Method」）。
 */
export function fulltextReference(key: string, title: string, range: string, label: string): ReferenceInsert {
  const ref = `${FULLTEXT_PREFIX}${encodeURIComponent(key)}:${range}`
  return {
    source: REF_SOURCE,
    ref,
    label,
    appearance: 'file',
    clipboardText: `@${ref}`,
  }
}

export function attachmentFulltextReference(source: AttachmentCitation, label: string): ReferenceInsert {
  return reference(ATTACHMENT_FULLTEXT_PREFIX, encodeURIComponent(JSON.stringify(source)), label, 'file')
}

export function reviewReference(sources: readonly ReviewSource[], label: string, run: string): ReferenceInsert {
  return reference(REVIEW_PREFIX, encodeURIComponent(JSON.stringify({ run, sources })), label, 'folder')
}

/** 一个目录的 chip。 */
export function collectionReference(key: string, name: string): ReferenceInsert {
  return reference(COLLECTION_PREFIX, key, name, 'folder')
}

/** 子条目的 ref 前缀：`note:<父 key>/` 形式，后半段由 {@link reference} 拼上子 key。 */
function childPrefix(prefix: string, parentKey: string): string {
  return `${prefix}${parentKey}${REF_SEPARATOR}`
}

/**
 * 一条笔记的 chip。
 *
 * `parentKey` 必须是面板当前条目的 key——独立笔记时它就是笔记自身，
 * codec 用 `fetchItem(parentKey)` 复现笔记列表，与面板取数路径一致才找得到。
 */
export function noteReference(parentKey: string, noteKey: string, title: string): ReferenceInsert {
  return reference(childPrefix(NOTE_PREFIX, parentKey), noteKey, title, 'file')
}

/** 一条标注（高亮 / 划线）的 chip。 */
export function annotationReference(parentKey: string, annotationKey: string, label: string, location: EvidenceLocation): ReferenceInsert {
  const evidence = makeEvidence(parentKey, { ...location, annotationKey })
  const id = `${annotationKey}:${encodeURIComponent(JSON.stringify(evidence))}`
  return reference(childPrefix(ANNOTATION_PREFIX, parentKey), id, label, 'file')
}

/**
 * 一批笔记 / 标注的汇总引用。
 *
 * `papers[].anns` / `notes` 是用户勾选的子条目 key：只有这些会进投递包，
 * 其余即便库里新增也不会混进来（勾选是意图，不能被后续写入覆盖）。
 */
export interface AnnotationSetRef {
  v: 2
  papers: {
    key: string
    /** 标注 key，按页序。 */
    anns: string[]
    /** 笔记 key，按更新时间倒序。 */
    notes: string[]
    /** 本篇被选中的总数（跨批），供续批写「本篇共 N 条」。 */
    annTotal?: number
    noteTotal?: number
    /** 此篇在此前批次中已有几条证据。旧草稿不含此字段。 */
    evidenceOffset?: number
  }[]
  /** 本批序号 / 总批数，1 基。 */
  batch: [number, number]
  /** 本批覆盖第几篇到第几篇（1 基，按整组的顺序）。 */
  range: [number, number]
  /** 整组规模：有内容篇数、标注数、笔记数、字符数。 */
  total: [number, number, number, number]
  /** 本批里属于「上一篇的续」的条目 key。 */
  continued?: string[]
  /** 本批之后还有内容的条目 key（供文本写「其余见下批」）。 */
  more?: string[]
}

/**
 * ref body 的编解码：JSON → base64url。
 *
 * 不用 `encodeURIComponent`：它会把 JSON 的 `{}[]",:` 全部转义成 `%XX`，
 * 400 条的清单从 4.6KB 涨到 11KB，草稿里三枚 chip 就三十多 KB。base64url 只膨胀
 * 1/3，且同样无空格、无 `:`，不会影响 chip 的偏移校验。
 */
function encodeRefBody(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

export function decodeRefBody(body: string): unknown {
  const binary = atob(body.replace(/-/gu, '+').replace(/_/gu, '/'))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function annotationSetReference(body: AnnotationSetRef, label: string): ReferenceInsert {
  return reference(ANNSET_PREFIX, encodeRefBody(body), label, 'file')
}

/**
 * 一段划选摘录的 chip。
 *
 * 原文原样编码进 ref，提交时由 {@link excerptCitation} 解码后重建完整引文；
 * `label` 只是胶囊上显示的短摘要，与展开文本无关。
 */
export function excerptReference(
  key: string,
  title: string,
  quote: string,
  label: string,
  location?: EvidenceLocation,
): ReferenceInsert {
  const evidence = makeEvidence(key, location)
  const ref = `${EXCERPT_PREFIX}${[key, title, quote, JSON.stringify(evidence)].map((part) => encodeURIComponent(part)).join(':')}`
  return {
    source: REF_SOURCE,
    ref,
    label,
    appearance: 'file',
    // 与其余 Zotero chip 同规则：草稿里这段文本必须无空格，否则 chip 的
    // 偏移校验会对不上。编码后的原文天然满足这一点。
    clipboardText: `@${ref}`,
  }
}

/**
 * 一段「原文 + 译文」的 chip。
 *
 * 四段全编码，理由同 {@link excerptReference}：译文只存在于插入那一刻。
 */
export function translationReference(
  key: string,
  title: string,
  quote: string,
  translated: string,
  label: string,
  location?: EvidenceLocation,
): ReferenceInsert {
  const evidence = makeEvidence(key, location)
  const ref = `${TRANSLATION_PREFIX}${
    [key, title, quote, translated, JSON.stringify(evidence)].map((part) => encodeURIComponent(part)).join(':')
  }`
  return {
    source: REF_SOURCE,
    ref,
    label,
    appearance: 'file',
    clipboardText: `@${ref}`,
  }
}

/**
 * 单个标签的 chip。
 *
 * 标签名可能含空格，`clipboardText` 必须无空格，所以先 `encodeURIComponent`。
 */
export function tagReference(name: string): ReferenceInsert {
  const ref = `${TAG_PREFIX}${encodeURIComponent(name)}`
  return {
    source: REF_SOURCE,
    ref,
    label: name,
    appearance: 'folder',
    clipboardText: `@${ref}`,
  }
}

/**
 * 多个标签合并成一个「标签组」chip。
 *
 * `encodeURIComponent` 会编码标签名里的 `,` / `:` / 空格，所以分隔符不会歧义；
 * `mode` 在插入时定格，之后切换面板的 AND/OR 不影响已有草稿。
 */
export function tagSetReference(
  names: readonly string[],
  mode: 'all' | 'any',
  label: string,
): ReferenceInsert {
  const ref = `${TAG_SET_PREFIX}${mode}:${names.map(encodeURIComponent).join(',')}`
  return {
    source: REF_SOURCE,
    ref,
    label,
    appearance: 'folder',
    clipboardText: `@${ref}`,
  }
}

/**
 * 一张截图的出处 chip。
 *
 * 图片本体由 `shot/inserter.ts` 作为图片附件挂进草稿，这里只放定位信息；发送时
 * `shotCitation` 把 7 段解码成给模型的说明文本。`MAX_SHOT_REF_CHARS` 按**编码后**
 * 长度算（`buildShotMeta` 已逐段夹取），仍超限就抛错，不静默截断出处。
 */
export function shotReference(meta: ShotMeta, label: string): ReferenceInsert {
  const ref = `${SHOT_PREFIX}${
    [meta.key, meta.title, meta.byline, meta.pages, meta.section, meta.digest, meta.shotId, JSON.stringify(makeEvidence(meta.key, meta.location))]
      .map((part) => encodeURIComponent(part)).join(':')
  }`
  if (ref.length > MAX_SHOT_REF_CHARS) {
    throw new Error(`Zotero 截图的出处信息过长：${ref.length} > ${MAX_SHOT_REF_CHARS}`)
  }
  return {
    source: REF_SOURCE,
    ref,
    label,
    appearance: 'file',
    clipboardText: `@${ref}`,
  }
}

/**
 * 把 chip 插进该会话的输入框。
 *
 * `thisArg` 必须显式传会话 ctx：cordis 的事件表挂在根 ctx 上，不带过滤参数会把
 * **所有**会话的监听器都跑一遍，第一个返回 true 的赢——多开几个会话就会插错地方。
 */
export function insertChip(
  sessions: SessionsFace,
  sessionId: string | undefined,
  reference: ReferenceInsert,
  span: InsertionSpan,
): boolean {
  const actx = sessionId === undefined ? undefined : sessions.scope(sessionId)
  if (!actx) return false
  return actx.bail(actx, 'slash/input-insert-reference', { reference, span }) === true
}
