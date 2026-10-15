/**
 * 面板共享状态。
 *
 * 右侧栏是「每会话一个停靠面」，因此本插件的正文会被各会话各挂一份；把数据与
 * 选择状态放在这个模块级单例里，所有会话看到的就是同一块面板（切会话不重拉、
 * 选中项与搜索词都保留）。「添加到会话」仍走各实例自己的 `inputActions`。
 *
 * 状态只在 React 渲染之外更新（异步取数与定时器），所以用 useState + useEffect
 * 订阅即可，不依赖 useSyncExternalStore。
 */

import { useEffect, useState } from 'react'

import type {
  ZoteroCollection,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemSummary,
} from '../zotero/types'
import { fetchCollectionBib, fetchHealth, fetchItem, fetchItems, fetchTree } from './api'

/** 搜索防抖时长。 */
const SEARCH_DEBOUNCE_MS = 250

/** 搜索结果条数上限。 */
const SEARCH_LIMIT = 100

/** 提示条停留时长。 */
const TOAST_MS = 3000

export interface PaneState {
  health: ZoteroHealth | null
  libraryName: string
  collections: ZoteroCollection[]
  treeError: string | null
  treeLoading: boolean
  /** 分类树是否已成功拉取过；用于避免切会话时重复取数。 */
  loaded: boolean
  query: string
  results: ZoteroItemSummary[] | null
  selectedItemKey: string | null
  selectedCollection: ZoteroCollection | null
  detail: ZoteroItemDetail | null
  detailLoading: boolean
  collectionBib: string | null
  toast: string | null
}

function initialState(): PaneState {
  return {
    health: null,
    libraryName: '',
    collections: [],
    treeError: null,
    treeLoading: true,
    loaded: false,
    query: '',
    results: null,
    selectedItemKey: null,
    selectedCollection: null,
    detail: null,
    detailLoading: false,
    collectionBib: null,
    toast: null,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let state: PaneState = initialState()
const listeners = new Set<() => void>()
let treeInflight: Promise<void> | null = null
let searchTimer: number | null = null
let toastTimer: number | null = null

function patch(next: Partial<PaneState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** 订阅整份面板状态（任一字段变化都会触发重渲染）。 */
export function usePaneState(): PaneState {
  const [snapshot, setSnapshot] = useState(getPaneState)
  useEffect(() => subscribePane(() => setSnapshot(getPaneState())), [])
  return snapshot
}

export function getPaneState(): PaneState {
  return state
}

export function subscribePane(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function showToast(message: string): void {
  patch({ toast: message })
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => patch({ toast: null }), TOAST_MS)
}

/**
 * 拉取状态与分类树。
 *
 * @param force 手动刷新；默认只在首次成功前取数（共享 store 已加载就不再重拉）
 */
export function loadTree(force = false): Promise<void> {
  if (treeInflight !== null) return treeInflight
  if (!force && state.loaded) return Promise.resolve()
  patch({ treeLoading: true })
  const run = (async (): Promise<void> => {
    try {
      const [healthData, tree] = await Promise.all([fetchHealth(), fetchTree()])
      patch({
        health: healthData,
        collections: tree.collections,
        libraryName: tree.libraryName,
        treeError: null,
        loaded: true,
      })
    } catch (error) {
      patch({ treeError: errorMessage(error) })
    } finally {
      patch({ treeLoading: false })
      treeInflight = null
    }
  })()
  treeInflight = run
  return run
}

/** 更新搜索词并按防抖取数；清空时回到分类树。 */
export function setQuery(next: string): void {
  patch({ query: next })
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  const trimmed = next.trim()
  if (trimmed === '') {
    searchTimer = null
    patch({ results: null })
    return
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void fetchItems({ q: trimmed, limit: SEARCH_LIMIT })
      .then((data) => patch({ results: data.items }))
      .catch(() => patch({ results: [] }))
  }, SEARCH_DEBOUNCE_MS)
}

/** 打开条目详情。 */
export function openItem(key: string): void {
  patch({ selectedItemKey: key, detail: null, detailLoading: true })
  void fetchItem(key)
    .then((data) => patch({ detail: data }))
    .catch((error: unknown) => showToast(errorMessage(error)))
    .finally(() => patch({ detailLoading: false }))
}

/** 选中分类并拉取该目录的引用（APA）。 */
export function selectCollection(collection: ZoteroCollection): void {
  patch({
    selectedItemKey: null,
    detail: null,
    selectedCollection: collection,
    collectionBib: null,
  })
  void fetchCollectionBib(collection.key)
    .then((data) => patch({ collectionBib: data.bib }))
    .catch(() => patch({ collectionBib: '' }))
}

/** 插件卸载时清空，避免热重载后残留上一轮的选中项。 */
export function resetPaneStore(): void {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  searchTimer = null
  toastTimer = null
  treeInflight = null
  state = initialState()
  for (const listener of listeners) listener()
}
