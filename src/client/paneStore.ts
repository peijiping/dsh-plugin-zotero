/**
 * 面板共享状态。
 *
 * 右侧栏是「每会话一个停靠面」，本插件的正文会被各会话各挂一份；把数据与
 * 选择状态放在这个模块级单例里，所有会话看到的就是同一块面板（切会话不重拉、
 * 选中分类/搜索词/已选标签都保留）。「添加到会话」仍走各实例自己的 `inputActions`。
 *
 * 主面板 = 目录树 + 标签面板 + 条目列表；条目详情在独立 tab 里，状态不在这里。
 * 列表与标签请求都用「请求序号 + AbortController」防竞态：快速切分类、连续点标签时
 * 旧响应不能覆盖新结果。
 *
 * 目录树的「选中 + 展开」另存一份到 localStorage：模块状态只活到页面刷新为止，
 * 存档让刷新页面 / 重开面板后回到上次选中的目录。
 */

import { useEffect, useState } from 'react'

import type {
  ZoteroCollection,
  ZoteroHealth,
  ZoteroItemScope,
  ZoteroItemSummary,
  ZoteroTag,
} from '../zotero/types'
import { fetchHealth, fetchItems, fetchTagUsage, fetchTags, fetchTree } from './api'

/** 搜索防抖时长。 */
const SEARCH_DEBOUNCE_MS = 250

/** 条目列表每页条数。 */
const ITEMS_PAGE_SIZE = 50

/** 提示条停留时长。 */
const TOAST_MS = 3000

/** 列表排序的存储键（localStorage，跨会话与重启都记住）。 */
const SORT_KEY = 'dsh-plugin-zotero.itemSort'

/** 目录树状态的存储键：刷新页面 / 重开面板后回到上次选中的目录。 */
const TREE_STATE_KEY = 'dsh-plugin-zotero.treeState'

/** 合法的虚拟分类范围（存档里的 scope 不在其中就丢弃）。 */
const KNOWN_SCOPES: readonly ZoteroItemScope[] = ['library', 'publications', 'unfiled', 'trash']

/** 文库根节点的 id（只存在于客户端，不对应任何 Zotero 分类）。 */
export const TREE_ROOT_ID = '__library__'

/**
 * 条目列表排序：`none` 走 Zotero 原始顺序，其余按标题。
 *
 * 排序由 Host 转成 Zotero 本地 API 的 `sort=title&direction=` 参数，分页才连得起来
 * （只排已加载的那几页会串行错乱）。
 */
export type ItemSort = 'none' | 'asc' | 'desc'

function readSort(): ItemSort {
  try {
    const value = window.localStorage.getItem(SORT_KEY)
    return value === 'asc' || value === 'desc' ? value : 'none'
  } catch {
    return 'none'
  }
}

/**
 * 存档里的目录树状态。
 *
 * 只记 key 不记整棵节点：真实分类刷新后按 key 重查最新名字与条目数（分类会改名、
 * 条目数一定变了）。虚拟分类的名字来自界面文案，故连 name 一起存下，省得刷新后
 * 头部短暂空一行字。
 */
interface SavedTreeState {
  selected: { key: string; name: string; scope?: ZoteroItemScope } | null
  expanded: string[]
}

/** 读目录树存档；缺失、坏 JSON、结构不认识都退回「文库根 + 只展开根」。 */
function readTreeState(): SavedTreeState {
  const blank: SavedTreeState = { selected: null, expanded: [] }
  try {
    const raw = window.localStorage.getItem(TREE_STATE_KEY)
    if (raw === null) return blank
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return blank
    const record = parsed as { selected?: unknown; expanded?: unknown }
    const expanded = Array.isArray(record.expanded)
      ? record.expanded.filter((id): id is string => typeof id === 'string')
      : []
    const saved = record.selected as { key?: unknown; name?: unknown; scope?: unknown } | null | undefined
    if (saved === null || typeof saved !== 'object' || typeof saved.key !== 'string' || saved.key === '') {
      return { selected: null, expanded }
    }
    const scope = KNOWN_SCOPES.find((item) => item === saved.scope)
    return {
      selected: {
        key: saved.key,
        name: typeof saved.name === 'string' ? saved.name : '',
        ...(scope === undefined ? {} : { scope }),
      },
      expanded,
    }
  } catch {
    // 隐私模式禁用 localStorage / 存档是坏 JSON：都退回文库根，存档不能挡住面板。
    return blank
  }
}

