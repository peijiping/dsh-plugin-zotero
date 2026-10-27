/**
 * 左栏：文库分类树 + 条目叶子（Zotero 风格）。
 *
 * - 行首常显三角箭头（按住拖动/点击）只管开合；点行体则选中该分类，折叠时顺带展开。
 * - 缩进按层级一次性算出（`depth * INDENT`），不再逐层叠加 margin，避免深层错位。
 * - 分类行右侧显示条目数；展开时其子分类与条目都缩进一层，条目带文档图标。
 * - 「我的文库」根节点**不再平铺全库条目**（这些条目本就挂在各分类下，平铺会造成重复）；
 *   其下额外挂三个虚拟分类：我的出版物 / 未分类条目 / 回收站，与 Zotero 左侧栏一致。
 * - 分类 / 条目右键 → 「添加到会话」。
 * - 展开集合与各节点条目都放在 {@link paneStore}：右侧栏切 tab 时面板正文会被卸载
 *   重挂，局部 state 会丢，只有模块级 store 能让树保持原样。
 */

import { useState, type ReactElement, type ReactNode } from 'react'

import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroCollection, ZoteroItemScope, ZoteroItemSummary } from '../zotero/types'
import type { Translate } from './locales'
import { expandTreeNode, toggleTreeNode, TREE_ROOT_ID, usePaneState, type TreeNodeTarget } from './paneStore'

/** 每层缩进量（px）。 */
const INDENT = 14

/** 树左起始留白（px）。 */
const BASE_INDENT = 8

/** 行高（px）。 */
const ROW_HEIGHT = 24

/** 一次加载节点条目所需的定位信息。 */
type LoadOpts = TreeNodeTarget

/** 虚拟分类定义（顺序与 Zotero 左侧栏一致，排在真实分类之后）。 */
interface VirtualNode {
  key: string
  scope: ZoteroItemScope
  labelKey: string
  icon: string
}

const VIRTUAL_NODES: readonly VirtualNode[] = [
  { key: '@publications', scope: 'publications', labelKey: 'tree.publications', icon: 'BOOK' },
  { key: '@unfiled', scope: 'unfiled', labelKey: 'tree.unfiled', icon: 'UNFILED' },
  { key: '@trash', scope: 'trash', labelKey: 'tree.trash', icon: 'TRASH' },
]

interface CollectionNode {
  collection: ZoteroCollection
  children: CollectionNode[]
}

interface TreeCtx {
  t: Translate
  expanded: ReadonlySet<string>
  itemsByNode: Record<string, ZoteroItemSummary[]>
  totalsByNode: Record<string, number>
  selectedItemKey: string | null
  selectedCollectionKey: string | null
  /** 三角箭头：只开合，不动选中态。 */
  toggle(nodeId: string, collection?: ZoteroCollection): void
  /** 行体：选中该分类（已折叠则顺带展开并拉取条目）。 */
  select(collection: ZoteroCollection): void
  onSelectItem(key: string): void
  onInsertItem(key: string): void
  onInsertCollection(collection: ZoteroCollection): void
}

interface Props {
  t: Translate
  collections: ZoteroCollection[]
  selectedItemKey: string | null
  selectedCollectionKey: string | null
  onSelectItem(key: string): void
  onSelectCollection(collection: ZoteroCollection): void
  onInsertItem(key: string): void
  onInsertCollection(collection: ZoteroCollection): void
}

// ---- 图标（内联 SVG，避免依赖宿主图标导出名） -----------------------------

function glyph(path: string): ReactNode {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      style={{ opacity: 0.65 }}
    >
      <path d={path} />
    </svg>
  )
}

const FOLDER_ICON = 'M2.5 12.5V4.5a1 1 0 0 1 1-1h3L8 5h4.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z'
const ITEM_ICON = 'M4.5 2.5h5L12 5v8.5H4.5zM9.5 2.5V5H12'
const LIBRARY_ICON = 'M2.5 3.5h5v9h-5zM8.5 3.5h5v9h-5z'

