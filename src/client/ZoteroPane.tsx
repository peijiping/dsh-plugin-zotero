/**
 * 右侧栏面板容器：头部状态栏 + 左侧分类树 / 标签面板 + 右侧条目列表。
 *
 * 与 Zotero 一致：左侧只有分类与标签，条目一律在右侧列表；列表行单击选中、
 * 双击才在本面板顶层开独立 tab（`onOpenItem`），详情不再占列表位置。
 * 标签面板跟随当前目录：选中目录只列该目录自身的标签，切目录清空已选。
 *
 * 两栏之间是可拖动的分隔条（宽度存 localStorage，跨会话/重启都记住）。
 * 数据与选择状态都在 {@link paneStore} 的模块级单例里（跨会话共用同一块面板）。
 * 「添加到会话」走 ui-conversation 下发的会话级标准 prop：条目（含多选批量）、
 * 整目录、标签组都插引用 chip（见 reference.ts），摘录仍插纯文本。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { CollectionTree } from './CollectionTree'
import type { InputActions } from './inline'
import { ItemList } from './ItemList'
import type { Translate } from './locales'
import {
  clearFilters,
  clearItemSelection,
  clearTags,
  loadMoreItems,
  loadTree,
  retryItems,
  retryTags,
  selectCollection,
  selectItem,
  setQuery,
  setTagMode,
  setTagQuery,
  toggleTag,
  TREE_ROOT_ID,
  usePaneState,
} from './paneStore'
import type { SessionsFace } from './reference'
import { TagPanel } from './TagPanel'
import { Toast } from './Toast'
import { useInsertion } from './useInsertion'

/** 左栏宽度的存储键与取值范围。 */
const TREE_WIDTH_KEY = 'dsh-plugin-zotero.treeWidth'
const TREE_WIDTH_DEFAULT = 260
const TREE_WIDTH_MIN = 180
/** 右栏至少留出的宽度。 */
const DETAIL_WIDTH_MIN = 220

function readTreeWidth(): number {
  try {
    const value = Number.parseInt(window.localStorage.getItem(TREE_WIDTH_KEY) ?? '', 10)
    return Number.isFinite(value) && value >= TREE_WIDTH_MIN ? value : TREE_WIDTH_DEFAULT
  } catch {
    return TREE_WIDTH_DEFAULT
  }
}

interface Props {
  t: Translate
  /** ui-conversation 下发的会话级操作集；不在会话上下文时为 undefined。 */
  inputActions?: InputActions
  /** 会话作用域入口（插 chip 用），由入口闭包根 ctx 的 `sessions` 下发。 */
  sessions: SessionsFace
  /** 当前会话 id；chip 只认它自己那一个会话的输入框。 */
  sessionId?: string
  /** 在右侧栏顶层为条目开独立 tab。 */
  onOpenItem(key: string, title?: string): void
}

function StatusDot({ ok, label }: { ok: boolean; label: string }): ReactElement {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, opacity: 0.8 }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: ok ? '#3fb950' : '#d29922',
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  )
}

