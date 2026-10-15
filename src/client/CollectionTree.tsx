/**
 * 左栏：文库分类树 + 条目叶子。
 *
 * - 根节点「我的文库」展开 = 全库顶层条目（`items/top`）。
 * - 分类节点按 `parentCollection` 嵌套；展开时按需拉该分类的顶层条目（limit=200）。
 * - 条目叶子点击选中 → 右栏显示详情；右键 → 「添加条目引用」。
 * - 分类节点展开即选中 → 右栏显示分类概要（可插入整目录引用）。
 */

import { useState, type ReactElement, type ReactNode } from 'react'

import { DisclosureRow, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroCollection, ZoteroItemSummary } from '../zotero/types'
import { fetchItems } from './api'
import type { Translate } from './locales'

/** 每个节点一次最多拉取的条目数。 */
const NODE_LIMIT = 200

const ROOT_NODE = '__library__'

interface CollectionNode {
  collection: ZoteroCollection
  children: CollectionNode[]
}

interface TreeCtx {
  t: Translate
  expanded: ReadonlySet<string>
  itemsByNode: Record<string, ZoteroItemSummary[]>
  selectedItemKey: string | null
  selectedCollectionKey: string | null
  toggle(nodeId: string, collectionKey?: string, select?: ZoteroCollection): void
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

const COLLECTION_ICON = 'M3 3.5h10M3 7.5h10M3 11.5h10'
const ITEM_ICON = 'M4 2.5h6l2.5 2.5v8.5H4zM10 2.5V5h2.5'
const LIBRARY_ICON = 'M2.5 3.5h5v9h-5zM8.5 3.5h5v9h-5z'

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

// ---- 样式 -------------------------------------------------------------------

const muted: React.CSSProperties = { opacity: 0.55, fontSize: 12, padding: '2px 0 2px 8px' }

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  padding: '3px 6px 3px 8px',
  fontSize: 12.5,
  lineHeight: 1.5,
  borderRadius: 5,
  cursor: 'pointer',
}

function rowBackground(selected: boolean): React.CSSProperties {
  return { background: selected ? 'rgba(127,127,127,0.16)' : 'transparent' }
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

// ---- 条目叶子 ---------------------------------------------------------------

function ItemRow({ ctx, item }: { ctx: TreeCtx; item: ZoteroItemSummary }): ReactElement {
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
          style={{ ...rowStyle, ...rowBackground(ctx.selectedItemKey === item.key) }}
        >
          <span style={{ flexShrink: 0, display: 'flex' }}>{glyph(ITEM_ICON)}</span>
          <span style={titleStyle} title={item.title}>{item.title}</span>
          {meta !== '' && <span style={metaStyle}>{meta}</span>}
        </div>
      )}
    />
  )
}

function renderItems(ctx: TreeCtx, nodeId: string): ReactElement[] {
  const items = ctx.itemsByNode[nodeId]
  if (items === undefined) {
    return [<div key="loading" style={muted}>{ctx.t('status.loading')}</div>]
  }
  if (items.length === 0) {
    return [<div key="empty" style={muted}>{ctx.t('tree.empty')}</div>]
  }
  return items.map((item) => <ItemRow key={item.key} ctx={ctx} item={item} />)
}

// ---- 分类节点 ---------------------------------------------------------------

function CollectionNodeRow({
  ctx,
  node,
  depth,
}: {
  ctx: TreeCtx
  node: CollectionNode
  depth: number
}): ReactElement {
  const nodeId = node.collection.key
  const open = ctx.expanded.has(nodeId)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
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
          onContextMenu={(event) => {
            event.preventDefault()
            setMenuOpen(true)
          }}
          style={rowBackground(ctx.selectedCollectionKey === nodeId)}
        >
          <DisclosureRow
            icon={glyph(COLLECTION_ICON)}
            title={node.collection.name}
            open={open}
            expandable
            onToggle={() => ctx.toggle(nodeId, node.collection.key, node.collection)}
            titleClassName={undefined}
          >
            <div style={{ marginLeft: depth * 10 + 12 }}>
              {open
                ? [
                    ...node.children.map((child) => (
                      <CollectionNodeRow key={child.collection.key} ctx={ctx} node={child} depth={depth + 1} />
                    )),
                    ...renderItems(ctx, nodeId),
                  ]
                : null}
            </div>
          </DisclosureRow>
        </div>
      )}
    />
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

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [itemsByNode, setItemsByNode] = useState<Record<string, ZoteroItemSummary[]>>({})

  async function load(nodeId: string, collectionKey?: string): Promise<void> {
    if (itemsByNode[nodeId] !== undefined) return
    let items: ZoteroItemSummary[] = []
    try {
      items = (await fetchItems({ collectionKey, limit: NODE_LIMIT })).items
    } catch {
      items = []
    }
    setItemsByNode((prev) => ({ ...prev, [nodeId]: items }))
  }

  function toggle(nodeId: string, collectionKey?: string, select?: ZoteroCollection): void {
    const willOpen = !expanded.has(nodeId)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (willOpen) next.add(nodeId)
      else next.delete(nodeId)
      return next
    })
    if (!willOpen) return
    void load(nodeId, collectionKey)
    if (select !== undefined) onSelectCollection(select)
  }

  const ctx: TreeCtx = {
    t,
    expanded,
    itemsByNode,
    selectedItemKey,
    selectedCollectionKey,
    toggle,
    onSelectItem,
    onInsertItem,
    onInsertCollection,
  }

  const rootOpen = expanded.has(ROOT_NODE)

  return (
    <div style={{ padding: '8px 6px' }}>
      <div style={rowBackground(false)}>
        <DisclosureRow
          icon={glyph(LIBRARY_ICON)}
          title={t('tree.library')}
          open={rootOpen}
          expandable
          onToggle={() => toggle(ROOT_NODE)}
        >
          <div style={{ marginLeft: 12 }}>
            {rootOpen
              ? [
                  ...buildForest(collections).map((node) => (
                    <CollectionNodeRow key={node.collection.key} ctx={ctx} node={node} depth={1} />
                  )),
                  ...renderItems(ctx, ROOT_NODE),
                ]
              : null}
          </div>
        </DisclosureRow>
      </div>
    </div>
  )
}
