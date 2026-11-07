/**
 * 「这篇在本插件里读到哪」的客户端半条命：进文档时取续读页，翻页时防抖回写。
 *
 * 进度**只存在插件自己的存储里**（`<dsh 数据目录>/storages/dsh-plugin-zotero/
 * read-positions.json`），不与 Zotero 同步：Zotero 的 `dataDir` 可能是任意路径，
 * 插件拿不到可靠值；而且用户在两边各读一段时，本来就该各记各的。
 *
 * 页号在这里统一用 **1 基**（渲染器的 `currentPage` 就是 1 基），跟 Host 里 0 基
 * `pageIndex` 的换算只放在本文件里，别的地方不要再各自 ±1。
 *
 * 回写只在**用户真的翻过页**之后发生（由调用方用 `notePage` 的时机控制）：打开就
 * 关掉的那次不该改写记录，否则刚跳到的页会被记成第 1 页。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchReadPosition, saveReadPosition } from '../api'

/** 防抖：滚动时页码一秒能变好几次，攒一会儿再发。 */
const SAVE_DELAY_MS = 800

export interface ReadPositionHook {
  /** 续读页（0 基）；没有记录、还在取、取失败都是 `null`。 */
  resumePage: number | null
  /** 当前页变了就调（1 基）。内部去重 + 防抖，重复调同一页不会发请求。 */
  notePage(page: number): void
}

export function useReadPosition(attachmentKey: string | null): ReadPositionHook {
  const [resumePage, setResumePage] = useState<number | null>(null)
  /** 已经落库的页（0 基）；用来挡掉「同一页反复发」。 */
  const savedRef = useRef<number | null>(null)
  /**
   * 待落库的页。
   *
   * 连 key 一起存：切文档时组件的卸载清理会跑在 props 已更新之后，
   * 只存页号就会把 A 文档的进度写到 B 文档名下。
   */
  const pendingRef = useRef<{ key: string; pageIndex: number } | null>(null)
  const timerRef = useRef<number | null>(null)
  const keyRef = useRef<string | null>(attachmentKey)
  keyRef.current = attachmentKey

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending === null) return
    savedRef.current = pending.pageIndex
    void saveReadPosition(pending).catch(() => {
      // 记进度失败不该打断阅读；清掉去重标记，下次翻页会再试一遍。
      savedRef.current = null
    })
  }, [])

  useEffect(() => {
    setResumePage(null)
    savedRef.current = null
    pendingRef.current = null
    if (attachmentKey === null) return
    const controller = new AbortController()
    fetchReadPosition(attachmentKey, controller.signal)
      .then((position) => {
        if (controller.signal.aborted) return
        savedRef.current = position?.pageIndex ?? null
        setResumePage(position?.pageIndex ?? null)
      })
      .catch(() => {
        // Host 不可达 / 没开本地 API：从头读，不是错误。
      })
    return () => controller.abort()
  }, [attachmentKey])

  // 卸载（关面板、切下一篇）时把最后一页补上，别等防抖。
  useEffect(() => () => flush(), [flush])

  const notePage = useCallback((page: number): void => {
    const key = keyRef.current
    const pageIndex = page - 1
    if (key === null || pageIndex < 0) return
    if (savedRef.current === pageIndex && pendingRef.current === null) return
    pendingRef.current = { key, pageIndex }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flush, SAVE_DELAY_MS)
  }, [flush])

  return { resumePage, notePage }
}
