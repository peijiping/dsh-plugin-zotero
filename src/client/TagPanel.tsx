/**
 * 左栏底部：标签面板。
 *
 * 标签排成 Zotero 那样的换行胶囊（点胶囊切换筛选）。全库清单来自 `/tags`，
 * 当前分类（不含子目录）里有哪些标签、各多少条目来自 `tag-usage` 扫描：
 * 选中具体目录时只列该范围出现过的标签，选中文库根时列全库标签。
 * 切换目录会清空已选标签（见 paneStore.selectCollection），避免旧筛选作用到新范围。
 * 多选后可从摘要行把已选标签合并成一个「标签组」胶囊引用。
 * 面板高度与折叠状态存 localStorage；与上方目录树之间是可拖动的横向分隔条。
 */

import { useRef, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroTag } from '../zotero/types'
import type { Translate } from './locales'
import { tpl } from './locales'
import { MAX_TAG_REFERENCE } from './reference'
import { SearchField } from './SearchField'

/** 面板高度与折叠状态的存储键。 */
const HEIGHT_KEY = 'dsh-plugin-zotero.tagPanelHeight'
const COLLAPSED_KEY = 'dsh-plugin-zotero.tagPanelCollapsed'
const HEIGHT_DEFAULT = 180
const HEIGHT_MIN = 80
const HEIGHT_MAX = 420

function readHeight(): number {
  try {
    const value = Number.parseInt(window.localStorage.getItem(HEIGHT_KEY) ?? '', 10)
    return Number.isFinite(value) && value >= HEIGHT_MIN && value <= HEIGHT_MAX ? value : HEIGHT_DEFAULT
  } catch {
    return HEIGHT_DEFAULT
  }
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 隐私模式等禁用 localStorage 时忽略，状态仍在本会话内生效。
  }
}

interface Props {
  t: Translate
  tags: ZoteroTag[] | null
  tagsLoading: boolean
  tagsError: string | null
  tagQuery: string
  selectedTags: ReadonlySet<string>
  tagMode: 'all' | 'any'
  /** 当前是否选中了具体范围（非「我的文库」根）；选中根时列全库标签。 */
  scoped: boolean
  /** 当前范围内的标签用量（名称 → 范围内条目数）；`null` = 全库或拉取失败。 */
  tagUsage: ReadonlyMap<string, number> | null
  tagUsageLoading: boolean
  onTagQuery(text: string): void
  onToggleTag(name: string): void
  onClearTags(): void
  onSetTagMode(mode: 'all' | 'any'): void
  onRetry(): void
  onInsertTag(name: string): void
  onInsertTagSet(names: readonly string[], mode: 'all' | 'any'): void
}

const hintStyle: React.CSSProperties = { padding: '8px 4px', opacity: 0.6, fontSize: 12 }

/** 胶囊之间留一点空隙，换行排布（Zotero 标签选择器的排法）。 */
const tagFlowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 5,
  padding: '2px 0',
  alignContent: 'flex-start',
}

/** 自动标签的淡化程度（Zotero 用斜体区分，这里斜体 + 略淡）。 */
const AUTOMATIC_OPACITY = 0.72

function pillStyle(selected: boolean, automatic: boolean): React.CSSProperties {
  return {
    padding: '1px 7px',
    fontSize: 11.5,
    lineHeight: '17px',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'inherit',
    background: selected ? 'rgba(80,140,255,0.18)' : 'transparent',
    border: `1px solid ${selected ? 'rgba(80,140,255,0.55)' : 'rgba(127,127,127,0.32)'}`,
    borderRadius: 9,
    cursor: 'pointer',
    opacity: automatic ? AUTOMATIC_OPACITY : 1,
    fontStyle: automatic ? 'italic' : 'normal',
  }
}

function TagPill({ t, tag, selected, scopeCount, scoped, onToggle }: {
  t: Translate
  tag: ZoteroTag
  selected: boolean
  scopeCount: number
  /** 是否按范围显示计数（`false` = 全库计数）。 */
  scoped: boolean
  onToggle(): void
}): ReactElement {
  const automatic = tag.type === 0
  const hints = [tag.name]
  if (automatic) hints.push(t('tags.automatic'))
  hints.push(tpl(scoped ? t('tags.scopeCount') : t('tags.libraryCount'), { n: scoped ? scopeCount : tag.count }))
  return (
    <button
      type="button"
      onClick={onToggle}
      title={hints.join('\n')}
      style={pillStyle(selected, automatic)}
    >
      {tag.name}
    </button>
  )
}