/**
 * 把当前选中与展开写盘。
 *
 * 文库根是默认值，不存（存档为空即代表文库根），免得和「没有存档」两种状态打架。
 */
function saveTreeState(): void {
  const collection = state.selectedCollection
  const saved: SavedTreeState = {
    selected: collection === null || collection.key === TREE_ROOT_ID
      ? null
      : {
          key: collection.key,
          name: collection.name,
          ...(collection.scope === undefined ? {} : { scope: collection.scope }),
        },
    expanded: [...state.expanded],
  }
  try {
    window.localStorage.setItem(TREE_STATE_KEY, JSON.stringify(saved))
  } catch {
    // 隐私模式等禁用 localStorage 时忽略，本次会话内的选择仍然正确。
  }
}

/** 选中分类的祖先 key 链（由内到外）；结构异常时中断，避免死循环。 */
function ancestorKeys(collections: ZoteroCollection[], key: string): string[] {
  const byKey = new Map(collections.map((node) => [node.key, node]))
  const chain: string[] = []
  let node = byKey.get(key)
  while (node !== undefined && node.parentKey !== false) {
    if (chain.includes(node.parentKey)) break
    chain.push(node.parentKey)
    node = byKey.get(node.parentKey)
  }
  return chain
}

export interface PaneState {
  health: ZoteroHealth | null
  libraryName: string
  collections: ZoteroCollection[]
  treeError: string | null
  treeLoading: boolean
  /** 分类树是否已成功拉取过；用于避免切会话时重复取数。 */
  loaded: boolean
  /** 分类树中已展开的节点 id（只控制分类开合，不承载条目）。 */
  expanded: ReadonlySet<string>
  /** 左栏分类树的名称筛选词（纯客户端，只筛目录，不搜条目）。 */
  treeQuery: string

  /** 当前选择：文库根（key = TREE_ROOT_ID）/ 真实分类 / 虚拟分类。 */
  selectedCollection: ZoteroCollection | null
  /** 当前范围的条目列表（已按搜索词与标签筛选）。 */
  items: ZoteroItemSummary[]
  itemsTotal: number
  itemsLoading: boolean
  itemsError: string | null
  /** 列表里被点选的条目（单击选中、ctrl/cmd 加选，整目录引用按这批插 chip）。 */
  selectedItemKeys: ReadonlySet<string>

  /** 列表排序（全局生效，存 localStorage）。 */
  sort: ItemSort

  /** 文库级标签；`null` 表示还没成功拉取过。 */
  tags: ZoteroTag[] | null
  tagsLoading: boolean
  tagsError: string | null
  /** 标签面板内的名称过滤词（纯客户端）。 */
  tagQuery: string
  selectedTags: ReadonlySet<string>
  tagMode: 'all' | 'any'
  /**
   * 当前范围（分类子树 + 搜索词）内的标签用量：名称 → 范围内条目数。
   * `null` = 不分范围（选中文库根，或用量拉取失败），此时列出全库标签。
   */
  tagUsage: ReadonlyMap<string, number> | null
  /** 范围标签用量是否在途；切换分类时清空旧集合前先置 true。 */
  tagUsageLoading: boolean

  query: string
  toast: string | null
}