/** 虚拟分类图标：我的出版物（书）/ 未分类条目（文件夹）/ 回收站（垃圾桶）。 */
const BOOK_ICON = 'M3 2.8 8 2l5 0.8v10.4L8 14l-5-0.8zM8 2v12'
const TRASH_ICON = 'M3.2 4.5h9.6M6.3 4.5V3h3.4v1.5M4.6 4.5l0.6 9.2h5.6l0.6-9.2M6.8 7v4.4M9.2 7v4.4'

/** 虚拟分类的图标 path（键与 {@link VIRTUAL_NODES.icon} 对应）。 */
const VIRTUAL_ICON: Record<string, string> = {
  BOOK: BOOK_ICON,
  UNFILED: FOLDER_ICON,
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

/** 由分类对象推出加载用的定位信息：虚拟分类走 scope，真实分类走 collectionKey。 */
function loadOpts(collection: ZoteroCollection): LoadOpts {
  return collection.scope === undefined ? { collectionKey: collection.key } : { scope: collection.scope }
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

function rowBackground(selected: boolean): React.CSSProperties {
  return { background: selected ? 'rgba(127,127,127,0.16)' : 'transparent' }
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

const metaStyle: React.CSSProperties = {
  flexShrink: 0,
  maxWidth: '48%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.5,
  fontSize: 11.5,
}

const countStyle: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 14,
  textAlign: 'right',
  fontSize: 11.5,
  opacity: 0.5,
}

function hintStyle(depth: number): React.CSSProperties {
  return {
    opacity: 0.55,
    fontSize: 12,
    lineHeight: `${ROW_HEIGHT}px`,
    paddingLeft: BASE_INDENT + depth * INDENT + 22,
  }
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

// ---- 条目叶子 ---------------------------------------------------------------

function ItemRow({ ctx, item, depth }: { ctx: TreeCtx; item: ZoteroItemSummary; depth: number }): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const meta = [item.creators, item.year].filter((part) => part !== '').join(' · ')
  return (
    <Menu
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      onSelect={(id) => {
        setMenuOpen(false)
        if (id === 'insert-item') ctx.onInsertItem(item.key)
      }}
      align="end"
      portal
      items={[{ id: 'insert-item', label: ctx.t('action.insertItem') }]}
      anchor={(
        <div
          onClick={() => ctx.onSelectItem(item.key)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(ctx.selectedItemKey === item.key) }}
        >
          <span style={iconBox} />
          <span style={iconBox}>{glyph(ITEM_ICON)}</span>
          <span style={titleStyle} title={item.title}>{item.title}</span>
          {meta !== '' && <span style={metaStyle}>{meta}</span>}
        </div>
      )}
    />
  )
}

function renderItems(ctx: TreeCtx, nodeId: string, depth: number): ReactElement[] {
  const items = ctx.itemsByNode[nodeId]
  if (items === undefined) {
    return [<div key="loading" style={hintStyle(depth)}>{ctx.t('status.loading')}</div>]
  }
  if (items.length === 0) {
    return [<div key="empty" style={hintStyle(depth)}>{ctx.t('tree.empty')}</div>]
  }
  return items.map((item) => <ItemRow key={item.key} ctx={ctx} item={item} depth={depth} />)
}

// ---- 分类节点（扁平化渲染：每行自带缩进，天然成树） -------------------------

function CollectionRows({ ctx, node, depth }: { ctx: TreeCtx; node: CollectionNode; depth: number }): ReactElement {
  const nodeId = node.collection.key
  const open = ctx.expanded.has(nodeId)
  const [menuOpen, setMenuOpen] = useState(false)
  const count = ctx.totalsByNode[nodeId] ?? node.collection.itemCount

  return (
    <>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'insert-collection') ctx.onInsertCollection(node.collection)
        }}
        align="end"
        portal
        items={[{ id: 'insert-collection', label: ctx.t('action.insertCollection') }]}
        anchor={(
          <div
            onClick={() => ctx.select(node.collection)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuOpen(true)
            }}
            style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(ctx.selectedCollectionKey === nodeId) }}
          >
            <Chevron open={open} onToggle={() => ctx.toggle(nodeId, node.collection)} />
            <span style={iconBox}>{glyph(FOLDER_ICON)}</span>
            <span style={titleStyle} title={node.collection.name}>{node.collection.name}</span>
            {count !== undefined && <span style={countStyle}>{count}</span>}
          </div>
        )}
      />
      {open &&
        node.children.map((child) => (
          <CollectionRows key={child.collection.key} ctx={ctx} node={child} depth={depth + 1} />
        ))}
      {open && renderItems(ctx, nodeId, depth + 1)}
    </>
  )
}

