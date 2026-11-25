/**
 * 左栏：文库分类树（只显示分类，条目在右侧列表）。
 *
 * - 行首三角箭头只管开合，且只在有子分类的行出现；点行体选中该范围。
 * - 缩进按层级一次性算出（`depth * INDENT`），不再逐层叠加 margin。
 * - 真实分类与特殊目录（我的出版物 / 未分类条目 / 回收站）右侧显示条目数；
 *   右键真实分类 → 「添加整目录引用」（仅用户文库）。
 * - 「我的文库」根节点是可选中的全库范围；其下挂三个虚拟分类
 *   （我的出版物 / 未分类条目 / 回收站），与 Zotero 左侧栏一致。
 * - 其后是两个固定区块（与 Zotero 左栏一致，位置随文库区块往下排）：
 *   「群组文库」—— 每个群组一个蓝色节点，展开时才拉该组的分类树（只读）；
 *   「已保存搜索」—— 橙色放大镜，选中后列表直接展示 Zotero 求值好的结果。
 * - 顶部筛选框只筛目录名（同 Zotero 左栏）：命中分类保留、非命中的祖先作为
 *   上下文行保留、未命中的子分类隐藏；筛选期间自动展开命中路径。
 * - 展开状态放在 {@link paneStore}：右侧栏切 tab 时正文会被卸载重挂，
 *   只有模块级 store 能让树保持原样；store 再把「选中 + 展开」写进 localStorage，
 *   页面刷新后也能回到上次的位置。
 */

import { useState, type ReactElement, type ReactNode } from 'react'

import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroCollection, ZoteroGroup, ZoteroItemScope, ZoteroSavedSearch } from '../zotero/types'
import { ChatIcon } from './actionIcons'
import type { Translate } from './locales'
import {
  isVirtualCountScope,
  toggleGroup,
  toggleTreeNode,
  TREE_ROOT_ID,
  usePaneState,
  type GroupTreeState,
  type VirtualCountScope,
} from './paneStore'
import { TREE_BLUE, TREE_GRAY, TREE_GREEN, TREE_ORANGE, TREE_RED } from './styles'

/** 每层缩进量（px）。 */
const INDENT = 14

/** 树左起始留白（px）。 */
const BASE_INDENT = 8

/** 行高（px）。 */
const ROW_HEIGHT = 24

/** 虚拟分类定义（顺序与 Zotero 左侧栏一致，排在真实分类之后）。 */
interface VirtualNode {
  key: string
  scope: ZoteroItemScope
  labelKey: string
  icon: string
}

/**
 * 「最近阅读」：本插件自己维护的虚拟分类。
 *
 * Zotero 的最近阅读数据不在本地 API 里，这里改为按插件的阅读进度记录生成；
 * 位置与 Zotero 一致 —— 紧跟在「我的文库」下面、真实分类之前。
 */
const RECENT_NODE: VirtualNode = {
  key: '@recent',
  scope: 'recent',
  labelKey: 'tree.recent',
  icon: 'RECENT',
}

const VIRTUAL_NODES: readonly VirtualNode[] = [
  { key: '@publications', scope: 'publications', labelKey: 'tree.publications', icon: 'BOOK' },
  { key: '@unfiled', scope: 'unfiled', labelKey: 'tree.unfiled', icon: 'UNFILED' },
  { key: '@trash', scope: 'trash', labelKey: 'tree.trash', icon: 'TRASH' },
]

/**
 * 群组文库下挂的特殊目录。
 *
 * 比用户文库少了「我的出版物」与「最近阅读」：群组没有出版物语义，最近阅读
 * 是本插件的全局记录、不按库拆分；「重复条目」本地 API 不提供。
 */
const GROUP_VIRTUAL_NODES: readonly VirtualNode[] = VIRTUAL_NODES.filter(
  (node) => node.scope !== 'publications',
)

interface CollectionNode {
  collection: ZoteroCollection
  children: CollectionNode[]
}

