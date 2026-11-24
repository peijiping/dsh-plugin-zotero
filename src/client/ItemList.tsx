/**
 * 右栏：当前选择范围的条目列表。
 *
 * 头部含范围名、条数与搜索框；条目行单击选中、双击才开独立 tab，ctrl / cmd 点选
 * 多选。条目的三个动作（加入对话 / 复制参考文献 / 综述对比）统一走右键菜单：
 * 菜单按整批选中条目生成，单选两项、多选三项，头部不再堆多选按钮。
 * 列表不分页：当前范围的条目一次加载完（与 Zotero 一致），大口库分批追加，
 * 底部只显示加载进度。筛选后为空与本来为空分开提示。
 *
 * 标题排序按钮只在真实分类 / 虚拟分类下出现：「最近阅读」恒按最后打开时间倒序，
 * 那一栏不给排序入口（见 {@link isRecentSelection}）。
 *
 * 行内排版是两行：第一行只放标题，第二行小字灰色放「类型 + 年份 + 作者」，
 * 行与行之间用一条浅色细线分隔。
 */

import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

import { isBibliographyStyle, MAX_BIBLIOGRAPHY_ITEMS, type BibliographyStyle } from '../zotero/bibliography'
import type { ZoteroChildKind, ZoteroCollection, ZoteroItemSummary, ZoteroSearchMode } from '../zotero/types'
import { fetchBibliography } from './api'
import { bibliographySkipReason, bibliographyStyles, formatBibliography } from './bibliography'
import { writeClipboard } from './clipboard'
import { useDismiss } from './dismiss'
import { ChildKindIcon, childKindLabel, ItemTypeIcon, itemTypeLabel } from './itemType'
import {
  ITEM_MENU_INSERT,
  ITEM_MENU_REVIEW,
  itemMenuEntries,
  type ItemMenuEntry,
  type ItemMenuIconName,
} from './itemContextMenu'
import type { Translate } from './locales'
import { tpl } from './locales'
import type { ItemSort } from './paneStore'
import { isRecentSelection, showToast, TREE_ROOT_ID } from './paneStore'
import { isRead, itemTooltip, readTitleStyle } from './readState'
import { SearchField, type SearchModeItem } from './SearchField'
import { Button, SectionTitle } from './ui'

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
  /** 当前标题排序状态（原始 / 正序 / 倒序）。 */
  sort: ItemSort
  /** 搜索口径：与 Zotero 搜索框左侧的三档一致。 */
  searchMode: ZoteroSearchMode
  /** 列表里被点选的条目 key；引用按钮按这批插 chip。 */
  selectedItemKeys: ReadonlySet<string>
  onSearch(text: string): void
  onSearchModeChange(mode: ZoteroSearchMode): void
  onRemoveTag(name: string): void
  onRetry(): void
  /** 点排序图标：原始 → 正序 → 倒序 循环。 */
  onCycleSort(): void
  onOpenItem(key: string, title: string): void
  /** 单击选中；`append`（ctrl / cmd）时切换该项，支持多选。右键未选中行时排他选中它。 */
  onSelectItem(key: string, append: boolean): void
  onClearSelection(): void
  onInsertItem(item: ZoteroItemSummary): void
  /** 选中几条插几个条目 chip。 */
  onInsertItems(items: readonly ZoteroItemSummary[]): void
  onReviewItems?(items: readonly ZoteroItemSummary[]): void
}

function selectionName(t: Translate, libraryName: string, collection: ZoteroCollection | null): string {
  if (collection === null || collection.key === TREE_ROOT_ID) {
    return libraryName === '' ? t('tab.title') : libraryName
  }
  return collection.name
}

const hintStyle: React.CSSProperties = { padding: '14px 12px', opacity: 0.6, fontSize: 12.5 }

const bibliographyBarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: 12,
}

const bibliographyResultStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid color-mix(in srgb, currentColor 16%, transparent)',
  borderRadius: 6,
  fontSize: 12,
}

const bibliographySkippedStyle: React.CSSProperties = {
  margin: '4px 0 0',
  paddingInlineStart: 18,
  maxHeight: 100,
  overflowY: 'auto',
  overflowWrap: 'anywhere',
}