function initialState(): PaneState {
  // 刷新页面后模块会被重新求值，选择只能从存档里捞回来（分类树本身仍要重拉）。
  const saved = readTreeState()
  return {
    health: null,
    libraryName: '',
    collections: [],
    treeError: null,
    treeLoading: true,
    loaded: false,
    expanded: new Set([TREE_ROOT_ID, ...saved.expanded]),
    treeQuery: '',
    selectedCollection: saved.selected === null
      ? null
      : {
          key: saved.selected.key,
          name: saved.selected.name,
          parentKey: false,
          ...(saved.selected.scope === undefined ? {} : { scope: saved.selected.scope }),
        },
    items: [],
    itemsTotal: 0,
    itemsLoading: false,
    itemsError: null,
    selectedItemKeys: new Set(),
    sort: readSort(),
    tags: null,
    tagsLoading: false,
    tagsError: null,
    tagQuery: '',
    selectedTags: new Set(),
    tagMode: 'all',
    tagUsage: null,
    tagUsageLoading: false,
    query: '',
    toast: null,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let state: PaneState = initialState()
const listeners = new Set<() => void>()
let treeInflight: Promise<void> | null = null
let tagsInflight: Promise<void> | null = null
let searchTimer: number | null = null
let toastTimer: number | null = null
/** 条目列表请求序号与在途请求。 */
let itemsSeq = 0
let itemsAbort: AbortController | null = null
/** 标签用量请求序号与在途请求。 */
let usageSeq = 0
let usageAbort: AbortController | null = null

function patch(next: Partial<PaneState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/** 文库根节点的伪分类对象。 */
function libraryRoot(name: string): ZoteroCollection {
  return { key: TREE_ROOT_ID, name, parentKey: false }
}

/** 订阅整份面板状态（任一字段变化都会触发重渲染）。 */
export function usePaneState(): PaneState {
  const [snapshot, setSnapshot] = useState(getPaneState)
  useEffect(() => subscribePane(() => setSnapshot(getPaneState())), [])
  return snapshot
}

/** 只订阅提示条：条目 tab 没有理由跟着列表/标签状态重渲染。 */
export function useToast(): string | null {
  const [toast, setToast] = useState(() => getPaneState().toast)
  useEffect(() => subscribePane(() => setToast(getPaneState().toast)), [])
  return toast
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

// ---- 分类树 -----------------------------------------------------------------

/** 当前选择指向的查询范围参数（文库根不带 key/scope）。 */
function selectionQuery(): {
  scope?: ZoteroItemScope
  collectionKey?: string
} {
  const collection = state.selectedCollection
  if (collection === null || collection.key === TREE_ROOT_ID) return {}
  if (collection.scope !== undefined) return { scope: collection.scope }
  return { collectionKey: collection.key }
}

/**
 * 拉取状态与分类树。
 *
 * 成功后按 key 保留原选择（真实分类被删则回到文库根），再重拉条目列表；
 * 标签独立拉取，标签失败不拖垮树。
 *
 * @param force 手动刷新；默认只在首次成功前取数（共享 store 已加载就不再重拉）
 */
export function loadTree(force = false): Promise<void> {
  if (treeInflight !== null) return treeInflight
  if (!force && state.loaded) return Promise.resolve()
  patch({ treeLoading: true })
  void loadTags(force)

  const run = (async (): Promise<void> => {
    try {
      const [healthData, tree] = await Promise.all([fetchHealth(), fetchTree()])
      const previous = state.selectedCollection
      let selected: ZoteroCollection = libraryRoot(tree.libraryName)
      if (previous !== null) {
        if (previous.key === TREE_ROOT_ID) {
          selected = libraryRoot(tree.libraryName)
        } else if (previous.scope !== undefined) {
          selected = previous
        } else {
          selected = tree.collections.find((node) => node.key === previous.key)
            ?? libraryRoot(tree.libraryName)
        }
      }
      // 顺带把选中节点的祖先撑开：分类可能在 Zotero 里被挪到别的父级下，
      // 存档里的展开集不含新父级，不补的话刷新后选中项藏在折叠的父级里。
      const expanded = new Set(state.expanded)
      expanded.add(TREE_ROOT_ID)
      if (selected.key !== TREE_ROOT_ID && selected.scope === undefined) {
        for (const key of ancestorKeys(tree.collections, selected.key)) expanded.add(key)
      }
      patch({
        health: healthData,
        collections: tree.collections,
        libraryName: tree.libraryName,
        treeError: null,
        loaded: true,
        expanded,
        selectedCollection: selected,
      })
      // 选中的分类若已被删掉（回落到文库根），把回落结果写回存档。
      saveTreeState()
      reloadItems({ reset: true })
      loadTagUsage()
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

/** 三角箭头：只开合分类。 */
export function toggleTreeNode(nodeId: string): void {
  const expanded = new Set(state.expanded)
  if (expanded.has(nodeId)) expanded.delete(nodeId)
  else expanded.add(nodeId)
  patch({ expanded })
  saveTreeState()
}

/**
 * 分类树名称筛选（纯客户端，参照 Zotero 左栏的目录过滤）。
 *
 * 只筛目录名，不触发条目重新查询；展开状态照旧保留，清空筛选后恢复原样。
 */
export function setTreeQuery(text: string): void {
  if (state.treeQuery === text) return
  patch({ treeQuery: text })
}

/**
 * 选中分类（文库根 / 真实分类 / 虚拟分类）：重拉列表与范围标签。
 *
 * 切换范围时标签集也换了，已选标签与标签面板里的名称过滤一并清空，
 * 否则旧筛选会作用到新目录（多数情况下变成空列表）。
 */
export function selectCollection(collection: ZoteroCollection): void {
  const name = collection.key === TREE_ROOT_ID ? state.libraryName : collection.name
  const selected = collection.key === TREE_ROOT_ID
    ? libraryRoot(name === '' ? '我的文库' : name)
    : collection
  if (state.selectedCollection?.key === selected.key) return
  patch({
    selectedCollection: selected,
    items: [],
    itemsTotal: 0,
    itemsError: null,
    selectedTags: new Set(),
    tagQuery: '',
  })
  saveTreeState()
  reloadItems({ reset: true })
  loadTagUsage()
}

// ---- 搜索 -------------------------------------------------------------------

/** 更新搜索词并按防抖重拉当前范围（含标签用量）；清空时立即重拉。 */
export function setQuery(next: string): void {
  patch({ query: next })
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  if (next.trim() === '') {
    searchTimer = null
    reloadItems({ reset: true })
    loadTagUsage()
    return
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    reloadItems({ reset: true })
    loadTagUsage()
  }, SEARCH_DEBOUNCE_MS)
}

// ---- 标签 -------------------------------------------------------------------

/** 拉取全库标签；失败只记错误，不影响树与列表。 */
export function loadTags(force = false): Promise<void> {
  if (tagsInflight !== null) return tagsInflight
  if (!force && state.tags !== null) return Promise.resolve()
  patch({ tagsLoading: true })
  const run = (async (): Promise<void> => {
    try {
      const data = await fetchTags()
      patch({ tags: data.tags, tagsError: null })
    } catch (error) {
      patch({ tagsError: errorMessage(error) })
    } finally {
      patch({ tagsLoading: false })
      tagsInflight = null
    }
  })()
  tagsInflight = run
  return run
}

/** 点标签：切换选中并重拉列表（保留当前分类与搜索词）。 */
export function toggleTag(name: string): void {
  const selected = new Set(state.selectedTags)
  if (selected.has(name)) selected.delete(name)
  else selected.add(name)
  patch({ selectedTags: selected })
  reloadItems({ reset: true })
}

export function clearTags(): void {
  if (state.selectedTags.size === 0) return
  patch({ selectedTags: new Set() })
  reloadItems({ reset: true })
}

export function setTagMode(mode: 'all' | 'any'): void {
  if (state.tagMode === mode) return
  patch({ tagMode: mode })
  if (state.selectedTags.size > 0) reloadItems({ reset: true })
}

/** 标签面板的名称过滤（纯客户端）。 */
export function setTagQuery(text: string): void {
  if (state.tagQuery === text) return
  patch({ tagQuery: text })
}

export function retryTags(): void {
  void loadTags(true)
}

// ---- 条目列表 ---------------------------------------------------------------

/**
 * 重拉条目列表。
 *
 * 重置（切分类 / 改筛选）时连带清空选中项：列表都换了，留着旧选中会让
 * 「引用已选」插进不在眼前的条目。
 *
 * @param options.reset 清空当前列表与选中项
 * @param options.append 追加下一页（加载更多）
 */
export function reloadItems(options: { reset: boolean; append?: boolean }): void {
  if (itemsAbort !== null) itemsAbort.abort()
  const controller = new AbortController()
  itemsAbort = controller
  const current = ++itemsSeq
  const append = options.append === true && !options.reset
  const offset = append ? state.items.length : 0
  if (!append) patch({ items: [], itemsTotal: 0, itemsError: null, selectedItemKeys: new Set() })
  patch({ itemsLoading: true })

  const tags = [...state.selectedTags]
  fetchItems({
    ...selectionQuery(),
    q: state.query.trim(),
    tags: tags.length === 0 ? undefined : tags,
    tagMode: tags.length === 0 ? undefined : state.tagMode,
    sort: state.sort === 'none' ? undefined : 'title',
    direction: state.sort === 'none' ? undefined : state.sort,
    limit: ITEMS_PAGE_SIZE,
    offset,
  }, controller.signal)
    .then((data) => {
      if (current !== itemsSeq) return
      patch({
        items: append ? [...state.items, ...data.items] : data.items,
        itemsTotal: data.total,
        itemsError: null,
      })
    })
    .catch((error: unknown) => {
      if (current !== itemsSeq || controller.signal.aborted) return
      patch({ itemsError: errorMessage(error) })
    })
    .finally(() => {
      if (current !== itemsSeq) return
      patch({ itemsLoading: false })
      if (itemsAbort === controller) itemsAbort = null
    })
}

/** 加载下一页；到底或正在加载时不触发。 */
export function loadMoreItems(): void {
  if (state.itemsLoading || state.items.length >= state.itemsTotal) return
  reloadItems({ reset: false, append: true })
}

/**
 * 切换标题排序：原始顺序 → 正序 → 倒序 → 原始顺序。
 *
 * 状态写进 localStorage：所有会话共用同一块面板，重启后也保持上次的选择。
 */
export function cycleItemSort(): void {
  const next: ItemSort = state.sort === 'none' ? 'asc' : state.sort === 'asc' ? 'desc' : 'none'
  patch({ sort: next })
  try {
    window.localStorage.setItem(SORT_KEY, next)
  } catch {
    // 隐私模式等禁用 localStorage 时忽略，本次会话内仍然生效。
  }
  reloadItems({ reset: true })
}

export function retryItems(): void {
  reloadItems({ reset: true })
}

/**
 * 列表行选中。
 *
 * 普通点击替换选中项（与 Zotero 一致，打开详情靠双击）；带 ctrl/cmd 时切换该项，
 * 支持跨行多选。
 */
export function selectItem(key: string, append: boolean): void {
  const selected = new Set(state.selectedItemKeys)
  if (append) {
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
  } else {
    if (selected.size === 1 && selected.has(key)) return
    selected.clear()
    selected.add(key)
  }
  patch({ selectedItemKeys: selected })
}

/** 清空列表选中项（点列表空白处）。 */
export function clearItemSelection(): void {
  if (state.selectedItemKeys.size === 0) return
  patch({ selectedItemKeys: new Set() })
}

/**
 * 拉取当前分类（不含子目录）/ 虚拟分类 + 搜索词内的标签用量。
 *
 * 只统计所选分类自身的条目：父分类的列表也只展示自身条目，若把子目录标签
 * 并进来，点标签过滤后会是空列表。文库根不分范围（直接置 null，标签面板回
 * 落到全库标签）；拉取失败也按 null 处理——退化成「列出全库标签」即可。
 */
function loadTagUsage(): void {
  const current = ++usageSeq
  if (usageAbort !== null) usageAbort.abort()
  usageAbort = null
  const collection = state.selectedCollection
  if (collection === null || collection.key === TREE_ROOT_ID) {
    patch({ tagUsage: null, tagUsageLoading: false })
    return
  }
  const controller = new AbortController()
  usageAbort = controller
  const query = state.query.trim()
  const scope = collection.scope
  // 先清掉上一个分类的标签集，避免新结果回来前闪一下旧标签。
  patch({ tagUsage: null, tagUsageLoading: true })
  fetchTagUsage(
    {
      ...(scope !== undefined
        ? { scope }
        : { collectionKeys: [collection.key] }),
      ...(query === '' ? {} : { q: query }),
    },
    controller.signal,
  )
    .then((data) => {
      if (current === usageSeq) patch({ tagUsage: new Map(data.tags.map((tag) => [tag.name, tag.count])) })
    })
    .catch(() => {
      if (current === usageSeq) patch({ tagUsage: null })
    })
    .finally(() => {
      if (current === usageSeq) patch({ tagUsageLoading: false })
      if (usageAbort === controller) usageAbort = null
    })
}

/** 插件卸载时清空，避免热重载后残留上一轮的选中项。 */
export function resetPaneStore(): void {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  if (toastTimer !== null) window.clearTimeout(toastTimer)
  if (itemsAbort !== null) itemsAbort.abort()
  if (usageAbort !== null) usageAbort.abort()
  searchTimer = null
  toastTimer = null
  treeInflight = null
  tagsInflight = null
  itemsAbort = null
  usageAbort = null
  itemsSeq = 0
  usageSeq = 0
  state = initialState()
  for (const listener of listeners) listener()
}