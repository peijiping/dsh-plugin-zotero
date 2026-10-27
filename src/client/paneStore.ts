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
  ZoteroItemScope,
  ZoteroItemSummary,
} from '../zotero/types'
import { fetchCollectionBib, fetchHealth, fetchItem, fetchItems, fetchTree } from './api'

/** 搜索防抖时长。 */
const SEARCH_DEBOUNCE_MS = 250

/** 搜索结果条数上限。 */
const SEARCH_LIMIT = 100

/** 分类树每个节点一次最多拉取的条目数。 */
const NODE_LIMIT = 200

/** 提示条停留时长。 */
const TOAST_MS = 3000

/** 文库根节点的 id（只存在于客户端，不对应任何 Zotero 分类）。 */
export const TREE_ROOT_ID = '__library__'

/** 拉取某节点条目所需的定位信息。 */
export interface TreeNodeTarget {
  collectionKey?: string
  scope?: ZoteroItemScope
}

export interface PaneState {
  health: ZoteroHealth | null
  libraryName: string
  collections: ZoteroCollection[]
  treeError: string | null
  treeLoading: boolean
  /** 分类树是否已成功拉取过；用于避免切会话时重复取数。 */
  loaded: boolean
  /** 分类树中已展开的节点 id；放在 store 里，面板被重新挂载后仍然保留。 */
  expanded: ReadonlySet<string>
  /** 已拉取条目的节点缓存（节点 id → 条目列表）。 */
  nodeItems: Record<string, ZoteroItemSummary[]>
  /** 已拉取节点的条目总数（节点 id → 总数）。 */
  nodeTotals: Record<string, number>
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
    expanded: new Set([TREE_ROOT_ID]),
    nodeItems: {},
    nodeTotals: {},
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
const nodeInflight = new Set<string>()
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

/** 按需拉取某节点的条目；已拉取或正在拉取时直接返回。 */
function loadNodeItems(nodeId: string, target: TreeNodeTarget): void {
  if (state.nodeItems[nodeId] !== undefined || nodeInflight.has(nodeId)) return
  nodeInflight.add(nodeId)
  fetchItems({ ...target, limit: NODE_LIMIT })
    .then((data) => {
      patch({
        nodeItems: { ...state.nodeItems, [nodeId]: data.items },
        nodeTotals: { ...state.nodeTotals, [nodeId]: data.total },
      })
    })
    .catch(() => {
      patch({
        nodeItems: { ...state.nodeItems, [nodeId]: [] },
        nodeTotals: { ...state.nodeTotals, [nodeId]: 0 },
      })
    })
    .finally(() => {
      nodeInflight.delete(nodeId)
    })
}

/** 三角箭头：只开合节点，展开时按需拉取条目（根节点没有条目，不传 target）。 */
export function toggleTreeNode(nodeId: string, target?: TreeNodeTarget): void {
  const willOpen = !state.expanded.has(nodeId)
  const expanded = new Set(state.expanded)
  if (willOpen) expanded.add(nodeId)
  else expanded.delete(nodeId)
  patch({ expanded })
  if (willOpen && target !== undefined) loadNodeItems(nodeId, target)
}

/** 选中分类时调用：确保节点展开且条目已拉取。 */
export function expandTreeNode(nodeId: string, target: TreeNodeTarget): void {
  if (!state.expanded.has(nodeId)) patch({ expanded: new Set(state.expanded).add(nodeId) })
  loadNodeItems(nodeId, target)
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

/** 选中分类并拉取该目录的引用（APA）；虚拟分类（出版物/未分类/回收站）不导出引用。 */
export function selectCollection(collection: ZoteroCollection): void {
  if (collection.scope !== undefined) {
    patch({
      selectedItemKey: null,
      detail: null,
      selectedCollection: collection,
      collectionBib: '',
    })
    return
  }
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
  nodeInflight.clear()
  state = initialState()
  for (const listener of listeners) listener()
}