/** 底部分批进度：列表仍在追加后面几批时露一行，取满即消失。 */
const progressStyle: React.CSSProperties = {
  padding: '6px 8px 2px',
  opacity: 0.5,
  fontSize: 11.5,
  textAlign: 'center',
}

/** 分批加载中途失败时贴在末尾的提示行。 */
const partialStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 4px 2px',
  fontSize: 11.5,
  color: '#d29922',
}

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
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

/** 底色（hover / 选中）统一挂在通栏外壳上。 */
const ITEM_CSS = [
  '.dsh-zotero-item-shell:hover{background:rgba(127,127,127,0.08)}',
  '.dsh-zotero-disclosure:hover{opacity:0.8}',
  '.dsh-zotero-child-row:hover{background:rgba(127,127,127,0.1)}',
  '.dsh-zotero-item-context [role="menu"]:not([role="menu"] [role="menu"]){position:absolute;inset:0 auto auto 0;position-area:none;margin:0}',
  '.dsh-zotero-context-open-left [role="menu"] [role="menu"]{left:auto;right:calc(100% + 10px)}',
  '.dsh-zotero-context-open-left [role="menu"] [role="menu"]::before{left:auto;right:-10px}',
].join('')

const ITEM_MENU_GUTTER = 8
/** 给包含国标样式全称的子菜单留出横向空间。 */
const ITEM_SUBMENU_SPACE = 250

/** 选中行底色：整行（外壳）通栏染色，色值与列表 chip 同一支蓝。 */
const ITEM_SELECTED_BG = 'rgba(80,140,255,0.16)'

/**
 * 行外壳：承载整行底色 + 那条浅色分隔线，通栏铺满。
 *
 * 单列 grid 给内层一个明确的行宽，允许轨道收窄，让长标题正常显示省略号。
 */
const itemShellStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  width: '100%',
  boxSizing: 'border-box',
  borderRadius: 6,
  borderBottom: '1px solid rgba(127,127,127,0.14)',
}

const itemRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 7,
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 8px',
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

/** 第二行末尾的子项统计：一组「类型图标 + 数字」，靠右且不参与作者截断。 */
const itemMetaChildKindsStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  // 作者缺失时没有可伸展元素把统计顶到右边，这里显式靠右对齐。
  marginLeft: 'auto',
  opacity: 0.85,
}

/** 单种类型的「图标 + 个数」。 */
const itemMetaChildKindStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  flex: '0 0 auto',
}

const itemMetaTextStyle: React.CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const itemBodyStyle: React.CSSProperties = { flex: 1, minWidth: 0 }

/**
 * 展开三角的占位槽：始终占 12px，没有附件的行也留着，
 * 这样整列类型图标和标题起点才对齐（与 Zotero 的树列一致）。
 */
const disclosureSlotStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 12,
  height: 24,
  marginTop: 1,
}

const disclosureButtonStyle: React.CSSProperties = {
  ...disclosureSlotStyle,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  opacity: 0.45,
  cursor: 'pointer',
}

/** 展开后的子附件列表：缩进到主行标题的起点，与父条目的标题左对齐。 */
const childListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  padding: '0 6px 4px',
}

const childRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  // 6(列表内边距) + 52 = 58，正好对上主行标题起点。
  padding: '2px 4px 2px 52px',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 12,
  opacity: 0.85,
}

const childIconStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 16,
  height: 16,
}

const childTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 图标固定占位 24px，只居中图标本身，不铺底色。 */
const itemIconStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 24,
  height: 24,
  marginTop: 1,
}

/** 排序图标按钮：与列表标题行同高，只放图标。 */
const sortButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  height: 20,
  padding: '0 4px',
  lineHeight: 1,
}

/** 排序生效时的图标颜色（与列表选中态同一支蓝）。 */
const SORT_ACTIVE_COLOR = '#508cff'

/** 副标题统计的固定顺序：先看得到 PDF / 快照，再看笔记与其余文件。 */
const CHILD_KIND_ORDER: readonly ZoteroChildKind[] = ['pdf', 'snapshot', 'webpage', 'note', 'file']