// ---- 虚拟分类（我的出版物 / 未分类条目 / 回收站） ---------------------------

function virtualCollection(node: VirtualNode, t: Translate): ZoteroCollection {
  return { key: node.key, name: t(node.labelKey), parentKey: false, scope: node.scope }
}

function VirtualRows({ ctx, node, depth }: { ctx: TreeCtx; node: VirtualNode; depth: number }): ReactElement {
  const collection = virtualCollection(node, ctx.t)
  const nodeId = collection.key
  const open = ctx.expanded.has(nodeId)
  const [menuOpen, setMenuOpen] = useState(false)
  // 虚拟分类的条目数只有展开（拉取过）后才知道，未拉取时不显示。
  const count = ctx.totalsByNode[nodeId]

  return (
    <>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'insert-collection') ctx.onInsertCollection(collection)
        }}
        align="end"
        portal
        items={[{ id: 'insert-collection', label: ctx.t('action.insertCollection') }]}
        anchor={(
          <div
            onClick={() => ctx.select(collection)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuOpen(true)
            }}
            style={{ ...rowStyle, ...rowIndent(depth), ...rowBackground(ctx.selectedCollectionKey === nodeId) }}
          >
            <Chevron open={open} onToggle={() => ctx.toggle(nodeId, collection)} />
            <span style={iconBox}>{glyph(VIRTUAL_ICON[node.icon] ?? FOLDER_ICON)}</span>
            <span style={titleStyle} title={collection.name}>{collection.name}</span>
            {count !== undefined && <span style={countStyle}>{count}</span>}
          </div>
        )}
      />
      {open && renderItems(ctx, nodeId, depth + 1)}
    </>
  )
}

// ---- 树容器 -----------------------------------------------------------------

export function CollectionTree(props: Props): ReactElement {
  const {
    t,
    collections,
    selectedItemKey,
    selectedCollectionKey,
    onSelectItem,
    onSelectCollection,
    onInsertItem,
    onInsertCollection,
  } = props

  /** 展开集合与各节点条目都在 store 里（默认展开根节点），重挂面板后原样恢复。 */
  const { expanded, nodeItems, nodeTotals } = usePaneState()

  /** 按需拉取：条目一律由 toggle / select 触发，根节点不再预取全库条目。 */
  function open(nodeId: string, collection: ZoteroCollection): void {
    expandTreeNode(nodeId, loadOpts(collection))
  }

  function toggle(nodeId: string, collection?: ZoteroCollection): void {
    toggleTreeNode(nodeId, collection === undefined ? undefined : loadOpts(collection))
  }

  function select(collection: ZoteroCollection): void {
    onSelectCollection(collection)
    if (!expanded.has(collection.key)) open(collection.key, collection)
  }

  const ctx: TreeCtx = {
    t,
    expanded,
    itemsByNode: nodeItems,
    totalsByNode: nodeTotals,
    selectedItemKey,
    selectedCollectionKey,
    toggle,
    select,
    onSelectItem,
    onInsertItem,
    onInsertCollection,
  }

  const rootOpen = expanded.has(TREE_ROOT_ID)

  return (
    <div style={{ padding: '8px 6px', display: 'flex', flexDirection: 'column' }}>
      <div
        onClick={() => toggle(TREE_ROOT_ID)}
        style={{ ...rowStyle, ...rowIndent(0) }}
      >
        <Chevron open={rootOpen} onToggle={() => toggle(TREE_ROOT_ID)} />
        <span style={iconBox}>{glyph(LIBRARY_ICON)}</span>
        <span style={titleStyle}>{t('tree.library')}</span>
      </div>
      {rootOpen && (
        <>
          {buildForest(collections).map((node) => (
            <CollectionRows key={node.collection.key} ctx={ctx} node={node} depth={1} />
          ))}
          {VIRTUAL_NODES.map((node) => (
            <VirtualRows key={node.key} ctx={ctx} node={node} depth={1} />
          ))}
        </>
      )}
    </div>
  )
}
