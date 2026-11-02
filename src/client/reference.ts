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

import type { Translate } from './locales'
import type { InsertionSpan } from './inline'
import { annotationCitation, collectionCitation, itemCitation, noteCitation } from './cite'

/**
 * 写进 chip 的持久标识：一旦发布就不能改名，老草稿里的 chip 靠它找回 codec。
 */
export const REF_SOURCE = 'zotero'

const ITEM_PREFIX = 'item:'
const COLLECTION_PREFIX = 'col:'
const NOTE_PREFIX = 'note:'
const ANNOTATION_PREFIX = 'ann:'

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
  if (ref.startsWith(COLLECTION_PREFIX)) return collectionCitation(t, ref.slice(COLLECTION_PREFIX.length), signal)
  if (ref.startsWith(NOTE_PREFIX)) return noteCitation(t, ref.slice(NOTE_PREFIX.length), signal)
  if (ref.startsWith(ANNOTATION_PREFIX)) {
    return annotationCitation(t, ref.slice(ANNOTATION_PREFIX.length), signal)
  }
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
      serialize: (ref, signal) => citationForRef(t, ref, signal),
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
export function annotationReference(parentKey: string, annotationKey: string, label: string): ReferenceInsert {
  return reference(childPrefix(ANNOTATION_PREFIX, parentKey), annotationKey, label, 'file')
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