/**
 * 排序图标：三条长短不一的横线 + 右侧方向箭头。
 *
 * 未排序时箭头两头都画（提示「可点」）且整体偏淡；正序朝上、倒序朝下并染色。
 */
function SortIcon({ sort }: { sort: ItemSort }): ReactElement {
  const active = sort !== 'none'
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M2.4 3.6h7.2M2.4 8h4.8M2.4 12.4h2.8" opacity={active ? 1 : 0.75} />
      {sort === 'none' ? (
        <path d="M13 4.2v7.6M13 4.2l-1.5 1.7M13 4.2l1.5 1.7M13 11.8l-1.5-1.7M13 11.8l1.5-1.7" opacity={0.5} />
      ) : (
        <path d={sort === 'asc' ? 'M13 12.2V4M13 4l-1.7 1.9M13 4l1.7 1.9' : 'M13 3.8V12M13 12l-1.7-1.9M13 12l1.7-1.9'} />
      )}
    </svg>
  )
}

/** 展开 / 收起的小三角，Zotero 树里同款：收起朝右、展开朝下。 */
function DisclosureIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width={8}
      height={8}
      viewBox="0 0 8 8"
      aria-hidden
      focusable="false"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
    >
      <path d="M2.4 1.4 6.1 4l-3.7 2.6z" fill="currentColor" />
    </svg>
  )
}

/** 排序按钮的提示文案随状态变，点了知道下一步会变成什么。 */
function sortHint(t: Translate, sort: ItemSort): string {
  if (sort === 'asc') return t('list.sortAsc')
  if (sort === 'desc') return t('list.sortDesc')
  return t('list.sortNone')
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

const ITEM_MENU_ICON_PATHS: Record<ItemMenuIconName, string> = {
  chat: 'M18 11h-7l-4 3v-3H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2Z',
  copy: 'M8 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2ZM3 16V5a2 2 0 0 1 2-2h10',
  // 左右两份文档并排：与「合并成一篇」的图标区分开，用于「综述对比」。
  review: 'M4 4h7v16H4zM13 4h7v16h-7zM6.5 9h2M6.5 13h2M15.5 9h2M15.5 13h2',
  text: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6',
  numbers: 'M10 6h10m-10 6h10m-10 6h10M3 4h2v4m-2 0h4m-4 3h3a1 1 0 0 1 0 2h-2l-1 2h4',
}

function ItemMenuIcon({ name }: { name: ItemMenuIconName }): ReactElement {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ITEM_MENU_ICON_PATHS[name]} />
    </svg>
  )
}

function toMenuEntry(entry: ItemMenuEntry): MenuEntry {
  return {
    id: entry.id,
    label: entry.label,
    disabled: entry.disabled,
    icon: <ItemMenuIcon name={entry.icon} />,
    submenu: entry.submenu?.map((style) => ({
      ...style,
      icon: <ItemMenuIcon name={style.icon} />,
    })),
  }
}

interface MenuPoint {
  x: number
  y: number
}

