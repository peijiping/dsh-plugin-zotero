/**
 * 网页快照渲染器：用沙箱 iframe 还原 Zotero 保存的单文件 HTML 快照。
 *
 * 正文由 Host 侧注入的桥接脚本负责（见 `src/snapshot/runtime.js`）：本组件只
 * 通过 postMessage 推标注、收选区、发定位指令。iframe 的 origin 是 opaque，
 * 父页面碰不到它内部 DOM —— 所有交互都必须走消息。
 *
 * 标注的编辑入口与 PDF 一致：点网页里的高亮 → 桥接脚本上报 key 与矩形 →
 * 这里弹出共用的 {@link AnnotationCard}，换色 / 改评论 / 换类型 / 删除都走同一套写入。
 *
 * `annotations` 用一份轻量签名做依赖：`onChanged()` 之后详情会整份重取，
 * 数组引用每次都变；按签名判断可以避免无关重渲染也往 iframe 里推一遍。
 *
 * 网页标题目录也走这座桥：iframe 里扫 h1–h6 打锚点后上报 `outline`，本组件转成
 * 统一目录项交给左上角浮层；点目录项发 `scroll-to-outline` 让 iframe 自己滚。
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import type { ZoteroAnnotation, ZoteroAnnotationDraft } from '../../zotero/types'
import { EDITABLE_TYPES } from '../annotationRuns'
import { createAnnotations } from '../api'
import { notifyDocumentPress, useDismiss } from '../dismiss'
import { tpl } from '../locales'
import { showToast } from '../paneStore'
import { SOFT_BUTTON_STYLE } from '../styles'
import { AnnotationCard } from './AnnotationCard'
import { anchorTarget, OUTLINE_MAX_DEPTH, OUTLINE_MAX_ITEMS } from './outline'
import { SelectionBar, type MarkType } from './SelectionBar'
import { createIframeAdapter } from './shot/adapters/iframe'
import { TranslationCard } from './TranslationCard'
import { useTranslation } from './useTranslation'
import {
  asSnapshotEvent,
  commandEnvelope,
  SNAPSHOT_BRIDGE_VERSION,
  type SnapshotAnnotationItem,
  type SnapshotCapturePayload,
  type SnapshotCommand,
  type SnapshotOutlineItem,
  type SnapshotRect,
  type SnapshotSelection,
} from './snapshotProtocol'
import type { DocumentOutlineItem, DocumentRendererProps } from './types'

/** 桥接脚本一般几百毫秒就绪；超过这个时间就认定它没跑起来。 */
const BRIDGE_TIMEOUT_MS = 8000

/** 整页序列化 + 回传的等待上限；超了就按采集失败处理，不把遮罩一直挂着。 */
const CAPTURE_TIMEOUT_MS = 8000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function itemsOf(annotations: ZoteroAnnotation[]): SnapshotAnnotationItem[] {
  const items: SnapshotAnnotationItem[] = []
  for (const annotation of annotations) {
    if (annotation.webPosition === null) continue
    items.push({
      key: annotation.key,
      type: annotation.type,
      color: annotation.color,
      text: annotation.text,
      webPosition: annotation.webPosition,
    })
  }
  return items
}

/**
 * iframe 报上来的标题目录 → 统一目录项。
 *
 * 消息来自沙箱里的页面脚本，虽然只能伪造文字也不能写库，还是逐字段收窄一遍：
 * 标题与锚点必须是字符串、层级夹到面板画得出来的范围、条数封顶。
 */
function outlineOf(raw: SnapshotOutlineItem[]): DocumentOutlineItem[] {
  const items: DocumentOutlineItem[] = []
  for (const entry of raw) {
    if (items.length >= OUTLINE_MAX_ITEMS) break
    if (typeof entry?.title !== 'string' || typeof entry?.id !== 'string') continue
    const title = entry.title.trim()
    if (title === '') continue
    const depth = typeof entry.depth === 'number' && Number.isFinite(entry.depth)
      ? Math.max(0, Math.min(OUTLINE_MAX_DEPTH - 1, Math.trunc(entry.depth)))
      : 0
    items.push({ title, depth, target: anchorTarget(entry.id) })
  }
  return items
}

