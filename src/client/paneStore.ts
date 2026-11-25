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
  ZoteroGroup,
  ZoteroHealth,
  ZoteroItemScope,
  ZoteroItemSummary,
  ZoteroSavedSearch,
  ZoteroSearchMode,
  ZoteroTag,
} from '../zotero/types'
import {
  fetchGroups,
  fetchHealth,
  fetchItems,
  fetchLibraryTree,
  fetchTagUsage,
  fetchTags,
} from './api'
import { rememberItemLibrary, setActiveLibrary } from './library'

/** 搜索防抖时长。 */
const SEARCH_DEBOUNCE_MS = 250

/**
 * 条目列表的分批上限。
 *
 * 列表本身不分页（一次加载当前范围的全部条目，与 Zotero 一致）：每批条数由 Host
 * 的「默认条目数」决定（上限 200），这里只兜一个总批数上限，防止 total 异常时
 * 无限翻页。
 */
const ITEMS_MAX_BATCHES = 1000

/** 提示条停留时长。 */
const TOAST_MS = 3000

/** 列表排序的存储键（localStorage，跨会话与重启都记住）。 */
const SORT_KEY = 'dsh-plugin-zotero.itemSort'

/** 搜索口径的存储键；默认与 Zotero 一样是「所有字段和标签」。 */
const SEARCH_MODE_KEY = 'dsh-plugin-zotero.searchMode'

const SEARCH_MODES: readonly ZoteroSearchMode[] = ['titleCreatorYear', 'fields', 'everything']

/** 目录树状态的存储键：刷新页面 / 重开面板后回到上次选中的目录。 */
const TREE_STATE_KEY = 'dsh-plugin-zotero.treeState'

/** 合法的虚拟分类范围（存档里的 scope 不在其中就丢弃）。 */
const KNOWN_SCOPES: readonly ZoteroItemScope[] = ['library', 'publications', 'unfiled', 'trash', 'recent']

/** 需要在分类树里显示数量的特殊目录（「最近阅读」走 recentCount）。 */
export type VirtualCountScope = Exclude<ZoteroItemScope, 'library' | 'recent'>

const VIRTUAL_COUNT_SCOPES: readonly VirtualCountScope[] = ['publications', 'unfiled', 'trash']

/** scope 是否是树里要显示数量的特殊目录。 */
export function isVirtualCountScope(scope: ZoteroItemScope | undefined): scope is VirtualCountScope {
  return scope === 'publications' || scope === 'unfiled' || scope === 'trash'
}

/** 文库根节点的 id（只存在于客户端，不对应任何 Zotero 分类）。 */
export const TREE_ROOT_ID = '__library__'

/**
 * 是否选中「最近阅读」。
 *
 * 这份名单来自本插件的阅读记录，Host 端本来就按最后打开时间倒序拼好；
 * 标题排序对它没有意义，标签面板在这里也搜不到东西，所以两处都要按它关掉。
 */
export function isRecentSelection(collection: ZoteroCollection | null): boolean {
  return collection !== null && collection.scope === 'recent'
}

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

