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

import type { Translate } from './locales'
import { tpl } from './locales'
import { ApiFailure, fetchItem, fetchItems, fetchTags, fetchTree } from './api'
import {
  COLLECTION_PREVIEW_LIMIT,
  annotationText,
  collectionText,
  itemText,
  noteText,
  tagSetText,
  tagText,
} from './compose'

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
  const { parentKey, childKey } = parseChildRef(body)
  let detail
  try {
    detail = await fetchItem(parentKey, 'apa', signal)
  } catch (error) {
    if (isMissing(error)) return tpl(t('cmp.missing.annotation'), { key: childKey })
    throw error
  }
  const annotation = detail.annotations.find((child) => child.key === childKey)
  if (annotation === undefined) return tpl(t('cmp.missing.annotation'), { key: childKey })
  return annotationText(t, detail, annotation)
}

/** 解码标签名；ref 结构坏了直接抛出（不是「对象已删除」）。 */
function decodeTagName(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new Error(`无法识别的 Zotero 标签引用：${encoded}`)
  }
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