interface TreeCtx {
  t: Translate
  expanded: ReadonlySet<string>
  /** 当前筛选词（已小写）；空串表示不筛选。 */
  filter: string
  /** 当前选中的范围（文库 + key 联合身份，见 {@link isSelected}）。 */
  selected: ZoteroCollection | null
  /** 「最近阅读」可列出的条数。 */
  recentCount: number
  /** 我的出版物 / 未分类条目 / 回收站的条目总数（未取到就不显示）。 */
  virtualCounts: Readonly<Partial<Record<VirtualCountScope, number>>>
  /** 群组分类树缓存（展开时才取）。 */
  groupTrees: Readonly<Record<string, GroupTreeState>>
  toggle(nodeId: string): void
  select(collection: ZoteroCollection): void
  onInsertCollection(collection: ZoteroCollection): void
  onToggleGroup(group: ZoteroGroup): void
}

interface Props {
  t: Translate
  libraryName: string
  collections: ZoteroCollection[]
  /** 分类树筛选词（只筛目录名）。 */
  treeQuery: string
  /** 当前选择：文库根 / 真实分类 / 虚拟分类 / 已保存搜索 / 群组节点。 */
  selectedCollection: ZoteroCollection | null
  /** 「最近阅读」可列出的条数。 */
  recentCount: number
  /** 我的出版物 / 未分类条目 / 回收站的条目总数。 */
  virtualCounts: Readonly<Partial<Record<VirtualCountScope, number>>>
  /** 用户可访问的群组文库。 */
  groups: ZoteroGroup[]
  groupsError: string | null
  /** 群组分类树缓存。 */
  groupTrees: Readonly<Record<string, GroupTreeState>>
  /** 已保存搜索。 */
  searches: ZoteroSavedSearch[]
  onSelectCollection(collection: ZoteroCollection): void
  onInsertCollection(collection: ZoteroCollection): void
}

// ---- 图标（内联 SVG，避免依赖宿主图标导出名） -----------------------------
//
// 形状与配色对齐 Zotero 客户端左栏：蓝色柱廊 = 文库根、蓝色文件夹 = 分类、
// 绿色文稿 = 我的出版物、橙色散页 = 未分类条目、红色垃圾桶 = 回收站、
// 蓝色双人 = 群组文库、橙色放大镜 = 已保存搜索。
// 图标是固定彩色（不随主题变），这正是 Zotero 原生左栏的样子。

interface TreeIcon {
  path: string
  color: string
}

function glyph(icon: TreeIcon, size = 15): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={icon.color}
      strokeWidth={1.4}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
    >
      <path d={icon.path} />
    </svg>
  )
}

/** 蓝色古典柱廊：对应 Zotero 的「我的文库」。 */
const LIBRARY_ICON: TreeIcon = {
  path: 'M1.7 5.9 8 2.5l6.3 3.4zM2.7 6.5h10.6M3.7 7.1v4.7M6.5 7.1v4.7M9.5 7.1v4.7M12.3 7.1v4.7M2.2 12.1h11.6M2.7 12.1v1.4h10.6v-1.4',
  color: TREE_BLUE,
}

/** 蓝色文件夹：左上带 tab、中间一道盖线，Zotero 分类图标的轮廓。 */
const FOLDER_ICON: TreeIcon = {
  path: 'M2.3 5.1V4.4a.8.8 0 0 1 .8-.8h3.4L7.9 5.3h5.8a.8.8 0 0 1 .8.8v6.6a.8.8 0 0 1-.8.8H3.1a.8.8 0 0 1-.8-.8zM2.3 6.7h12.2',
  color: TREE_BLUE,
}

/** 绿色文稿：我的出版物。 */
const PUBLICATIONS_ICON: TreeIcon = {
  path: 'M4 2.4h5.4L12 5v8.6H4zM9.4 2.4V5H12M6.2 8h4M6.2 10.4h4',
  color: TREE_GREEN,
}

/** 橙色文稿（右上角折角 + 参差文字行）：未分类条目。 */
const UNFILED_ICON: TreeIcon = {
  path: 'M4.2 2.5h5.2L12 5v8.5H4.2zM9.4 2.5V5H12M6.3 8.1h4M6.3 10.4h2.7',
  color: TREE_ORANGE,
}

/** 红色垃圾桶：回收站。 */
const TRASH_ICON: TreeIcon = {
  path: 'M3.2 4.5h9.6M6.3 4.5V3h3.4v1.5M4.6 4.5l0.6 9.2h5.6l0.6-9.2M6.8 7v4.4M9.2 7v4.4',
  color: TREE_RED,
}

