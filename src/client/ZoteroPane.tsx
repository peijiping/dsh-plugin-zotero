/**
 * 右侧栏面板容器：头部状态栏 + 左分类树 + 右详情。
 *
 * 两栏之间是可拖动的分隔条（宽度存 localStorage，跨会话/重启都记住）。
 * 数据与选择状态都在 {@link paneStore} 的模块级单例里（跨会话共用同一块面板）。
 * 「添加到会话」走 ui-conversation 下发的会话级标准 prop：条目与整目录插引用
 * chip（见 reference.ts），摘录 / 标注 / 笔记仍是纯文本插入。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroAnnotation, ZoteroCollection, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { CollectionTree } from './CollectionTree'
import { annotationText, excerptText, noteText } from './compose'
import type { InputActions, InsertOutcome } from './inline'
import { insertBuilt } from './inline'
import { ItemDetail } from './ItemDetail'
import type { Translate } from './locales'
import { tpl } from './locales'
import type { ReferenceInsert, SessionsFace } from './reference'
import { collectionReference, insertChip, itemReference } from './reference'
import { sectionTitleStyle } from './styles'
import { loadTree, openItem, selectCollection, setQuery, showToast, usePaneState } from './paneStore'
import { isRead, itemTooltip, ReadDot, readTitleStyle } from './readState'

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
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim()
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

export function ZoteroPane({ t, inputActions, sessions, sessionId }: Props): ReactElement {
  const {
    health,
    libraryName,
    collections,
    treeError,
    treeLoading,
    query,
    results,
    selectedItemKey,
    selectedCollection,
    detail,
    detailLoading,
    detailError,
    collectionBib,
    nodeItems,
    nodeErrors,
    toast,
  } = usePaneState()

  useEffect(() => {
    void loadTree()
  }, [])

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

  const report = useCallback((outcome: InsertOutcome): void => {
    if (outcome === 'inserted') showToast(t('toast.inserted'))
    else if (outcome === 'no-editor') showToast(t('error.noEditor'))
    else showToast(t('error.draftChanged'))
  }, [t])

  /**
   * 插一个引用 chip：草稿里只留 key，完整文本在提交那一刻由引用源的 codec 现取。
   */
  const insertReference = useCallback((reference: ReferenceInsert): void => {
    if (!inputActions) {
      report('no-editor')
      return
    }
    report(insertChip(sessions, sessionId, reference, inputActions.captureInsertion()) ? 'inserted' : 'draft-changed')
  }, [inputActions, report, sessionId, sessions])

  const insertItem = useCallback((key: string, title: string): void => {
    insertReference(itemReference(key, title))
  }, [insertReference])

  const insertExcerpt = useCallback(async (target: ZoteroItemDetail, quote: string): Promise<void> => {
    report(await insertBuilt(inputActions, () => excerptText(t, target, quote)))
  }, [inputActions, report, t])

  const insertAnnotation = useCallback(async (
    target: ZoteroItemDetail,
    annotation: ZoteroAnnotation,
  ): Promise<void> => {
    report(await insertBuilt(inputActions, () => annotationText(t, target, annotation)))
  }, [inputActions, report, t])

  const insertNote = useCallback(async (target: ZoteroItemDetail, note: ZoteroNote): Promise<void> => {
    report(await insertBuilt(inputActions, () => noteText(t, target, note)))
  }, [inputActions, report, t])

  const insertCollection = useCallback((collection: ZoteroCollection): void => {
    insertReference(collectionReference(collection.key, collection.name))
  }, [insertReference])

  /** 分类详情里的条目列表：与左侧树共用同一份缓存（选中分类时树已按需拉取）。 */
  const collectionItems = selectedCollection === null ? undefined : nodeItems[selectedCollection.key]

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
          <div style={{ padding: '8px 8px 4px', flexShrink: 0 }}>
            <Input
              value={query}
              placeholder={t('tree.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {treeLoading ? (
              <div style={hintStyle}>{t('status.loading')}</div>
            ) : treeError !== null ? (
              <div style={{ ...hintStyle, color: '#d29922' }}>{treeError}</div>
            ) : results !== null ? (
              results.length === 0 ? (
                <div style={hintStyle}>{t('tree.empty')}</div>
              ) : (
                <div style={{ padding: '8px 6px' }}>
                  {results.map((item) => {
                    const read = isRead(item)
                    return (
                      <div
                        key={item.key}
                        title={itemTooltip(t, item)}
                        onClick={() => openItem(item.key)}
                        style={{ ...resultRowStyle, background: selectedItemKey === item.key ? 'rgba(127,127,127,0.16)' : 'transparent' }}
                      >
                        <ReadDot read={read} />
                        <span style={{ ...resultTitleStyle, ...readTitleStyle(read) }}>{item.title}</span>
                        <span style={resultMetaStyle}>{[item.creators, item.year].filter((p) => p !== '').join(' · ')}</span>
                      </div>
                    )
                  })}
                </div>
              )
            ) : (
              <CollectionTree
                t={t}
                collections={collections}
                selectedItemKey={selectedItemKey}
                selectedCollectionKey={selectedCollection?.key ?? null}
                onSelectItem={openItem}
                onSelectCollection={selectCollection}
                onInsertItem={(item) => insertItem(item.key, item.title)}
                onInsertCollection={insertCollection}
              />
            )}
          </div>
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

        <section style={{ flex: 1, minWidth: 0, overflow: 'auto', minHeight: 0 }}>
          {selectedItemKey !== null ? (
            detailLoading ? (
              <div style={hintStyle}>{t('status.loading')}</div>
            ) : detail === null ? (
              <div style={{ padding: '12px 14px', fontSize: 12.5, color: '#d29922' }}>
                <p style={{ margin: '0 0 8px' }}>{tpl(t('detail.loadFailed'), { message: detailError ?? '' })}</p>
                <Button variant="outline" size="sm" onClick={() => openItem(selectedItemKey)}>
                  {t('action.retry')}
                </Button>
              </div>
            ) : (
              <ItemDetail
                t={t}
                detail={detail}
                onInsertItem={() => insertItem(detail.key, detail.title)}
                onInsertExcerpt={(quote) => void insertExcerpt(detail, quote)}
                onInsertAnnotation={(annotation) => void insertAnnotation(detail, annotation)}
                onInsertNote={(note) => void insertNote(detail, note)}
                onOpenItem={openItem}
              />
            )
          ) : selectedCollection !== null ? (
            <div style={{ padding: '12px 14px' }}>
              <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>{selectedCollection.name}</h2>
              {selectedCollection.itemCount !== undefined && (
                <p style={{ margin: '0 0 10px', opacity: 0.75 }}>
                  {tpl(t('detail.collectionCount'), { n: selectedCollection.itemCount })}
                </p>
              )}
              <Button variant="outline" size="sm" onClick={() => insertCollection(selectedCollection)}>
                {t('action.insertCollection')}
              </Button>
              {selectedCollection.scope === undefined && (
                <>
                  <h3 style={{ ...sectionTitleStyle, margin: '16px 0 6px' }}>{t('detail.bibTitle')}</h3>
                  {collectionBib === null ? (
                    <p style={{ margin: 0, opacity: 0.6 }}>{t('status.loading')}</p>
                  ) : collectionBib === '' ? (
                    <p style={{ margin: 0, opacity: 0.6 }}>{t('detail.noBib')}</p>
                  ) : (
                    <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.7, opacity: 0.85 }}>{stripTags(collectionBib)}</p>
                  )}
                </>
              )}
              {/* 笔记不产生 CSL 引用，靠这份列表让「笔记目录」也有内容可看可点。 */}
              {collectionItems !== undefined && collectionItems.length > 0 && (
                <>
                  <h3 style={{ ...sectionTitleStyle, margin: '16px 0 6px' }}>{t('detail.items')}</h3>
                  <div>
                    {collectionItems.map((item) => {
                      const read = isRead(item)
                      return (
                        <div
                          key={item.key}
                          title={itemTooltip(t, item)}
                          onClick={() => openItem(item.key)}
                          style={resultRowStyle}
                        >
                          <ReadDot read={read} />
                          <span style={{ ...resultTitleStyle, ...readTitleStyle(read) }}>{item.title}</span>
                          <span style={resultMetaStyle}>
                            {[item.creators, item.year].filter((part) => part !== '').join(' · ')}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div style={hintStyle}>{t('detail.empty')}</div>
          )}
        </section>
      </div>

      {toast !== null && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 14,
            transform: 'translateX(-50%)',
            padding: '5px 12px',
            borderRadius: 6,
            background: 'rgba(40,40,40,0.92)',
            color: '#fff',
            fontSize: 12,
            zIndex: 10,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}

const hintStyle: React.CSSProperties = { padding: '14px 12px', opacity: 0.6, fontSize: 12.5 }

const resultRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  padding: '3px 6px 3px 8px',
  fontSize: 12.5,
  lineHeight: 1.5,
  borderRadius: 5,
  cursor: 'pointer',
}

const resultTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const resultMetaStyle: React.CSSProperties = { ...resultTitleStyle, flex: '0 0 auto', maxWidth: '48%', opacity: 0.5, fontSize: 11.5 }