function ItemContextMenu({ point, items, onClose, onSelect }: {
  point: MenuPoint
  items: readonly MenuEntry[]
  onClose(): void
  onSelect(id: string): void
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  // 宿主处理外部点击，包括可能独立挂载的子菜单。这里只补全 Esc 关闭。
  useDismiss(true, containerRef, onClose, { pinned: true })

  useLayoutEffect(() => {
    const container = containerRef.current
    const menu = container?.querySelector<HTMLElement>('[role="menu"]')
    if (container === null || !menu) return
    const position = (): void => {
      const { width, height } = menu.getBoundingClientRect()
      const { clientWidth, clientHeight } = document.documentElement
      const x = Math.max(ITEM_MENU_GUTTER, Math.min(point.x, clientWidth - width - ITEM_MENU_GUTTER))
      const y = Math.max(ITEM_MENU_GUTTER, Math.min(point.y + 4, clientHeight - height - ITEM_MENU_GUTTER))
      container.style.left = `${x}px`
      container.style.top = `${y}px`
      container.classList.toggle('dsh-zotero-context-open-left', x + width + ITEM_SUBMENU_SPACE > clientWidth)
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(menu)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [point])

  return createPortal(
    // 直接摆放整个菜单，宿主 Menu 仍负责交互和绘制。
    <div ref={containerRef} className="dsh-zotero-item-context"
      style={{ display: 'flex', position: 'fixed', left: point.x, top: point.y, zIndex: 1000 }}>
      <Menu
        open
        portal={false}
        onClose={onClose}
        onSelect={onSelect}
        items={items}
        anchor={<span aria-hidden="true" />}
      />
    </div>,
    document.body,
  )
}

function ItemRow({ t, item, selected, onSelect, onOpen, menuItems, onMenuSelect }: {
  t: Translate
  item: ZoteroItemSummary
  selected: boolean
  onSelect(key: string, append: boolean): void
  onOpen(key: string, title: string): void
  menuItems: readonly MenuEntry[]
  onMenuSelect(id: string): void
}): ReactElement {
  const [menuPoint, setMenuPoint] = useState<MenuPoint | null>(null)
  const [expanded, setExpanded] = useState(false)
  const read = isRead(item)
  const typeLabel = itemTypeLabel(t, item.itemType)
  const children = item.attachments
  const hasChildren = children.length > 0
  const kindCounts = new Map<ZoteroChildKind, number>()
  for (const child of children) {
    kindCounts.set(child.kind, (kindCounts.get(child.kind) ?? 0) + 1)
  }
  const shownKinds = CHILD_KIND_ORDER.filter((kind) => kindCounts.has(kind))
  const countTitle = shownKinds
    .map((kind) => `${childKindLabel(t, kind)} ${kindCounts.get(kind)}`)
    .join(' · ')
  return (
    <div
      className="dsh-zotero-item-shell"
      style={selected ? { ...itemShellStyle, background: ITEM_SELECTED_BG } : itemShellStyle}
    >
      <div
        className="dsh-zotero-item-row"
        title={itemTooltip(t, item)}
        onClick={(event) => onSelect(item.key, event.ctrlKey || event.metaKey)}
        onDoubleClick={() => onOpen(item.key, item.title)}
        onContextMenu={(event) => {
          event.preventDefault()
          // 右键未选中的行先排他选中它：菜单针对整批选中项，不能悄悄混进别的条目。
          if (!selected) onSelect(item.key, false)
          const { clientX, clientY } = event
          const row = event.currentTarget.getBoundingClientRect()
          const insideRow = clientX >= row.left && clientX <= row.right && clientY >= row.top && clientY <= row.bottom
          setMenuPoint(insideRow ? { x: clientX, y: clientY } : { x: row.left, y: row.bottom })
        }}
        style={itemRowStyle}
      >
        {hasChildren ? (
          <button
            type="button"
            className="dsh-zotero-disclosure"
            aria-expanded={expanded}
            aria-label={t(expanded ? 'list.collapseAttachments' : 'list.expandAttachments')}
            title={t(expanded ? 'list.collapseAttachments' : 'list.expandAttachments')}
            onClick={(event) => {
              // 只开合子项，不连带选中 / 打开条目。
              event.stopPropagation()
              setExpanded((open) => !open)
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            style={disclosureButtonStyle}
          >
            <DisclosureIcon open={expanded} />
          </button>
        ) : (
          <span style={disclosureSlotStyle} aria-hidden />
        )}
        <span style={itemIconStyle}>
          {item.itemType === 'attachment'
            ? <ChildKindIcon kind={item.kind} read={read} size={22} />
            : <ItemTypeIcon itemType={item.itemType} read={read} />}
        </span>
        <div style={itemBodyStyle}>
          <span style={{ ...itemTitleStyle, ...readTitleStyle(read) }}>{item.title}</span>
          {(typeLabel !== '' || item.year !== '' || item.creators !== '' || hasChildren) && (
            <div style={itemMetaStyle}>
              {typeLabel !== '' && <span style={itemMetaTypeStyle}>{typeLabel}</span>}
              {item.year !== '' && <span style={itemMetaYearStyle}>{item.year}</span>}
              {item.creators !== '' && <span style={itemMetaTextStyle}>{item.creators}</span>}
              {hasChildren && (
                <span style={itemMetaChildKindsStyle} title={countTitle}>
                  {shownKinds.map((kind) => (
                    <span
                      key={kind}
                      style={itemMetaChildKindStyle}
                      title={childKindLabel(t, kind)}
                    >
                      <ChildKindIcon kind={kind} size={12} />
                      {kindCounts.get(kind)}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {menuPoint !== null && (
        <ItemContextMenu
          point={menuPoint}
          items={menuItems}
          onClose={() => setMenuPoint(null)}
          onSelect={(id) => {
            setMenuPoint(null)
            onMenuSelect(id)
          }}
        />
      )}
      {expanded && hasChildren && (
        <div style={childListStyle}>
          {children.map((child) => (
            <div
              key={child.key}
              className="dsh-zotero-child-row"
              title={`${child.title}\n${t('list.openAttachment')}`}
              onClick={() => onOpen(child.key, child.title)}
              style={childRowStyle}
            >
              <span style={childIconStyle}>
                <ChildKindIcon kind={child.kind} size={15} />
              </span>
              <span style={childTitleStyle}>{child.title}</span>
            </div>
          ))}
        </div>
      )}
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
    sort,
    searchMode,
    selectedItemKeys,
    onSearch,
    onSearchModeChange,
    onRemoveTag,
    onRetry,
    onCycleSort,
    onOpenItem,
    onSelectItem,
    onClearSelection,
    onInsertItem,
    onInsertItems,
    onReviewItems,
  } = props

  const name = selectionName(t, libraryName, selectedCollection)
  /** 「最近阅读」恒按最后打开时间倒序：不给标题排序入口，省得点了没反应。 */
  const recent = isRecentSelection(selectedCollection)
  const tags = [...selectedTags]
  const filtered = tags.length > 0 || query.trim() !== ''
  /** 三档口径与 Zotero 搜索框左侧一致，当前档位同时充当占位提示。 */
  const modeItems: SearchModeItem[] = [
    { value: 'titleCreatorYear', label: t('search.mode.titleCreatorYear') },
    { value: 'fields', label: t('search.mode.fields') },
    { value: 'everything', label: t('search.mode.everything') },
  ]
  const modePlaceholder = modeItems.find((item) => item.value === searchMode)?.label
    ?? t('list.searchPlaceholder')
  /** 按列表顺序取选中项，插进草稿的 chip 顺序才与眼前一致。 */
  const chosen = items.filter((item) => selectedItemKeys.has(item.key))
  const [copying, setCopying] = useState(false)
  const [copyResult, setCopyResult] = useState<{
    count: number
    style: BibliographyStyle
    skipped: ZoteroItemSummary[]
  } | null>(null)
  const selectionTooLarge = chosen.length > MAX_BIBLIOGRAPHY_ITEMS

  async function copyReferences(selection: readonly ZoteroItemSummary[], style: BibliographyStyle): Promise<void> {
    if (copying || selection.length === 0 || selection.length > MAX_BIBLIOGRAPHY_ITEMS) return
    setCopying(true)
    setCopyResult(null)
    try {
      const result = await fetchBibliography(selection.map(({ key }) => key), style)
      const skippedKeys = new Set(result.skippedKeys)
      const skipped = selection.filter(({ key }) => skippedKeys.has(key))
      if (result.count > 0) {
        const formatted = formatBibliography(result.html)
        if (formatted.count !== result.count || formatted.text === '') {
          showToast(t('toast.copyFailed'))
          return
        }
        if (!await writeClipboard(formatted.text, formatted.html)) {
          showToast(t('toast.copyFailed'))
          return
        }
      }
      if (selection.length > 1 || skipped.length > 0) setCopyResult({ count: result.count, style, skipped })
      else showToast(tpl(t('bibliography.copied'), { n: result.count }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast(tpl(t('bibliography.failed'), { message }))
    } finally {
      setCopying(false)
    }
  }

  /** 右键菜单按整批选中项生成，所有行共用同一份；单选两项、多选三项。 */
  const menuItems = itemMenuEntries(t, chosen, {
    copying,
    canReview: onReviewItems !== undefined,
  }).map(toMenuEntry)

  function onMenuSelect(id: string): void {
    if (id === ITEM_MENU_INSERT) {
      if (chosen.length === 1) onInsertItem(chosen[0])
      else onInsertItems(chosen)
      return
    }
    if (id === ITEM_MENU_REVIEW) {
      onReviewItems?.(chosen)
      return
    }
    // 样式 id 才真的复制；「复制参考文献」父项只负责展开子菜单。
    if (isBibliographyStyle(id)) void copyReferences(chosen, id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={headerStyle}>
        <div style={titleRowStyle}>
          <SectionTitle title={name}>{name}</SectionTitle>
          <span style={{ flexShrink: 0, fontSize: 11.5, opacity: 0.55 }}>
            {tpl(t('list.count'), { n: itemsTotal })}
          </span>
          <div style={{ flex: 1 }} />
          {!recent && (
            <Button
              variant="ghost"
              size="sm"
              title={sortHint(t, sort)}
              aria-label={sortHint(t, sort)}
              style={sort === 'none'
                ? sortButtonStyle
                : { ...sortButtonStyle, color: SORT_ACTIVE_COLOR }}
              onClick={onCycleSort}
            >
              <SortIcon sort={sort} />
            </Button>
          )}
        </div>
        <SearchField
          value={query}
          placeholder={modePlaceholder}
          clearLabel={t('search.clear')}
          onChange={onSearch}
          modeItems={modeItems}
          mode={searchMode}
          modeLabel={t('search.modeLabel')}
          onModeChange={onSearchModeChange}
        />
        {/* 选中数只是状态提示；三个动作已全部收进右键菜单，这里不再放按钮。 */}
        {chosen.length > 1 && (
          <div style={bibliographyBarStyle}>
            <span>{tpl(t('bibliography.selected'), { n: chosen.length })}</span>
            {selectionTooLarge && (
              <span role="status">{tpl(t('bibliography.limit'), { n: MAX_BIBLIOGRAPHY_ITEMS })}</span>
            )}
          </div>
        )}
        {copyResult !== null && (
          <div style={bibliographyResultStyle}>
            <div style={bibliographyBarStyle}>
              <strong role="status">
                {tpl(t(copyResult.count === 0 ? 'bibliography.empty'
                  : copyResult.skipped.length > 0 ? 'bibliography.partial' : 'bibliography.copied'), {
                  n: copyResult.count,
                  skipped: copyResult.skipped.length,
                })}
              </strong>
              <button
                type="button"
                aria-label={t('bibliography.dismiss')}
                style={chipRemoveStyle}
                onClick={() => setCopyResult(null)}
              >×</button>
            </div>
            <div style={{ opacity: 0.7 }}>
              {bibliographyStyles(t).find(({ id }) => id === copyResult.style)?.label}
            </div>
            {copyResult.skipped.length > 0 && (
              <ul style={bibliographySkippedStyle}>
                {copyResult.skipped.map((item) => (
                  <li key={item.key}>{item.title} · {t(bibliographySkipReason(item.itemType))}</li>
                ))}
              </ul>
            )}
          </div>
        )}
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
                menuItems={menuItems}
                onMenuSelect={onMenuSelect}
              />
            ))}
            {itemsLoading && items.length > 0 && items.length < itemsTotal && (
              <div style={progressStyle} role="status">
                {tpl(t('list.loadingProgress'), { loaded: items.length, total: itemsTotal })}
              </div>
            )}
            {/* 分批加载中途失败：已到的行照旧显示，这里补一条可点重试的提示，别静默截断。 */}
            {!itemsLoading && itemsError !== null && items.length < itemsTotal && (
              <div style={partialStyle}>
                <span style={{ minWidth: 0 }}>{tpl(t('list.loadIncomplete'), { message: itemsError })}</span>
                <Button variant="outline" size="sm" onClick={onRetry}>{t('action.retry')}</Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
