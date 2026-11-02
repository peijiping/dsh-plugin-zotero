/**
 * 「Zotero key → 给模型的完整引用文本」。
 *
 * 侧栏插入的是引用 chip（输入框里只有一个胶囊），真正的文本在**提交那一刻**
 * 由引用源的 codec 回调这里生成。因此取数失败必须分两类处理：
 *
 * - 条目 / 目录已不在文库里 → 返回一行带 key 的标记。数据缺失不是故障，
 *   为它阻断发送会把用户困在输入框里。
 * - Zotero 没开、Host 不可达 → 抛出。宿主会还原草稿并提示，用户启动 Zotero
 *   后重发即可；静默降级成 `@item:KEY` 等于给模型发一个裸 key。
 */

import type { Translate } from './locales'
import { tpl } from './locales'
import { ApiFailure, fetchItem, fetchItems, fetchTree } from './api'
import { COLLECTION_PREVIEW_LIMIT, collectionText, itemText } from './compose'

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
