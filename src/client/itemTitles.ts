/**
 * 条目 tab 的标题缓存（按条目 key 索引）。
 *
 * 为什么不能只靠 navigation.params：右侧栏布局的持久化 schema 只存
 * `{ id, kind, contentId, title }`，**不含 `navigation.params`**（见
 * `@deepseek-ai/dsh-client-ui-sidebar-right` 的 persistence 校验）。刷新页面、
 * 切会话后布局被恢复时，框架用 `{ address: contentId, params: undefined }` 重建
 * 每个 tab 的 occurrence —— 打开时随 `openResource(..., { params: { title } })`
 * 递进来的文献标题就此丢失，标题席位只能退回兜底文案「Zotero 条目」。
 *
 * 所以标题以「条目 key 本身就是标题来源」为准：写一份缓存，缺了就按 key 现取
 * 一次。打开时顺手写入（那一刻已知标题，首帧就对），刷新/恢复后由标题席位补取。
 */

import { useEffect, useState } from 'react'

import { fetchItem } from './api'

/** key → 标题。条目 key 在 Zotero 里稳定，标题改了也只是这次会话里旧一拍。 */
const titles = new Map<string, string>()

/** 在途的 key：同一 key 的补取只发一次（标题席位与正文可能同时触发）。 */
const inflight = new Set<string>()

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** 已缓存的标题；未知返回 `undefined`（调用方自己决定兜底文案）。 */
export function getItemTitle(key: string): string | undefined {
  return titles.get(key)
}

/** 记下一条标题；空标题不入缓存（宁可用兜底文案，也不显示空白 tab）。 */
export function rememberItemTitle(key: string, title: string): void {
  if (key === '' || title === '' || titles.get(key) === title) return
  titles.set(key, title)
  notify()
}

/** 订阅标题变化（任一 key 变化都会触发；调用方自己比对）。 */
export function subscribeItemTitles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 补取一条标题（fire-and-forget）。
 *
 * 失败不处理：正文那边会自己报加载错误，标题退回兜底文案就够了——为一个
 * tab 标题弹提示反而吵。
 */
export function ensureItemTitle(key: string): void {
  if (key === '' || titles.has(key) || inflight.has(key)) return
  inflight.add(key)
  fetchItem(key)
    .then((detail) => {
      rememberItemTitle(key, detail.title)
    })
    .catch(() => {
      // 见上：标题取不到不算错误。
    })
    .finally(() => {
      inflight.delete(key)
    })
}

/** 订阅某条目的标题；`key` 为 `null` 时恒为 `undefined`。 */
export function useItemTitle(key: string | null): string | undefined {
  const [title, setTitle] = useState(() => (key === null ? undefined : getItemTitle(key)))

  useEffect(() => {
    if (key === null) {
      setTitle(undefined)
      return
    }
    setTitle(getItemTitle(key))
    return subscribeItemTitles(() => setTitle(getItemTitle(key)))
  }, [key])

  return title
}