/** 灰色时钟：最近阅读。 */
const RECENT_ICON: TreeIcon = {
  path: 'M8 2.4a5.6 5.6 0 1 1 0 11.2A5.6 5.6 0 0 1 8 2.4M8 5.1V8l2.2 1.4',
  color: TREE_GRAY,
}

/** 蓝色双人：群组文库。 */
const GROUPS_ICON: TreeIcon = {
  path: 'M6 3.4a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2M1.8 12.6c0-2.2 1.9-3.8 4.2-3.8s4.2 1.6 4.2 3.8M10.8 4a1.8 1.8 0 1 1 .2 3.6M11.4 8.9c1.6.3 2.8 1.6 2.8 3.4',
  color: TREE_BLUE,
}

/** 橙色放大镜：已保存搜索。 */
const SEARCH_ICON: TreeIcon = {
  path: 'M7.1 2.6a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9M10.4 10.4l3 3',
  color: TREE_ORANGE,
}

/** 虚拟分类的图标（键与 {@link VIRTUAL_NODES.icon} 对应）。 */
const VIRTUAL_ICON: Record<string, TreeIcon> = {
  RECENT: RECENT_ICON,
  BOOK: PUBLICATIONS_ICON,
  UNFILED: UNFILED_ICON,
  TRASH: TRASH_ICON,
}

// ---- 扁平分类列表 → 森林 ---------------------------------------------------

function buildForest(collections: ZoteroCollection[]): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>()
  for (const collection of collections) nodes.set(collection.key, { collection, children: [] })
  const roots: CollectionNode[] = []
  for (const collection of collections) {
    const node = nodes.get(collection.key)
    if (node === undefined) continue
    const parent = collection.parentKey === false ? undefined : nodes.get(collection.parentKey)
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  return roots
}

/** 目录名是否命中筛选词（大小写不敏感的子串匹配，与 Zotero 左栏一致）。 */
function nameMatches(name: string, filter: string): boolean {
  return name.toLowerCase().includes(filter)
}

/**
 * 按 Zotero 左栏的规则裁剪分类森林。
 *
 * 命中分类保留、非命中的祖先作为上下文行保留（否则层级断裂）、命中分类下
 * 未命中的子分类隐藏：可见集 = 命中节点 ∪ 命中节点的祖先。
 */
function filterForest(nodes: CollectionNode[], filter: string): CollectionNode[] {
  const kept: CollectionNode[] = []
  for (const node of nodes) {
    const children = filterForest(node.children, filter)
    if (children.length > 0 || nameMatches(node.collection.name, filter)) {
      kept.push({ collection: node.collection, children })
    }
  }
  return kept
}

/**
 * 选中身份 = 文库 + key（+ scope / searchKey）。
 *
 * 群组与用户文库的分类 key 不在同一命名空间，只比 key 会让两个库的同名节点
 * 同时高亮。
 */
function isSelected(ctx: TreeCtx, node: ZoteroCollection): boolean {
  const selected = ctx.selected
  return selected !== null
    && selected.key === node.key
    && (selected.library ?? '') === (node.library ?? '')
    && selected.scope === node.scope
    && selected.searchKey === node.searchKey
}

// ---- 样式 -------------------------------------------------------------------

const rowStyle: React.CSSProperties = {
  display: 'flex',
  width: '100%',
  boxSizing: 'border-box',
  gap: 6,
  alignItems: 'center',
  height: ROW_HEIGHT,
  fontSize: 12.5,
  lineHeight: `${ROW_HEIGHT}px`,
  paddingRight: 8,
  borderRadius: 5,
  cursor: 'pointer',
}

function rowIndent(depth: number): React.CSSProperties {
  return { paddingLeft: BASE_INDENT + depth * INDENT }
}

/** 选中行：浅蓝底 + 蓝色文字，与 Zotero 的灰底相比更贴合整套配色。 */
function rowBackground(selected: boolean): React.CSSProperties {
  return selected
    ? { background: 'rgba(74,134,232,0.15)', color: TREE_BLUE, fontWeight: 600 }
    : { background: 'transparent' }
}

