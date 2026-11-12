/**
 * 截图状态机：idle → capturing → frozen → selected → inserting → idle。
 *
 * 「微信式定格」的关键约束：位图必须在遮罩挂载**之前**合成完毕，否则会把遮罩
 * 自己拍进去。之后框选、裁切、水印、插入全程只碰这张 PNG，与文档类型无关。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { InsertOutcome } from '../../inline'
import type { Translate } from '../../locales'
import { showToast } from '../../paneStore'
import { composeShot } from './composer'
import { createDomAdapter } from './adapters/dom'
import { createPdfAdapter } from './adapters/pdf'
import {
  MIN_SELECTION_SIZE,
  type CaptureAdapter,
  type CaptureFrame,
  type CaptureKind,
  type ClientRect,
  type ShotMeta,
  type ShotPhase,
} from './types'

export interface ShotControllerDeps {
  t: Translate
  kind: CaptureKind
  getRoot(): HTMLElement | null
  buildMeta(frame: CaptureFrame, rect: ClientRect): ShotMeta
  watermark(meta: ShotMeta): string
  insert(png: Blob, meta: ShotMeta): InsertOutcome
}

export interface ShotController {
  phase: ShotPhase
  url: string | null
  width: number
  height: number
  selection: ClientRect | null
  /** 按钮是否可用。 */
  available: boolean
  /** 不可用时的 title 文案。 */
  unavailableReason: string
  start(): void
  select(rect: ClientRect): void
  confirm(): void
  cancel(): void
}

function adapterFor(kind: CaptureKind): CaptureAdapter | null {
  if (kind === 'pdf') return createPdfAdapter()
  if (kind === 'dom') return createDomAdapter()
  return null
}

/** 各失败态对应的用户提示；成功沿用项目统一的 `toast.inserted`。 */
function outcomeToast(t: Translate, outcome: InsertOutcome): string {
  switch (outcome) {
    case 'inserted': return t('toast.inserted')
    case 'no-editor': return t('error.noEditor')
    case 'draft-changed': return t('error.draftChanged')
    case 'no-conversation': return t('shot.noConversation')
    case 'attachment-rejected': return t('shot.attachmentRejected')
    case 'model-no-image': return t('shot.modelNoImage')
    default: return t('shot.captureFailed')
  }
}

export function useShotController(deps: ShotControllerDeps): ShotController {
  const [phase, setPhase] = useState<ShotPhase>('idle')
  const [url, setUrl] = useState<string | null>(null)
  const [frame, setFrame] = useState<CaptureFrame | null>(null)
  const [selection, setSelection] = useState<ClientRect | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  /** 每次 render 刷新，避免异步回调拿到旧的 detail / outline。 */
  const depsRef = useRef(deps)
  depsRef.current = deps
  const urlRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  const releaseUrl = useCallback((): void => {
    if (urlRef.current !== null) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const cancel = useCallback((): void => {
    releaseUrl()
    busyRef.current = false
    setUrl(null)
    setFrame(null)
    setSelection(null)
    setPhase('idle')
  }, [releaseUrl])

  useEffect(() => () => releaseUrl(), [releaseUrl])

  const start = useCallback((): void => {
    if (busyRef.current) return
    const current = depsRef.current
    const root = current.getRoot()
    const adapter = adapterFor(current.kind)
    if (root === null || adapter === null) {
      showToast(current.t(current.kind === 'iframe' ? 'shot.snapshotPending' : 'shot.unsupported'))
      return
    }
    // 清掉已有划词选区与浮条，避免定格图里带着一条蓝色高亮。
    window.getSelection()?.removeAllRanges()
    busyRef.current = true
    setPhase('capturing')
    const box = root.getBoundingClientRect()
    void (async () => {
      try {
        const captured = await adapter.capture(root, box)
        if (captured === null) {
          showToast(depsRef.current.t('shot.captureFailed'))
          cancel()
          return
        }
        const objectUrl = URL.createObjectURL(captured.png)
        urlRef.current = objectUrl
        setFrame(captured)
        setSize({ width: captured.cssWidth, height: captured.cssHeight })
        setUrl(objectUrl)
        setSelection(null)
        setPhase('frozen')
      } catch {
        showToast(depsRef.current.t('shot.captureFailed'))
        cancel()
      } finally {
        busyRef.current = false
      }
    })()
  }, [cancel])

  const select = useCallback((rect: ClientRect): void => {
    if (rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
      setSelection(null)
      setPhase('frozen')
      showToast(depsRef.current.t('shot.tooSmall'))
      return
    }
    setSelection(rect)
    setPhase('selected')
  }, [])

  const confirm = useCallback((): void => {
    if (frame === null || selection === null || busyRef.current) return
    const current = depsRef.current
    busyRef.current = true
    setPhase('inserting')
    void (async () => {
      try {
        const meta = current.buildMeta(frame, selection)
        const png = await composeShot(frame, selection, current.watermark(meta))
        showToast(outcomeToast(current.t, current.insert(png, meta)))
      } catch {
        showToast(current.t('shot.captureFailed'))
      } finally {
        busyRef.current = false
        cancel()
      }
    })()
  }, [frame, selection, cancel])

  const available = deps.kind === 'pdf' || deps.kind === 'dom'
  const unavailableReason = deps.kind === 'iframe'
    ? deps.t('shot.snapshotPending')
    : deps.t('shot.unsupported')

  return {
    phase,
    url,
    width: size.width,
    height: size.height,
    selection,
    available,
    unavailableReason,
    start,
    select,
    confirm,
    cancel,
  }
}
