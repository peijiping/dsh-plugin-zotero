/**
 * 条目 tab 的正文：一个独立 tab 承载一条文献的详情。
 *
 * 条目 key 从 tab 的资源地址里解析（不依赖 params 是否被布局恢复保留）；
 * 取数状态放在组件内，每个 tab 互不影响。关闭 tab 时 `tab.signal` 中止请求。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroItemDetail } from '../zotero/types'
import { fetchItem } from './api'
import type { InputActions } from './inline'
import { ItemDetail } from './ItemDetail'
import type { Translate } from './locales'
import { tpl } from './locales'
import type { SessionsFace } from './reference'
import { Toast } from './Toast'
import { useInsertion } from './useInsertion'

/** 条目 tab 的资源地址前缀（与 index.ts 的 openItem 一致）。 */
export const ITEM_ADDRESS_PREFIX = 'dsh-resource://zotero-item/'

/** `useTabInfo` 中本组件用到的部分。 */
interface TabInfoLike {
  tab: {
    contentId?: string
    title?: string
    navigation?: {
      address?: string
      params?: unknown
    }
    signal: AbortSignal
  }
}

interface Props {
  t: Translate
  useTabInfo(): TabInfoLike
  inputActions?: InputActions
  sessions: SessionsFace
  sessionId?: string
  /** 附件行点击：继续开一个新条目 tab。 */
  onOpenItem(key: string, title?: string): void
}

/** 从资源地址解析条目 key；结构不符返回 null。 */
function parseItemKey(info: TabInfoLike): string | null {
  const address = info.tab.navigation?.address || info.tab.contentId || ''
  if (!address.startsWith(ITEM_ADDRESS_PREFIX)) return null
  const encoded = address.slice(ITEM_ADDRESS_PREFIX.length)
  if (encoded === '' || encoded.includes('/')) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const hintStyle: React.CSSProperties = { padding: '14px 12px', opacity: 0.6, fontSize: 12.5 }

export function ZoteroItemPane(props: Props): ReactElement {
  const { t, useTabInfo, inputActions, sessions, sessionId, onOpenItem } = props
  const info = useTabInfo()
  const itemKey = parseItemKey(info)
  const signal = info.tab.signal

  const [detail, setDetail] = useState<ZoteroItemDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    if (itemKey === null) {
      setDetail(null)
      setLoading(false)
      setError(null)
      return
    }
    const current = ++seq.current
    setLoading(true)
    setError(null)
    fetchItem(itemKey, 'apa', signal)
      .then((data) => {
        if (current !== seq.current) return
        setDetail(data)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (current !== seq.current || signal.aborted) return
        setError(errorMessage(err))
        setLoading(false)
      })
  }, [itemKey, retry, signal])

  const {
    insertItem,
    insertExcerpt,
    insertAnnotation,
    insertNote,
  } = useInsertion(t, sessions, sessionId, inputActions)

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {itemKey === null ? (
        <div style={{ ...hintStyle, color: '#d29922' }}>{t('itemTab.invalid')}</div>
      ) : loading ? (
        <div style={hintStyle}>{t('status.loading')}</div>
      ) : detail === null ? (
        <div style={{ padding: '12px 14px', fontSize: 12.5, color: '#d29922' }}>
          <p style={{ margin: '0 0 8px' }}>{tpl(t('detail.loadFailed'), { message: error ?? '' })}</p>
          <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>
            {t('action.retry')}
          </Button>
        </div>
      ) : (
        <ItemDetail
          t={t}
          detail={detail}
          onInsertItem={() => insertItem(detail.key, detail.title)}
          onInsertExcerpt={(quote) => void insertExcerpt(detail, quote)}
          onInsertAnnotation={(annotation) => insertAnnotation(detail, annotation)}
          onInsertNote={(note) => insertNote(detail, note)}
          onOpenItem={onOpenItem}
        />
      )}
      <Toast />
    </div>
  )
}