const iconBox: React.CSSProperties = {
  width: 16,
  height: 16,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const titleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const countStyle: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 14,
  textAlign: 'right',
  fontSize: 11.5,
  opacity: 0.5,
}

const sectionStyle: React.CSSProperties = {
  padding: '10px 8px 3px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.2,
  opacity: 0.55,
}

// ---- 展开箭头 ---------------------------------------------------------------

function Chevron({ open, onToggle }: { open: boolean; onToggle: () => void }): ReactElement {
  return (
    <span
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      style={{ ...iconBox, cursor: 'pointer', opacity: 0.6 }}
    >
      <svg
        width={9}
        height={9}
        viewBox="0 0 10 10"
        fill="currentColor"
        style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
      >
        <path d="M3.2 1.6 7 5l-3.8 3.4z" />
      </svg>
    </span>
  )
}

// ---- 分类节点（扁平化渲染：每行自带缩进，天然成树） -------------------------

function CollectionRows({ ctx, node, depth }: { ctx: TreeCtx; node: CollectionNode; depth: number }): ReactElement {
  const collection = node.collection
  // 群组分类的 key 可能与用户文库撞车，展开状态用「文库/ key」做 id。
  const nodeId = collection.library === undefined
    ? collection.key
    : `${collection.library}/${collection.key}`
  /** 筛选期间命中路径自动展开，折叠箭头暂不可用。 */
  const filtering = ctx.filter !== ''
  const open = filtering || ctx.expanded.has(nodeId)
  const [menuOpen, setMenuOpen] = useState(false)
  /** 没有子分类就不给折叠箭头（只留同宽空位，图标仍对齐）。 */
  const hasChildren = node.children.length > 0
  /** 群组文库只读：引用解析只认用户文库，群组分类不给「添加整目录引用」。 */
  const canInsert = collection.library === undefined

  const row = (
    <div
      onClick={() => ctx.select(collection)}
      onContextMenu={canInsert
        ? (event) => {
            event.preventDefault()
            setMenuOpen(true)
          }
        : undefined}
      style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(isSelected(ctx, collection)) }}
    >
      {hasChildren && !filtering
        ? <Chevron open={open} onToggle={() => ctx.toggle(nodeId)} />
        : <span style={iconBox} />}
      <span style={iconBox}>{glyph(FOLDER_ICON)}</span>
      <span style={titleStyle} title={collection.name}>{collection.name}</span>
      {collection.itemCount !== undefined && (
        <span style={countStyle}>{collection.itemCount}</span>
      )}
    </div>
  )

  return (
    <>
      {canInsert ? (
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onSelect={(id) => {
            setMenuOpen(false)
            if (id === 'insert-collection') ctx.onInsertCollection(collection)
          }}
          align="end"
          portal
          items={[{ id: 'insert-collection', label: ctx.t('action.insertCollection'), icon: <ChatIcon size={15} /> }]}
          anchor={row}
        />
      ) : row}
      {open && node.children.map((child) => (
        <CollectionRows key={child.collection.key} ctx={ctx} node={child} depth={depth + 1} />
      ))}
    </>
  )
}

// ---- 虚拟分类（我的出版物 / 未分类条目 / 回收站） ---------------------------

function virtualCollection(node: VirtualNode, t: Translate, library?: string): ZoteroCollection {
  return {
    key: node.key,
    name: t(node.labelKey),
    parentKey: false,
    scope: node.scope,
    ...(library === undefined ? {} : { library }),
  }
}

function VirtualRows(
  { ctx, node, depth, library }: { ctx: TreeCtx; node: VirtualNode; depth: number; library?: string },
): ReactElement {
  const collection = virtualCollection(node, ctx.t, library)
  /**
   * 最近阅读读插件自己的进度记录；其余三个特殊目录读后台补的 total。
   * 数量异步返回，没取到时保持不显示，不让数字把树撑变形。
   * 群组下的特殊目录不显示数量：后台补的是用户文库的 total，套到群组上就是错数。
   */
  const count = library !== undefined
    ? undefined
    : node.scope === 'recent'
      ? ctx.recentCount
      : isVirtualCountScope(node.scope)
        ? ctx.virtualCounts[node.scope]
        : undefined
  return (
    <div
      onClick={() => ctx.select(collection)}
      style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(isSelected(ctx, collection)) }}
    >
      <span style={iconBox} />
      <span style={iconBox}>{glyph(VIRTUAL_ICON[node.icon] ?? FOLDER_ICON)}</span>
      <span style={titleStyle} title={collection.name}>{collection.name}</span>
      {count !== undefined && <span style={countStyle}>{count}</span>}
    </div>
  )
}

