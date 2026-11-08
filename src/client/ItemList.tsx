/**
 * 右栏：当前选择范围的条目列表。
 *
 * 头部含范围名、条数与搜索框；条目行单击选中、双击才开独立 tab，ctrl / cmd 点选
 * 多选，右上角「引用 N」把选中的每条各插一个胶囊。右键单行仍能直接插该条引用。
 * 列表分页（加载更多），筛选后为空与本来为空分开提示。
 *
 * 行内排版是两行：第一行只放标题，第二行小字灰色放「类型 + 年份 + 作者」，
 * 行与行之间用一条浅色细线分隔。
 */

import { useState, type ReactElement } from 'react'

import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroCollection, ZoteroItemSummary } from '../zotero/types'
import { ItemTypeIcon, itemTypeLabel } from './itemType'
import type { Translate } from './locales'
import { tpl } from './locales'
import { TREE_ROOT_ID } from './paneStore'
import { isRead, itemTooltip, readTitleStyle } from './readState'
import { SearchField } from './SearchField'

interface Props {
  t: Translate
  libraryName: string
  selectedCollection: ZoteroCollection | null
  query: string
  items: ZoteroItemSummary[]
  itemsTotal: number
  itemsLoading: boolean
  itemsError: string | null
  selectedTags: ReadonlySet<string>
  tagMode: 'all' | 'any'
  /** 列表里被点选的条目 key；引用按钮按这批插 chip。 */
  selectedItemKeys: ReadonlySet<string>
  onSearch(text: string): void
  onRemoveTag(name: string): void
  onRetry(): void
  onLoadMore(): void
  onOpenItem(key: string, title: string): void
  /** 单击选中；`append`（ctrl / cmd）时切换该项，支持多选。 */
  onSelectItem(key: string, append: boolean): void
  onClearSelection(): void
  onInsertItem(item: ZoteroItemSummary): void
  /** 选中几条插几个条目 chip。 */
  onInsertItems(items: readonly ZoteroItemSummary[]): void
  onInsertCollection(collection: ZoteroCollection): void
}

function selectionName(t: Translate, libraryName: string, collection: ZoteroCollection | null): string {
  if (collection === null || collection.key === TREE_ROOT_ID) {
    return libraryName === '' ? t('tab.title') : libraryName
  }
  return collection.name
}

const hintStyle: React.CSSProperties = { padding: '14px 12px', opacity: 0.6, fontSize: 12.5 }

const headerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px 6px',
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  flexShrink: 0,
}

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  minWidth: 0,
}

/** 行 hover 只染未选中行：选中态用内联背景，优先级更高，不需要额外规则。 */
const ITEM_CSS = '.dsh-zotero-item-row:hover{background:rgba(127,127,127,0.08)}'

/** 行外壳：只负责那条浅色分隔线，通栏铺满。
 *
 * 用 flex 是为了「撑满」：Menu 的 anchor 外面会包一层按内容收窄的元素，
 * 做成 flex 容器后那层被拉伸到整行宽，里面的标题才有确定的宽度可截断。
 */
const itemShellStyle: React.CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid rgba(127,127,127,0.14)',
}

const itemRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 7,
  // Menu 的 anchor 外层是收缩宽度的容器，不显式铺满就会按内容宽度收缩。
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 8px',
  borderRadius: 6,
  cursor: 'pointer',
}

/** 标题独占第一行，可截断。 */
const itemTitleStyle: React.CSSProperties = {
  display: 'block',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 13,
  lineHeight: 1.45,
}

/** 第二行：类型 + 年份 + 作者，小字灰。 */
const itemMetaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  minWidth: 0,
  marginTop: 1,
  fontSize: 11,
  lineHeight: 1.4,
  opacity: 0.5,
}

/** 类型与年份比作者再淡一点：作者是主要识别信息。 */
const itemMetaTypeStyle: React.CSSProperties = { flex: '0 0 auto', opacity: 0.85 }

const itemMetaYearStyle: React.CSSProperties = { flex: '0 0 auto', opacity: 0.85 }

const itemMetaTextStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const itemBodyStyle: React.CSSProperties = { flex: 1, minWidth: 0 }

const itemIconStyle: React.CSSProperties = {
  display: 'flex',
  flexShrink: 0,
  marginTop: 3,
}

/** 头部引用按钮的紧凑尺寸。 */
const citeButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  height: 20,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: 1.2,
}

/** 筛选摘要里的小胶囊。 */
const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  maxWidth: 160,
  padding: '1px 6px',
  borderRadius: 9,
  background: 'rgba(80,140,255,0.14)',
  fontSize: 11.5,
  lineHeight: '17px',
}

const chipRemoveStyle: React.CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 11,
  opacity: 0.65,
  lineHeight: 1,
}