/** 只把 http(s) 交给系统：快照里的 `javascript:` / `file:` 一律丢弃。 */
function openExternal(href: string): void {
  let url: URL
  try {
    url = new URL(href, window.location.href)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  window.open(url.href, '_blank', 'noopener,noreferrer')
}

export function SnapshotViewer({
  t,
  detail,
  source,
  annotations,
  viewerRef,
  onReady,
  onInsertExcerpt,
  onInsertTranslation,
  onInsertAnnotation,
  onOpenInZotero,
  onChanged,
  onOutlineChange,
  captureRef,
  onCaptureChange,
}: DocumentRendererProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const readyRef = useRef(false)
  const pendingLocate = useRef<string | null>(null)
  const selectionRef = useRef<SnapshotSelection | null>(null)
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  /** 目录回调走 ref：message 监听只该挂一次，不该因父级重渲染换了回调身份就重挂。 */
  const outlineRef = useRef(onOutlineChange)
  outlineRef.current = onOutlineChange
  /** 桥接脚本版本；`0` 表示还没 `ready`。截图按钮的可用性看它。 */
  const bridgeVersionRef = useRef(0)
  /** 等 `capture-result` 的那一个 resolve；同一时刻只允许一个采集在跑。 */
  const captureWaiter = useRef<((payload: SnapshotCapturePayload | null) => void) | null>(null)
  const onCaptureChangeRef = useRef(onCaptureChange)
  onCaptureChangeRef.current = onCaptureChange

  const [reloadKey, setReloadKey] = useState(0)
  const [bridgeReady, setBridgeReady] = useState(false)
  const [bridgeMissing, setBridgeMissing] = useState(false)
  /** 采集适配器的 effect 只挂一次，用 ref 读最新值，不必为这个状态重建 adapter。 */
  const bridgeMissingRef = useRef(false)
  bridgeMissingRef.current = bridgeMissing
  const [missed, setMissed] = useState(0)
  const [selection, setSelection] = useState<SnapshotSelection | null>(null)
  const [marking, setMarking] = useState(false)
  /** 划词翻译浮层：在父容器坐标系里，iframe 内滚动不影响它。 */
  const translation = useTranslation(t)
  /**
   * 打开着的编辑卡片：只记标注 key 与点击位置，内容每次从 `annotations` 里现取。
   *
   * 存快照会有两个坏味道：写成功后 `onChanged` 重取的新版本号进不了卡片，下一次保存
   * 必撞 412；Zotero 那边改了评论，卡片还显示旧的。
   */
  const [card, setCard] = useState<{ key: string; x: number; y: number } | null>(null)
  /** iframe 里跑的是旧桥接脚本：没有点击矩形，卡片只能居中，界面上要说清原因。 */
  const [staleBridge, setStaleBridge] = useState(false)

  const post = useCallback((command: SnapshotCommand): void => {
    const frame = frameRef.current
    if (frame === null) return
    try {
      frame.contentWindow?.postMessage(commandEnvelope(command), '*')
    } catch {
      /* iframe 还在导航中：消息会丢，但下一次 applied/ready 会重推 */
    }
  }, [])

  const pushAnnotations = useCallback((): void => {
    post({ type: 'annotations', items: itemsOf(annotationsRef.current) })
  }, [post])

  /**
   * 请桥接脚本把整页序列化回来。
   *
   * 超时不是可有可无的兜底：`capture-failed` 与 `capture-result` 都可能因为页面
   * 脚本把 iframe 搞死而永远不来，没有超时的话「正在采集画面…」会一直挂着。
   */
  const requestCapture = useCallback((): Promise<SnapshotCapturePayload | null> => {
    return new Promise((resolve) => {
      if (frameRef.current === null) {
        resolve(null)
        return
      }
      // 上一轮还没收尾（正常不会发生）：先让它失败，避免两个 resolve 抢一个位子。
      captureWaiter.current?.(null)
      let settled = false
      const timer = window.setTimeout(() => settle(null), CAPTURE_TIMEOUT_MS)
      function settle(payload: SnapshotCapturePayload | null): void {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        captureWaiter.current = null
        resolve(payload)
      }
      captureWaiter.current = settle
      post({ type: 'capture' })
    })
  }, [post])

  /** 只有真正影响网页上高亮的字段变化才重推。 */
  const signature = useMemo(
    () => itemsOf(annotations)
      .map((item) => `${item.key}|${item.type}|${item.color}|${item.webPosition.selector}|${item.webPosition.start}|${item.webPosition.end}`)
      .join(';'),
    [annotations],
  )

  useEffect(() => {
    if (!readyRef.current) return
    post({ type: 'annotations', items: itemsOf(annotationsRef.current) })
  }, [signature, post])

  const flushLocate = useCallback((): void => {
    const key = pendingLocate.current
    if (key === null || !readyRef.current) return
    pendingLocate.current = null
    post({ type: 'locate', key })
  }, [post])

  /**
   * 桥接脚本报了点击：把 iframe 内的矩形换算到本组件坐标系，卡片就摆在高亮下方。
   *
   * 旧脚本只发 key 不发矩形（Host 缓存过脚本、没重启 DSH 时就是这样）。这时不能
   * 退回左上角——那看起来像「卡片坏了」——改为居中显示，同时把 `staleBridge`
   * 立起来提示重启。
   */
  const openCard = useCallback((key: string, rect: SnapshotRect | null): void => {
    const frame = frameRef.current
    const root = rootRef.current
    if (frame === null || root === null) return
    const frameRect = frame.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    if (rect === null) {
      setStaleBridge(true)
      setCard({ key, x: rootRect.width / 2, y: rootRect.height * 0.32 })
      return
    }
    setCard({
      key,
      x: frameRect.left - rootRect.left + rect.left + rect.width / 2,
      y: frameRect.top - rootRect.top + rect.top + rect.height,
    })
  }, [])

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const frame = frameRef.current
      // opaque origin：只能比对来源窗口，不能看 event.origin（值是 "null"）。
      if (frame === null || event.source !== frame.contentWindow) return
      const data = asSnapshotEvent(event.data)
      if (data === null) return

      if (data.type === 'ready') {
        readyRef.current = true
        setBridgeReady(true)
        const bridge = data.bridge ?? 1
        bridgeVersionRef.current = bridge
        onCaptureChangeRef.current?.()
        setStaleBridge(bridge < SNAPSHOT_BRIDGE_VERSION)
        setBridgeMissing(false)
        // 旧脚本不会报目录：明确报空数组，否则面板永远停在「正在读取目录…」。
        if (bridge < 3) outlineRef.current?.([])
        pushAnnotations()
        flushLocate()
        onReady()
        return
      }
      if (data.type === 'capture-result') {
        captureWaiter.current?.(data.payload)
        return
      }
      if (data.type === 'capture-failed') {
        captureWaiter.current?.(null)
        return
      }
      if (data.type === 'outline') {
        outlineRef.current?.(outlineOf(Array.isArray(data.items) ? data.items : []))
        return
      }
      if (data.type === 'applied') {
        // `error` 非空表示整轮应用失败（桥接脚本已兜住异常并上报），
        // 这时按「全部未定位」提示，比静默停在加载态好。
        setMissed(typeof data.error === 'string' ? data.total : Math.max(0, data.total - data.resolved))
        // 标注已落到 DOM 上，这时候的 locate 才可能命中。
        flushLocate()
        return
      }
      if (data.type === 'selection') {
        selectionRef.current = data.selection
        setSelection(data.selection)
        return
      }
      if (data.type === 'pointerdown') {
        // iframe 里的按下不会进父页面的 `document`：转报一次，打开着的浮层
        // （信息菜单、编辑卡片）自己收起来，见 `dismiss.ts`。
        notifyDocumentPress()
        return
      }
      if (data.type === 'annotation-click') {
        openCard(data.key, data.rect ?? null)
        return
      }
      if (data.type === 'open-external') {
        openExternal(data.href)
      }
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [flushLocate, onReady, pushAnnotations, openCard])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (readyRef.current) return
      setBridgeMissing(true)
      // 桥接脚本没起来就解析不出网页标题，别让目录浮层一直转。
      outlineRef.current?.([])
    }, BRIDGE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [reloadKey])

  // 「脚本没起来」这个状态翻转要让上层重算截图按钮的 title：从「还没加载完」
  // 切到「构建产物缺失」，否则用户看到的仍是旧提示，容易被误导去重启 DSH。
  useEffect(() => {
    onCaptureChangeRef.current?.()
  }, [bridgeMissing])

  // 卡片开着时点别处 / 按 Esc 就收起，与 PDF 卡片同一套（见 `dismiss.ts`）。
  useDismiss(card !== null, cardRef, () => setCard(null))

  /**
   * 把采集能力注册给 `ItemDetail`。
   *
   * 只有这里拿得到 iframe 与消息通道，`shot/` 那边是通用的；注册进去之后
   * 「截图」按钮就走 iframe 适配器。卸载时清空，避免切到 PDF 后还留着旧通道。
   */
  useEffect(() => {
    if (captureRef === undefined) return
    captureRef.current = createIframeAdapter({
      bridgeVersion: () => bridgeVersionRef.current,
      bridgeMissing: () => bridgeMissingRef.current,
      request: requestCapture,
      frame: () => frameRef.current,
    })
    onCaptureChangeRef.current?.()
    return () => {
      captureRef.current = null
      onCaptureChangeRef.current?.()
    }
  }, [captureRef, requestCapture])

  const locate = useCallback((annotationKey: string): boolean => {
    const annotation = annotationsRef.current.find((item) => item.key === annotationKey)
    if (annotation === undefined || annotation.webPosition === null) return false
    pendingLocate.current = annotationKey
    if (!readyRef.current) return false
    pendingLocate.current = null
    post({ type: 'locate', key: annotationKey })
    return true
  }, [post])

  useImperativeHandle(viewerRef, () => ({
    locate,
    currentPage: () => 1,
    goToPage: () => undefined,
    goToOutline: (target) => {
      if (target?.kind === 'anchor') post({ type: 'scroll-to-outline', id: target.id })
    },
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    setZoom: () => undefined,
    fitToWidth: () => undefined,
  }), [locate, viewerRef])

  function handleFrameLoad(): void {
    if (!readyRef.current) setBridgeMissing(true)
  }

  function reload(): void {
    readyRef.current = false
    pendingLocate.current = null
    selectionRef.current = null
    // 版本归零：重载后要等新文档的桥接脚本重新报到，截图按钮在此期间禁用。
    bridgeVersionRef.current = 0
    onCaptureChangeRef.current?.()
    setSelection(null)
    setCard(null)
    setStaleBridge(false)
    setBridgeReady(false)
    setBridgeMissing(false)
    setMissed(0)
    setReloadKey((key) => key + 1)
  }

  async function createMark(type: MarkType, color: string, comment: string): Promise<void> {
    const picked = selectionRef.current
    if (picked === null || source === null) {
      showToast(t('annotation.markUnavailable'))
      return
    }
    setMarking(true)
    try {
      const draft: ZoteroAnnotationDraft = {
        annotationType: type,
        annotationText: picked.text,
        annotationColor: color,
        // 网页快照没有页码概念，Zotero 自己也留空。
        annotationPageLabel: '',
        annotationSortIndex: picked.sortIndex,
        webPosition: { selector: picked.selector, start: picked.start, end: picked.end },
      }
      if (comment !== '') draft.annotationComment = comment
      await createAnnotations({ parentItem: source.attachmentKey, annotations: [draft] })
      showToast(t('annotation.created'))
      post({ type: 'clear-selection' })
      selectionRef.current = null
      setSelection(null)
      onChanged()
    } catch (error) {
      showToast(tpl(t('annotation.writeFailed'), { message: errorText(error) }))
    } finally {
      setMarking(false)
    }
  }

  const bar = selection === null ? null : barPosition(selection, frameRef.current, rootRef.current)

  /** 卡片内容按 key 现取：写入成功后父级重取，颜色 / 类型 / 评论都从库里回填。 */
  const cardAnnotation = card === null
    ? null
    : annotations.find((item) => item.key === card.key) ?? null
  const rootWidth = rootRef.current?.clientWidth ?? 320
  const rootHeight = rootRef.current?.clientHeight ?? 400
  const cardLeft = card === null ? 0 : Math.max(8, Math.min(card.x - 130, rootWidth - 268))
  // 点在下半屏就往上摆，免得卡片顶到容器底部被裁掉。
  const cardAbove = card !== null && card.y > rootHeight * 0.55

  return (
    <div ref={rootRef} style={rootStyle}>
      {/* 与工具条一致：iframe 的无障碍名称也恒为文献标题，不跟着附件的「Snapshot」变。 */}
      <iframe
        key={reloadKey}
        ref={frameRef}
        src={source?.url ?? ''}
        title={detail.title}
        // 不给 allow-same-origin：origin 变 opaque，脚本碰不到父页面与本机 API。
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        style={frameStyle}
        onLoad={handleFrameLoad}
      />
      {bridgeMissing && (
        <div style={noticeStyle}>
          <span>{t('viewer.snapshotNoHighlight')}</span>
          <button type="button" onClick={reload} style={retryStyle}>{t('viewer.snapshotRetry')}</button>
        </div>
      )}
      {!bridgeMissing && missed > 0 && (
        <div style={noticeStyle}>{tpl(t('viewer.highlightPartial'), { n: missed })}</div>
      )}
      {!bridgeMissing && staleBridge && (
        <div style={{ ...noticeStyle, top: 8, bottom: 'auto' }}>{t('viewer.snapshotStaleBridge')}</div>
      )}
      {bar !== null && selection !== null && (
        <SelectionBar
          t={t}
          text={selection.text}
          x={bar.x}
          y={bar.y}
          onInsert={onInsertExcerpt}
          onDismiss={() => {
            selectionRef.current = null
            setSelection(null)
            post({ type: 'clear-selection' })
          }}
          annotate={detail.writeEnabled && source !== null
            ? { busy: marking, onCreate: (type, color, comment) => void createMark(type, color, comment) }
            : undefined}
          translate={{ onTranslate: translation.open }}
        />
      )}
      {translation.view !== null && (
        <TranslationCard
          t={t}
          view={translation.view}
          bounds={{ width: rootWidth, height: rootHeight }}
          engine={translation.engine}
          onEngineChange={translation.setEngine}
          onClose={translation.close}
          onRetry={translation.retry}
          onInsert={onInsertTranslation}
        />
      )}
      {card !== null && cardAnnotation !== null && (
        <AnnotationCard
          t={t}
          annotation={cardAnnotation}
          cardRef={cardRef}
          style={cardAbove ? { left: cardLeft, bottom: rootHeight - card.y + 10 } : { left: cardLeft, top: card.y + 10 }}
          canEdit={detail.writeEnabled && source !== null && EDITABLE_TYPES.has(cardAnnotation.type)}
          onClose={() => setCard(null)}
          onInsert={onInsertAnnotation}
          // 快照没有页码：交给 ItemDetail 走「选中这个附件」那条路。
          onOpenInZotero={() => onOpenInZotero(1)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

/** 子视口坐标 → 父容器坐标；iframe 铺满根节点，所以只差一个偏移。 */
function barPosition(
  selection: SnapshotSelection,
  frame: HTMLIFrameElement | null,
  root: HTMLDivElement | null,
): { x: number; y: number } {
  if (frame === null || root === null) return { x: 0, y: 0 }
  const frameRect = frame.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  const offsetX = frameRect.left - rootRect.left
  const offsetY = frameRect.top - rootRect.top
  return {
    x: offsetX + selection.rect.left + selection.rect.width / 2,
    // 浮条自身是 translate(-50%,-130%)，顶部留出工具条高度，避免被裁掉。
    y: Math.max(36, offsetY + selection.rect.top),
  }
}

const rootStyle = {
  position: 'relative',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
} as const

/**
 * `background: #fff` 不是装饰：快照自身通常没写 body 背景，透明会让
 * 深色主题的容器底色透上来，黑字压深底就看不清了。
 */
const frameStyle = {
  width: '100%',
  height: '100%',
  border: 0,
  display: 'block',
  background: '#fff',
} as const

const noticeStyle: CSSProperties = {
  position: 'absolute',
  left: 8,
  right: 8,
  bottom: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 8px',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'Canvas',
  color: 'CanvasText',
  fontSize: 11.5,
  boxShadow: '0 3px 12px rgba(0,0,0,0.16)',
  zIndex: 9,
} as const

const retryStyle = {
  ...SOFT_BUTTON_STYLE,
  marginLeft: 'auto',
  padding: '2px 8px',
  fontSize: 11.5,
  borderRadius: 5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const