export function ZoteroPane({ t, inputActions, sessions, sessionId, onOpenItem }: Props): ReactElement {
  const {
    health,
    libraryName,
    collections,
    treeError,
    treeLoading,
    selectedCollection,
    query,
    items,
    itemsTotal,
    itemsLoading,
    itemsError,
    tags,
    tagsLoading,
    tagsError,
    tagQuery,
    selectedTags,
    tagMode,
    tagUsage,
    tagUsageLoading,
    selectedItemKeys,
  } = usePaneState()

  useEffect(() => {
    void loadTree()
  }, [])

  const insertion = useInsertion(t, sessions, sessionId, inputActions)

  const [treeWidth, setTreeWidth] = useState(readTreeWidth)
  const [splitHover, setSplitHover] = useState(false)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; width: number } | null>(null)

  /** 左栏宽度夹在 [TREE_WIDTH_MIN, 容器宽 - DETAIL_WIDTH_MIN] 之间。 */
  function clampTreeWidth(next: number): number {
    const total = bodyRef.current?.clientWidth ?? 0
    const max = Math.max(TREE_WIDTH_MIN, total - DETAIL_WIDTH_MIN)
    return Math.min(Math.max(next, TREE_WIDTH_MIN), max)
  }

  function onSplitterDown(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, width: treeWidth }
  }

  function onSplitterMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (drag === null) return
    setTreeWidth(clampTreeWidth(drag.width + event.clientX - drag.x))
  }

  function onSplitterUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    try {
      window.localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth))
    } catch {
      // 隐私模式等禁用 localStorage 时忽略，宽度仍在本会话内生效。
    }
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          borderBottom: '1px solid rgba(127,127,127,0.2)',
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13 }}>{libraryName === '' ? t('tab.title') : libraryName}</strong>
        <StatusDot ok={health?.zotero.running === true} label={t(health?.zotero.running === true ? 'status.zoteroOn' : 'status.zoteroOff')} />
        <StatusDot ok={health?.mcp.running === true} label={t(health?.mcp.running === true ? 'status.mcpOn' : 'status.mcpOff')} />
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={() => void loadTree(true)}>
          {t('action.refresh')}
        </Button>
      </header>

      <div ref={bodyRef} style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <aside
          style={{
            width: treeWidth,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {treeLoading && collections.length === 0 ? (
              <div style={hintStyle}>{t('status.loading')}</div>
            ) : treeError !== null ? (
              <div style={{ ...hintStyle, color: '#d29922' }}>{treeError}</div>
            ) : (
              <CollectionTree
                t={t}
                libraryName={libraryName}
                collections={collections}
                selectedCollectionKey={selectedCollection?.key ?? null}
                onSelectCollection={selectCollection}
                onInsertCollection={insertion.insertCollection}
              />
            )}
          </div>
          <TagPanel
            t={t}
            tags={tags}
            tagsLoading={tagsLoading}
            tagsError={tagsError}
            tagQuery={tagQuery}
            selectedTags={selectedTags}
            tagMode={tagMode}
            scoped={selectedCollection !== null && selectedCollection.key !== TREE_ROOT_ID}
            tagUsage={tagUsage}
            tagUsageLoading={tagUsageLoading}
            onTagQuery={setTagQuery}
            onToggleTag={toggleTag}
            onClearTags={clearTags}
            onSetTagMode={setTagMode}
            onRetry={retryTags}
            onInsertTag={insertion.insertTag}
            onInsertTagSet={insertion.insertTagSet}
          />
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onSplitterDown}
          onPointerMove={onSplitterMove}
          onPointerUp={onSplitterUp}
          onPointerCancel={onSplitterUp}
          onPointerEnter={() => setSplitHover(true)}
          onPointerLeave={() => setSplitHover(false)}
          style={{
            flexShrink: 0,
            width: 5,
            display: 'flex',
            justifyContent: 'center',
            cursor: 'col-resize',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <span
            style={{
              width: 1,
              height: '100%',
              background: splitHover || dragRef.current !== null ? 'rgba(80,140,255,0.75)' : 'rgba(127,127,127,0.2)',
            }}
          />
        </div>

        <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ItemList
            t={t}
            libraryName={libraryName}
            selectedCollection={selectedCollection}
            query={query}
            items={items}
            itemsTotal={itemsTotal}
            itemsLoading={itemsLoading}
            itemsError={itemsError}
            selectedTags={selectedTags}
            tagMode={tagMode}
            selectedItemKeys={selectedItemKeys}
            onSearch={setQuery}
            onClearFilters={clearFilters}
            onRemoveTag={toggleTag}
            onRetry={retryItems}
            onLoadMore={loadMoreItems}
            onOpenItem={onOpenItem}
            onSelectItem={selectItem}
            onClearSelection={clearItemSelection}
            onInsertItem={(item) => insertion.insertItem(item.key, item.title)}
            onInsertItems={insertion.insertItems}
            onInsertCollection={insertion.insertCollection}
          />
        </section>
      </div>

      <Toast />
    </div>
  )
}

const hintStyle: React.CSSProperties = { padding: '14px 12px', opacity: 0.6, fontSize: 12.5 }