// ---- 群组文库 ---------------------------------------------------------------

/** 群组节点在筛选下是否可见：组名命中，或它已加载的分类里有命中的。 */
function groupVisible(
  group: ZoteroGroup,
  tree: GroupTreeState | undefined,
  filter: string,
): boolean {
  if (filter === '') return true
  if (nameMatches(group.name, filter)) return true
  if (tree === undefined) return false
  return filterForest(buildForest(tree.collections), filter).length > 0
}

function GroupRows({ ctx, group, depth }: { ctx: TreeCtx; group: ZoteroGroup; depth: number }): ReactElement {
  const library = `group:${group.id}`
  const tree: GroupTreeState | undefined = ctx.groupTrees[group.id]
  /** 只按用户展开状态渲染：筛选时不去拉没展开过的群组（否则是一串请求 + 空白）。 */
  const open = ctx.expanded.has(library)
  const loaded = tree !== undefined && tree.collections.length > 0
  const root: ZoteroCollection = { key: TREE_ROOT_ID, name: group.name, parentKey: false, library }
  /** 组名命中筛选时展示它全部内容，否则只展示命中的分类路径。 */
  const nameHit = ctx.filter === '' || nameMatches(group.name, ctx.filter)
  const forest = tree === undefined
    ? []
    : ctx.filter === '' || nameHit
      ? buildForest(tree.collections)
      : filterForest(buildForest(tree.collections), ctx.filter)
  const virtuals = nameHit
    ? GROUP_VIRTUAL_NODES
    : GROUP_VIRTUAL_NODES.filter((node) => nameMatches(ctx.t(node.labelKey), ctx.filter))

  return (
    <>
      <div
        onClick={() => ctx.select(root)}
        style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(isSelected(ctx, root)) }}
      >
        <Chevron open={open} onToggle={() => ctx.onToggleGroup(group)} />
        <span style={iconBox}>{glyph(GROUPS_ICON)}</span>
        <span style={titleStyle} title={group.name}>{group.name}</span>
        {group.itemCount !== undefined && <span style={countStyle}>{group.itemCount}</span>}
      </div>
      {open && (tree === undefined || (tree.loading && !loaded) ? (
        <div style={{ ...hintStyle, paddingLeft: BASE_INDENT + (depth + 1) * INDENT }}>{ctx.t('status.loading')}</div>
      ) : tree.error !== null ? (
        <div style={{ ...hintStyle, paddingLeft: BASE_INDENT + (depth + 1) * INDENT, color: '#d29922' }}>
          {tree.error}
        </div>
      ) : (
        <>
          {forest.map((node) => (
            <CollectionRows key={node.collection.key} ctx={ctx} node={node} depth={depth + 1} />
          ))}
          {virtuals.map((node) => (
            <VirtualRows key={node.key} ctx={ctx} node={node} depth={depth + 1} library={library} />
          ))}
        </>
      ))}
    </>
  )
}

// ---- 已保存搜索 -------------------------------------------------------------

function SearchRows(
  { ctx, search, depth }: { ctx: TreeCtx; search: ZoteroSavedSearch; depth: number },
): ReactElement {
  const node: ZoteroCollection = {
    key: search.key,
    name: search.name,
    parentKey: false,
    searchKey: search.key,
  }
  return (
    <div
      onClick={() => ctx.select(node)}
      style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(isSelected(ctx, node)) }}
    >
      <span style={iconBox} />
      <span style={iconBox}>{glyph(SEARCH_ICON)}</span>
      <span style={titleStyle} title={search.name}>{search.name}</span>
    </div>
  )
}

// ---- 树容器 -----------------------------------------------------------------