export function TagPanel(props: Props): ReactElement {
  const {
    t,
    tags,
    tagsLoading,
    tagsError,
    tagQuery,
    selectedTags,
    tagMode,
    scoped,
    tagUsage,
    tagUsageLoading,
    onTagQuery,
    onToggleTag,
    onClearTags,
    onSetTagMode,
    onRetry,
    onInsertTag,
    onInsertTagSet,
  } = props

  const [height, setHeight] = useState(readHeight)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [splitHover, setSplitHover] = useState(false)
  const dragRef = useRef<{ y: number; height: number } | null>(null)

  const query = tagQuery.trim().toLowerCase()
  /** 范围标签已拿到：只列当前分类里出现的标签。 */
  const scopedReady = scoped && tagUsage !== null
  const scopedTags = scopedReady
    ? (tags ?? []).filter((tag) => tagUsage !== null && tagUsage.has(tag.name))
    : tags
  const visible = (scopedTags ?? []).filter((tag) => query === '' || tag.name.toLowerCase().includes(query))
  const selected = [...selectedTags]
  const tooMany = selected.length > MAX_TAG_REFERENCE

  function toggleCollapsed(): void {
    const next = !collapsed
    setCollapsed(next)
    persist(COLLAPSED_KEY, next ? '1' : '0')
  }

  function onSplitterDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (collapsed) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { y: event.clientY, height }
  }

  function onSplitterMove(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (drag === null) return
    setHeight(Math.min(Math.max(drag.height + drag.y - event.clientY, HEIGHT_MIN), HEIGHT_MAX))
  }

  function onSplitterUp(event: React.PointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    persist(HEIGHT_KEY, String(Math.round(height)))
  }

  function citeSelected(): void {
    if (selected.length === 0) return
    if (selected.length > MAX_TAG_REFERENCE) return
    if (selected.length === 1) onInsertTag(selected[0])
    else onInsertTagSet(selected, tagMode)
  }

  return (
    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onSplitterDown}
        onPointerMove={onSplitterMove}
        onPointerUp={onSplitterUp}
        onPointerCancel={onSplitterUp}
        onPointerEnter={() => setSplitHover(true)}
        onPointerLeave={() => setSplitHover(false)}
        style={{
          flexShrink: 0,
          height: 5,
          display: 'flex',
          alignItems: 'center',
          cursor: collapsed ? 'default' : 'row-resize',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <span
          style={{
            width: '100%',
            height: 1,
            background:
              splitHover || dragRef.current !== null ? 'rgba(80,140,255,0.75)' : 'rgba(127,127,127,0.2)',
          }}
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 8px 4px',
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 12 }}>{t('tags.title')}</strong>
        {scopedTags !== null && (
          <span style={{ fontSize: 11, opacity: 0.5 }}>{tpl(t('tags.count'), { n: scopedTags.length })}</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'tags.expand' : 'tags.collapse')}
          title={t(collapsed ? 'tags.expand' : 'tags.collapse')}
          style={{
            width: 20,
            height: 20,
            padding: 0,
            fontSize: 11,
            lineHeight: 1,
            color: '#508cff',
            background: 'transparent',
            border: '1px solid rgba(80,140,255,0.4)',
            borderRadius: 5,
            cursor: 'pointer',
          }}
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </div>

      {!collapsed && (
        <div style={{ height, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '0 8px 6px' }}>
          <SearchField
            value={tagQuery}
            placeholder={t('tags.filterPlaceholder')}
            clearLabel={t('search.clear')}
            onChange={onTagQuery}
          />

          {selected.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', padding: '5px 0 3px', fontSize: 11.5 }}>
              <span style={{ opacity: 0.7 }}>{tpl(t('tags.selected'), { n: selected.length })}</span>
              <button
                type="button"
                onClick={() => onSetTagMode('all')}
                title={t('tags.matchAllHint')}
                aria-pressed={tagMode === 'all'}
                style={modeButtonStyle(tagMode === 'all')}
              >
                {t('tags.matchAll')}
              </button>
              <button
                type="button"
                onClick={() => onSetTagMode('any')}
                title={t('tags.matchAnyHint')}
                aria-pressed={tagMode === 'any'}
                style={modeButtonStyle(tagMode === 'any')}
              >
                {t('tags.matchAny')}
              </button>
              <button type="button" onClick={onClearTags} style={plainButtonStyle}>
                {t('tags.clear')}
              </button>
              <div style={{ flex: 1 }} />
              <Button
                variant="outline"
                size="sm"
                disabled={tooMany}
                title={tooMany ? tpl(t('error.tooManyTags'), { n: MAX_TAG_REFERENCE }) : t('tags.citeSelected')}
                style={{ flexShrink: 0, height: 20, padding: '0 6px', fontSize: 11, lineHeight: 1.2 }}
                onClick={citeSelected}
              >
                {t('tags.citeSelected')}
              </Button>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', marginTop: 2 }}>
            {tagsError !== null ? (
              <div style={hintStyle}>
                <p style={{ margin: '0 0 6px', color: '#d29922' }}>
                  {tpl(t('tags.loadFailed'), { message: tagsError })}
                </p>
                <Button variant="outline" size="sm" onClick={onRetry}>{t('action.retry')}</Button>
              </div>
            ) : tags === null || (tagsLoading && tags.length === 0) || (scoped && tagUsageLoading) ? (
              <div style={hintStyle}>{t('status.loading')}</div>
            ) : visible.length === 0 ? (
              <div style={hintStyle}>{t(scopedReady ? 'tags.emptyScope' : 'tags.empty')}</div>
            ) : (
              <div style={tagFlowStyle}>
                {visible.map((tag) => (
                  <TagPill
                    key={tag.name}
                    t={t}
                    tag={tag}
                    selected={selectedTags.has(tag.name)}
                    scopeCount={tagUsage?.get(tag.name) ?? 0}
                    scoped={scopedReady}
                    onToggle={() => onToggleTag(tag.name)}
                  />
                ))}
              </div>
            )}
          </div>

          <div style={{ flexShrink: 0, paddingTop: 4, fontSize: 10.5, opacity: 0.55, lineHeight: 1.4 }}>
            {t('tags.scopeHint')}
          </div>
        </div>
      )}
    </div>
  )
}

function modeButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '0 5px',
    fontSize: 11,
    lineHeight: '16px',
    color: 'inherit',
    background: active ? 'rgba(80,140,255,0.18)' : 'transparent',
    border: active ? '1px solid rgba(80,140,255,0.5)' : '1px solid rgba(127,127,127,0.3)',
    borderRadius: 5,
    cursor: 'pointer',
  }
}

const plainButtonStyle: React.CSSProperties = {
  padding: '0 5px',
  fontSize: 11,
  lineHeight: '16px',
  color: 'inherit',
  background: 'transparent',
  border: '1px solid rgba(127,127,127,0.3)',
  borderRadius: 5,
  cursor: 'pointer',
  opacity: 0.8,
}