function ItemRow({ t, item, selected, onSelect, onOpen, onInsert }: {
  t: Translate
  item: ZoteroItemSummary
  selected: boolean
  onSelect(key: string, append: boolean): void
  onOpen(key: string, title: string): void
  onInsert(item: ZoteroItemSummary): void
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const read = isRead(item)
  const typeLabel = itemTypeLabel(t, item.itemType)
  return (
    <div style={itemShellStyle}>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === 'insert-item') onInsert(item)
        }}
        align="end"
        portal
        items={[{ id: 'insert-item', label: t('action.insertItem') }]}
        anchor={(
          <div
            className="dsh-zotero-item-row"
            title={itemTooltip(t, item)}
            onClick={(event) => onSelect(item.key, event.ctrlKey || event.metaKey)}
            onDoubleClick={() => onOpen(item.key, item.title)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenuOpen(true)
            }}
            style={selected
              ? { ...itemRowStyle, background: 'rgba(80,140,255,0.16)' }
              : itemRowStyle}
          >
            <span style={itemIconStyle}><ItemTypeIcon itemType={item.itemType} read={read} /></span>
            <div style={itemBodyStyle}>
              <span style={{ ...itemTitleStyle, ...readTitleStyle(read) }}>{item.title}</span>
              {(typeLabel !== '' || item.year !== '' || item.creators !== '') && (
                <div style={itemMetaStyle}>
                  {typeLabel !== '' && <span style={itemMetaTypeStyle}>{typeLabel}</span>}
                  {item.year !== '' && <span style={itemMetaYearStyle}>{item.year}</span>}
                  {item.creators !== '' && <span style={itemMetaTextStyle}>{item.creators}</span>}
                </div>
              )}
            </div>
          </div>
        )}
      />
    </div>
  )
}

export function ItemList(props: Props): ReactElement {
  const {
    t,
    libraryName,
    selectedCollection,
    query,
    items,
    itemsTotal,
    itemsLoading,
    itemsError,
    selectedTags,
    tagMode,
    selectedItemKeys,
    onSearch,
    onRemoveTag,
    onRetry,
    onLoadMore,
    onOpenItem,
    onSelectItem,
    onClearSelection,
    onInsertItem,
    onInsertItems,
    onInsertCollection,
  } = props

  const name = selectionName(t, libraryName, selectedCollection)
  const isRealCollection = selectedCollection !== null
    && selectedCollection.key !== TREE_ROOT_ID
    && selectedCollection.scope === undefined
  const tags = [...selectedTags]
  const filtered = tags.length > 0 || query.trim() !== ''
  /** 按列表顺序取选中项，插进草稿的 chip 顺序才与眼前一致。 */
  const chosen = items.filter((item) => selectedItemKeys.has(item.key))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={headerStyle}>
        <div style={titleRowStyle}>
          <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </strong>
          <span style={{ flexShrink: 0, fontSize: 11.5, opacity: 0.55 }}>
            {tpl(t('list.count'), { n: itemsTotal })}
          </span>
          <div style={{ flex: 1 }} />
          {chosen.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              title={t('action.insertSelected')}
              style={citeButtonStyle}
              onClick={() => onInsertItems(chosen)}
            >
              {tpl(t('action.citeCount'), { n: chosen.length })}
            </Button>
          ) : isRealCollection && selectedCollection !== null ? (
            <Button
              variant="outline"
              size="sm"
              title={t('action.insertCollection')}
              style={citeButtonStyle}
              onClick={() => onInsertCollection(selectedCollection)}
            >
              {t('action.insertItemShort')}
            </Button>
          ) : null}
        </div>
        <SearchField
          value={query}
          placeholder={t('list.searchPlaceholder')}
          clearLabel={t('search.clear')}
          onChange={onSearch}
        />
        {tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, fontSize: 11.5 }}>
            {tags.map((tag) => (
              <span key={tag} style={chipStyle} title={tag}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</span>
                <button
                  type="button"
                  aria-label={t('tags.clear')}
                  title={t('tags.clear')}
                  onClick={() => onRemoveTag(tag)}
                  style={chipRemoveStyle}
                >
                  ×
                </button>
              </span>
            ))}
            {tags.length > 1 && (
              <span style={{ opacity: 0.6 }}>
                {t(tagMode === 'any' ? 'tags.matchAnyHint' : 'tags.matchAllHint')}
              </span>
            )}
          </div>
        )}
      </div>

      <div
        onClick={(event) => {
          if (event.target === event.currentTarget) onClearSelection()
        }}
        style={{ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto', padding: '2px 6px 8px' }}
      >
        <style>{ITEM_CSS}</style>
        {itemsError !== null && items.length === 0 ? (
          <div style={{ padding: '12px 8px', fontSize: 12.5, color: '#d29922' }}>
            <p style={{ margin: '0 0 8px' }}>{tpl(t('list.loadFailed'), { message: itemsError })}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>{t('action.retry')}</Button>
          </div>
        ) : itemsLoading && items.length === 0 ? (
          <div style={hintStyle}>{t('status.loading')}</div>
        ) : items.length === 0 ? (
          <div style={hintStyle}>{t(filtered ? 'list.emptyFiltered' : 'list.empty')}</div>
        ) : (
          <>
            {items.map((item) => (
              <ItemRow
                key={item.key}
                t={t}
                item={item}
                selected={selectedItemKeys.has(item.key)}
                onSelect={onSelectItem}
                onOpen={onOpenItem}
                onInsert={onInsertItem}
              />
            ))}
            {items.length < itemsTotal && (
              <div style={{ padding: '6px 4px' }}>
                <Button variant="ghost" size="sm" disabled={itemsLoading} onClick={onLoadMore}>
                  {t('list.loadMore')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}