export function CollectionTree(props: Props): ReactElement {
  const {
    t,
    libraryName,
    collections,
    treeQuery,
    selectedCollection,
    recentCount,
    virtualCounts,
    groups,
    groupsError,
    groupTrees,
    searches,
    onSelectCollection,
    onInsertCollection,
  } = props

  /** 展开集合在 store 里（默认展开根节点），重挂面板后原样恢复。 */
  const { expanded } = usePaneState()

  const filter = treeQuery.trim().toLowerCase()
  const filtering = filter !== ''
  const forest = filtering ? filterForest(buildForest(collections), filter) : buildForest(collections)
  const virtuals = filtering
    ? VIRTUAL_NODES.filter((node) => nameMatches(t(node.labelKey), filter))
    : VIRTUAL_NODES
  const recentVisible = !filtering || nameMatches(t(RECENT_NODE.labelKey), filter)

  const visibleGroups = filtering
    ? groups.filter((group) => groupVisible(group, groupTrees[group.id], filter))
    : groups
  const visibleSearches = filtering
    ? searches.filter((search) => nameMatches(search.name, filter))
    : searches
  /** 整棵左栏都没有命中时才提示；命中只在群组 / 搜索里也不算「没有匹配」。 */
  const nothingMatched = filtering
    && forest.length === 0
    && virtuals.length === 0
    && !recentVisible
    && visibleGroups.length === 0
    && visibleSearches.length === 0

  const ctx: TreeCtx = {
    t,
    expanded,
    filter,
    selected: selectedCollection,
    recentCount,
    virtualCounts,
    groupTrees,
    toggle: toggleTreeNode,
    select: onSelectCollection,
    onInsertCollection,
    onToggleGroup: toggleGroup,
  }

  /** 筛选期间根节点恒为展开，命中结果才有地方显示。 */
  const rootOpen = filtering || expanded.has(TREE_ROOT_ID)
  const root: ZoteroCollection = {
    key: TREE_ROOT_ID,
    name: libraryName === '' ? t('tree.library') : libraryName,
    parentKey: false,
  }

  return (
    <div style={{ padding: '8px 6px', display: 'flex', flexDirection: 'column' }}>
      <div
        onClick={() => onSelectCollection(root)}
        style={{ ...rowStyle, ...rowIndent(0), ...rowBackground(isSelected(ctx, root)) }}
      >
        {filtering
          ? <span style={iconBox} />
          : <Chevron open={rootOpen} onToggle={() => toggleTreeNode(TREE_ROOT_ID)} />}
        <span style={iconBox}>{glyph(LIBRARY_ICON)}</span>
        <span style={titleStyle}>{t('tree.library')}</span>
      </div>
      {rootOpen && (
        <>
          {recentVisible && (
            <VirtualRows key={RECENT_NODE.key} ctx={ctx} node={RECENT_NODE} depth={1} />
          )}
          {forest.map((node) => (
            <CollectionRows key={node.collection.key} ctx={ctx} node={node} depth={1} />
          ))}
          {virtuals.map((node) => (
            <VirtualRows key={node.key} ctx={ctx} node={node} depth={1} />
          ))}
          {nothingMatched && (
            <div style={{ ...hintStyle, paddingLeft: BASE_INDENT + INDENT }}>{t('tree.emptyFiltered')}</div>
          )}
        </>
      )}

      {(visibleGroups.length > 0 || (groupsError !== null && !filtering)) && (
        <>
          <div style={sectionStyle}>{t('tree.groups')}</div>
          {visibleGroups.length === 0 ? (
            <div style={{ ...hintStyle, color: '#d29922' }}>{groupsError}</div>
          ) : (
            visibleGroups.map((group) => (
              <GroupRows key={group.id} ctx={ctx} group={group} depth={0} />
            ))
          )}
        </>
      )}

      {visibleSearches.length > 0 && (
        <>
          <div style={sectionStyle}>{t('tree.searches')}</div>
          {visibleSearches.map((search) => (
            <SearchRows key={search.key} ctx={ctx} search={search} depth={0} />
          ))}
        </>
      )}
    </div>
  )
}

const hintStyle: React.CSSProperties = { padding: '6px 8px', fontSize: 12, opacity: 0.6 }