function readSearchMode(): ZoteroSearchMode {
  try {
    const value = window.localStorage.getItem(SEARCH_MODE_KEY)
    return SEARCH_MODES.find((mode) => mode === value) ?? 'fields'
  } catch {
    return 'fields'
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
  selected: {
    key: string
    name: string
    scope?: ZoteroItemScope
    /** 群组文库标识；用户文库不存。 */
    library?: string
    /** 已保存搜索的 key；普通目录不存。 */
    searchKey?: string
  } | null
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
    const saved = record.selected as
      | { key?: unknown; name?: unknown; scope?: unknown; library?: unknown; searchKey?: unknown }
      | null
      | undefined
    if (saved === null || typeof saved !== 'object' || typeof saved.key !== 'string' || saved.key === '') {
      return { selected: null, expanded }
    }
    const scope = KNOWN_SCOPES.find((item) => item === saved.scope)
    const library = typeof saved.library === 'string' && /^group:\d{1,15}$/u.test(saved.library)
      ? saved.library
      : undefined
    const searchKey = typeof saved.searchKey === 'string' && saved.searchKey !== ''
      ? saved.searchKey
      : undefined
    return {
      selected: {
        key: saved.key,
        name: typeof saved.name === 'string' ? saved.name : '',
        ...(scope === undefined ? {} : { scope }),
        ...(library === undefined ? {} : { library }),
        ...(searchKey === undefined ? {} : { searchKey }),
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
 * 文库根是默认值，不存（存档为空即代表文库根），免得和「没有存档」两种状态打架；
 * 群组文库的根节点带 library，必须存，否则刷新后会落回用户文库。
 */
function saveTreeState(): void {
  const collection = state.selectedCollection
  const saved: SavedTreeState = {
    selected:
      collection === null || (collection.key === TREE_ROOT_ID && collection.library === undefined)
        ? null
        : {
            key: collection.key,
            name: collection.name,
            ...(collection.scope === undefined ? {} : { scope: collection.scope }),
            ...(collection.library === undefined ? {} : { library: collection.library }),
            ...(collection.searchKey === undefined ? {} : { searchKey: collection.searchKey }),
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

/** 一个群组文库的分类树（点击展开时懒加载）。 */
export interface GroupTreeState {
  name: string
  collections: ZoteroCollection[]
  loading: boolean
  error: string | null
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
  /** 「最近阅读」可列出的条数（由分类树接口下发，上限 50）。 */
  recentCount: number
  /**
   * 特殊目录的条目总数（不带搜索/标签筛选）。
   * 后台异步补齐；未取到时对应键缺失，树里就不显示数字。
   */
  virtualCounts: Readonly<Partial<Record<VirtualCountScope, number>>>

  /** 用户可访问的群组文库（只读）。 */
  groups: ZoteroGroup[]
  groupsError: string | null
  /** 群组分类树，按群组 id 缓存。 */
  groupTrees: Readonly<Record<string, GroupTreeState>>

  /** 用户文库的已保存搜索（固定区块，与 Zotero 左栏一致）。 */
  searches: ZoteroSavedSearch[]

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

  /** 搜索口径（列表搜索框左侧三档，存 localStorage）。 */
  searchMode: ZoteroSearchMode
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
    recentCount: 0,
    virtualCounts: {},
    groups: [],
    groupsError: null,
    groupTrees: {},
    searches: [],
    selectedCollection: saved.selected === null
      ? null
      : {
          key: saved.selected.key,
          name: saved.selected.name,
          parentKey: false,
          ...(saved.selected.scope === undefined ? {} : { scope: saved.selected.scope }),
          ...(saved.selected.library === undefined ? {} : { library: saved.selected.library }),
          ...(saved.selected.searchKey === undefined ? {} : { searchKey: saved.selected.searchKey }),
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
    searchMode: readSearchMode(),
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
/** 特殊目录计数的请求序号：刷新后迟到的旧结果不能覆盖新数量。 */
let virtualCountsSeq = 0
let tagsInflight: Promise<void> | null = null
/** 标签请求序号：切文库时丢弃上一个库的迟到响应。 */
let tagsSeq = 0
/** 群组分类树的在途请求（按群组 id）。 */
const groupInflight = new Map<string, Promise<void>>()
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

/** 文库根节点的伪分类对象（群组文库的根带 library）。 */
function libraryRoot(name: string, library?: string): ZoteroCollection {
  return { key: TREE_ROOT_ID, name, parentKey: false, ...(library === undefined ? {} : { library }) }
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

/**
 * 当前选择指向的查询范围参数。
 *
 * 文库由选中节点自己带（群组节点/群组分类才有 library），用户文库不传参；
 * 文库根不带 key/scope；已保存搜索走 searchKey。
 */
function selectionQuery(): {
  library?: string
  scope?: ZoteroItemScope
  collectionKey?: string
  searchKey?: string
} {
  const collection = state.selectedCollection
  if (collection === null) return {}
  const base = collection.library === undefined ? {} : { library: collection.library }
  if (collection.key === TREE_ROOT_ID) return base
  if (collection.searchKey !== undefined) return { ...base, searchKey: collection.searchKey }
  if (collection.scope !== undefined) return { ...base, scope: collection.scope }
  return { ...base, collectionKey: collection.key }
}

/**
 * 后台补「我的出版物 / 未分类条目 / 回收站」的数量。
 *
 * 复用条目列表接口，只取一条读总数；不阻塞分类树渲染。单项失败保留上一次
 * 成功的值（如果还没有则继续不显示），刷新时靠序号丢掉迟到的旧结果。
 */
function loadVirtualCounts(): void {
  const seq = ++virtualCountsSeq
  for (const scope of VIRTUAL_COUNT_SCOPES) {
    // 这三个目录只显示在「我的文库」下，数量恒按用户文库取，不受当前浏览文库影响。
    void fetchItems({ library: '', scope, limit: 1 })
      .then((data) => {
        if (seq !== virtualCountsSeq) return
        patch({ virtualCounts: { ...state.virtualCounts, [scope]: data.total } })
      })
      .catch(() => {
        // 单个目录计数失败不影响树或列表。
      })
  }
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
  // 存档里的选择决定当前文库：这里先对齐一次，后续标签 / 条目请求才不会打到别的库。
  setActiveLibrary(state.selectedCollection?.library ?? '')
  patch({ treeLoading: true })
  void loadTags(force)

  const groupsPromise = fetchGroups()
    .then((list) => ({ list, error: null as string | null }))
    .catch((error: unknown) => ({ list: [] as ZoteroGroup[], error: errorMessage(error) }))

  const run = (async (): Promise<void> => {
    try {
      // 用户文库树恒从用户前缀取；群组树走 {@link loadGroupTree} 懒加载。
      const [healthData, tree, groupResult] = await Promise.all([
        fetchHealth(),
        fetchLibraryTree(''),
        groupsPromise,
      ])
      const previous = state.selectedCollection
      let selected: ZoteroCollection = libraryRoot(tree.libraryName)
      if (previous !== null) {
        if (previous.library !== undefined) {
          // 群组选择：名字与分类都在群组树里，加载完成前原样保留。
          selected = previous
        } else if (previous.searchKey !== undefined) {
          const search = (tree.searches ?? []).find((item) => item.key === previous.searchKey)
          selected = search === undefined
            ? libraryRoot(tree.libraryName)
            : { key: search.key, name: search.name, parentKey: false, searchKey: search.key }
        } else if (previous.key === TREE_ROOT_ID) {
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
      if (selected.library !== undefined) {
        expanded.add(selected.library)
      } else if (
        selected.key !== TREE_ROOT_ID
        && selected.scope === undefined
        && selected.searchKey === undefined
      ) {
        for (const key of ancestorKeys(tree.collections, selected.key)) expanded.add(key)
      }
      patch({
        health: healthData,
        collections: tree.collections,
        libraryName: tree.libraryName,
        recentCount: tree.recentCount,
        searches: tree.searches ?? [],
        groups: groupResult.list,
        groupsError: groupResult.error,
        treeError: null,
        loaded: true,
        expanded,
        selectedCollection: selected,
      })
      // 特殊目录数量后台补，不拖慢树首屏；force 刷新时也会重取。
      loadVirtualCounts()
      // 选中的分类若已被删掉（回落到文库根），把回落结果写回存档。
      saveTreeState()
      // 选中的是群组内容：把该群的分类树也取回来（展开状态才能画出来）。
      if (selected.library !== undefined) {
        void loadGroupTree(selected.library.slice('group:'.length))
      }
      reloadItems()
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
 * 群组文库的分类树（懒加载）。
 *
 * 群组数量通常不多，但没必要为每个组各打一次请求；只有用户展开某个组时才取，
 * 取到后按 id 缓存到 {@link PaneState.groupTrees}。
 */
export function loadGroupTree(groupId: string, force = false): Promise<void> {
  const library = `group:${groupId}`
  const cached: GroupTreeState | undefined = state.groupTrees[groupId]
  const inflight = groupInflight.get(groupId)
  if (!force && inflight !== undefined) return inflight
  // 缓存里只要有一次成功结果就复用（空群组也算成功，不必每次展开都重取）。
  if (!force && cached !== undefined && cached.error === null) return Promise.resolve()
  patch({
    groupTrees: {
      ...state.groupTrees,
      [groupId]: {
        name: cached?.name ?? '',
        collections: cached?.collections ?? [],
        loading: true,
        error: null,
      },
    },
  })
  const run = (async (): Promise<void> => {
    try {
      const tree = await fetchLibraryTree(library)
      patch({
        groupTrees: {
          ...state.groupTrees,
          [groupId]: {
            name: tree.libraryName,
            collections: tree.collections.map((node) => ({ ...node, library })),
            loading: false,
            error: null,
          },
        },
      })
      // 刷新后恢复的是群组里的某个深层分类：把它的祖先一起撑开，否则选中项
      // 藏在折叠的父级里（群组分类的展开 id 带文库前缀，见 CollectionRows）。
      const selected = state.selectedCollection
      if (
        selected?.library === library
        && selected.key !== TREE_ROOT_ID
        && selected.scope === undefined
        && selected.searchKey === undefined
      ) {
        const expanded = new Set(state.expanded)
        for (const key of ancestorKeys(tree.collections, selected.key)) {
          expanded.add(`${library}/${key}`)
        }
        patch({ expanded })
      }
    } catch (error) {
      patch({
        groupTrees: {
          ...state.groupTrees,
          [groupId]: {
            name: state.groupTrees[groupId]?.name ?? '',
            collections: state.groupTrees[groupId]?.collections ?? [],
            loading: false,
            error: errorMessage(error),
          },
        },
      })
    } finally {
      groupInflight.delete(groupId)
    }
  })()
  groupInflight.set(groupId, run)
  return run
}

/** 展开 / 折叠一个群组文库（展开时按需取它的分类树）。 */
export function toggleGroup(group: ZoteroGroup): void {
  const nodeId = `group:${group.id}`
  const expanded = new Set(state.expanded)
  const open = !expanded.has(nodeId)
  if (open) expanded.add(nodeId)
  else expanded.delete(nodeId)
  patch({ expanded })
  saveTreeState()
  if (open) void loadGroupTree(group.id)
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
  const library = collection.library ?? ''
  const name = collection.key === TREE_ROOT_ID
    ? (library === ''
        ? (state.libraryName === '' ? '我的文库' : state.libraryName)
        : collection.name)
    : collection.name
  const selected = collection.key === TREE_ROOT_ID
    ? libraryRoot(name, library === '' ? undefined : library)
    : collection
  const previous = state.selectedCollection
  // 选中身份 = 文库 + key（+ scope / searchKey）：不同文库可能撞 key。
  const same = previous !== null
    && previous.key === selected.key
    && (previous.library ?? '') === library
    && previous.scope === selected.scope
    && previous.searchKey === selected.searchKey
  if (same) return
  const libraryChanged = (previous?.library ?? '') !== library
  if (libraryChanged) setActiveLibrary(library)
  patch({
    selectedCollection: selected,
    items: [],
    itemsTotal: 0,
    itemsError: null,
    selectedTags: new Set(),
    tagQuery: '',
  })
  if (libraryChanged) void loadTags(true)
  saveTreeState()
  reloadItems()
  loadTagUsage()
}

// ---- 搜索 -------------------------------------------------------------------

/** 更新搜索词并按防抖重拉当前范围（含标签用量）；清空时立即重拉。 */
export function setQuery(next: string): void {
  patch({ query: next })
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  if (next.trim() === '') {
    searchTimer = null
    reloadItems()
    loadTagUsage()
    return
  }
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    reloadItems()
    loadTagUsage()
  }, SEARCH_DEBOUNCE_MS)
}

/** 切换搜索口径：立即按新口径重拉（不等防抖），并记住选择。 */
export function setSearchMode(mode: ZoteroSearchMode): void {
  if (state.searchMode === mode) return
  patch({ searchMode: mode })
  try {
    window.localStorage.setItem(SEARCH_MODE_KEY, mode)
  } catch {
    // 隐私模式等禁用 localStorage 时忽略，本次会话内仍然生效。
  }
  // 没有搜索词时切口径不改变结果，没必要多打一轮请求。
  if (state.query.trim() === '') return
  if (searchTimer !== null) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
  reloadItems()
  loadTagUsage()
}

// ---- 标签 -------------------------------------------------------------------

/**
 * 拉取当前文库的标签；失败只记错误，不影响树与列表。
 *
 * 切文库时会 `force` 重拉，此时可能上一个库的请求还在路上：用序号丢弃迟到结果，
 * 否则群组标签会被用户文库的旧响应覆盖。
 */
export function loadTags(force = false): Promise<void> {
  if (!force) {
    if (tagsInflight !== null) return tagsInflight
    if (state.tags !== null) return Promise.resolve()
  }
  const seq = ++tagsSeq
  patch({ tagsLoading: true })
  const run = (async (): Promise<void> => {
    try {
      const data = await fetchTags()
      if (seq !== tagsSeq) return
      patch({ tags: data.tags, tagsError: null })
    } catch (error) {
      if (seq !== tagsSeq) return
      patch({ tagsError: errorMessage(error) })
    } finally {
      if (seq === tagsSeq) {
        patch({ tagsLoading: false })
        tagsInflight = null
      }
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
  reloadItems()
}

export function clearTags(): void {
  if (state.selectedTags.size === 0) return
  patch({ selectedTags: new Set() })
  reloadItems()
}

export function setTagMode(mode: 'all' | 'any'): void {
  if (state.tagMode === mode) return
  patch({ tagMode: mode })
  if (state.selectedTags.size > 0) reloadItems()
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
 * 重拉条目列表（把当前范围的全部条目一次加载完，与 Zotero 一致）。
 *
 * 重置（切分类 / 改筛选）时连带清空选中项：列表都换了，留着旧选中会让
 * 「引用已选」插进不在眼前的条目。
 *
 * 实现上是「连续取批」而不是一次要全量：Host 单次响应有条数上限，客户端就不传
 * `limit`、按设置页的「每批条目数」（Host 侧 `defaultLimit`，上限 200）一批一批
 * 地取，取到多少先画多少，取满 total 自然停。大口库因此能先出首屏，也不会再出现
 * 「加载更多」按钮。
 */
export function reloadItems(): void {
  if (itemsAbort !== null) itemsAbort.abort()
  const controller = new AbortController()
  itemsAbort = controller
  const current = ++itemsSeq
  patch({
    items: [],
    itemsTotal: 0,
    itemsError: null,
    itemsLoading: true,
    selectedItemKeys: new Set(),
  })

  // 「最近阅读」固定按最后打开时间倒序（Host 拼名单的顺序），标题排序与标签筛选都不参与。
  const recent = isRecentSelection(state.selectedCollection)
  const tags = recent ? [] : [...state.selectedTags]
  const query = state.query.trim()
  const selectedScope = state.selectedCollection?.scope
  // 选中特殊目录且没有搜索/标签筛选时，列表返回的 total 就是树里要显示的数量；
  // 带筛选的 total 只能代表筛选结果，不能覆盖树上的目录总数。群组下的特殊目录
  // 不参与（树里显示的是用户文库的计数）。
  const countScope = query === ''
    && tags.length === 0
    && state.selectedCollection?.library === undefined
    && isVirtualCountScope(selectedScope)
    ? selectedScope
    : null

  void (async (): Promise<void> => {
    let loaded: ZoteroItemSummary[] = []
    // 记住这批条目属于哪个文库：条目详情开在独立 tab 里，之后切库也要取得到。
    const itemLibrary = state.selectedCollection?.library ?? ''
    try {
      for (let batch = 0; batch < ITEMS_MAX_BATCHES; batch += 1) {
        const data = await fetchItems({
          ...selectionQuery(),
          q: query,
          qmode: state.searchMode,
          tags: tags.length === 0 ? undefined : tags,
          tagMode: tags.length === 0 ? undefined : state.tagMode,
          sort: recent || state.sort === 'none' ? undefined : 'title',
          direction: recent || state.sort === 'none' ? undefined : state.sort,
          offset: loaded.length,
        }, controller.signal)
        if (current !== itemsSeq) return
        for (const item of data.items) rememberItemLibrary(item.key, itemLibrary)
        const virtualCounts: Partial<Record<VirtualCountScope, number>> = { ...state.virtualCounts }
        if (countScope !== null && batch === 0) virtualCounts[countScope] = data.total
        loaded = loaded.length === 0 ? data.items : [...loaded, ...data.items]
        patch({ items: loaded, itemsTotal: data.total, itemsError: null, virtualCounts })
        // 空批（条目被删掉之类）或已取满就收工；total 变小也在这里自然退出。
        if (data.items.length === 0 || loaded.length >= data.total) return
      }
    } catch (error) {
      if (current !== itemsSeq || controller.signal.aborted) return
      patch({ itemsError: errorMessage(error) })
    } finally {
      if (current === itemsSeq) {
        patch({ itemsLoading: false })
        if (itemsAbort === controller) itemsAbort = null
      }
    }
  })()
}

/**
 * 切换标题排序：原始顺序 → 正序 → 倒序 → 原始顺序。
 *
 * 状态写进 localStorage：所有会话共用同一块面板，重启后也保持上次的选择。
 */
export function cycleItemSort(): void {
  // 「最近阅读」恒按最后打开时间倒序，排序按钮也藏了，这里兜一层避免状态被改。
  if (isRecentSelection(state.selectedCollection)) return
  const next: ItemSort = state.sort === 'none' ? 'asc' : state.sort === 'asc' ? 'desc' : 'none'
  patch({ sort: next })
  try {
    window.localStorage.setItem(SORT_KEY, next)
  } catch {
    // 隐私模式等禁用 localStorage 时忽略，本次会话内仍然生效。
  }
  reloadItems()
}

export function retryItems(): void {
  reloadItems()
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
  // 「最近阅读」没有分类范围、已保存搜索也没有分类，标签面板都退回全库标签。
  if (
    collection === null
    || collection.key === TREE_ROOT_ID
    || collection.scope === 'recent'
    || collection.searchKey !== undefined
  ) {
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
      ...(collection.library === undefined ? {} : { library: collection.library }),
      ...(scope !== undefined
        ? { scope }
        : { collectionKeys: [collection.key] }),
      ...(query === '' ? {} : { q: query }),
      qmode: state.searchMode,
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
  groupInflight.clear()
  itemsAbort = null
  usageAbort = null
  itemsSeq = 0
  usageSeq = 0
  tagsSeq = 0
  state = initialState()
  for (const listener of listeners) listener()
}