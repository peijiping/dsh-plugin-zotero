/**
 * 左上角两个浮层（目录 / 信息）共用的几何：**贴在右栏外侧 + 可拖位置 + 可拖大小 +
 * 按条目记住上次的摆法**。
 *
 * 画在右栏外面是因为这两个浮层都是「开着反复用」的长列表，压在正文上会挡住正在读
 * 的那页；右边缘贴右栏左边界外一格，顶边与触发按钮下方对齐。左侧实在挤不下（窗口
 * 很窄）或发现自己被裁掉时，退回右栏内原位 —— 宁可挡一点正文，也不能点了什么都不
 * 显示。
 *
 * 为什么不用 portal：client bundle 只有 `react` 在宿主模块表里，`react-dom` 取不到
 * （`createPortal` 直接 TS2307）。`fixed` 元素只要祖先没有 `transform` / `filter` /
 * `contain` 就不会被 `overflow` 裁掉；万一以后加了这类属性，打开后做一次「取样点
 * 还看得见自己吗」的自检就能发现并降级（见 {@link probeOutside}）。
 *
 * 几何的持久化交给 `viewStateStore`：Host 把 `pos` / `size` 与阅读进度写在同一个
 * `view-state.json` 里，按条目 key 各一份。`pos` / `size` 只覆盖「本次打开」，
 * 关掉再开就重新从存档读 —— 于是「初始位置」与「上次拖动后的位置」是同一个来源，
 * 不会出现两套互相打架的坐标。
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'

import type { ZoteroPanelKind } from '../zotero/types'
import { readPanelBox, writePanelBox } from './viewStateStore'

export interface FloatingBoxOptions {
  open: boolean
  /** 测量基准：覆盖整个阅读区的透明容器，它的 `left` 就是右栏左边界。 */
  anchorRef: { readonly current: HTMLElement | null }
  /** 条目 key：几何按它各记一份，换一篇文献就是另一套摆法。 */
  itemKey: string
  kind: ZoteroPanelKind
  /** 初始宽度。 */
  width: number
  /** 左侧放得下这个宽度才摆到右栏外，否则退回右栏内。 */
  minWidth: number
  /** 拖出来的高度下限。 */
  minHeight: number
  /**
   * 是否把几何持久化到 view-state（默认 `true`，供按条目记位置的目录 / 信息浮层用）。
   *
   * `false` 给面板级浮层（如「使用帮助」）：没有真实 itemKey，拖 / 缩只在本会话内存里
   * 生效，关掉或刷新后复位，绝不往 view-state 写假条目键。
   */
  persist?: boolean
}

/** 一组指针事件处理器，直接铺到拖动把手上。 */
export interface DragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void
}

export interface FloatingBoxApi {
  /** 面板本体；`fixed`，与触发按钮是兄弟节点。 */
  panelRef: RefObject<HTMLDivElement>
  /** 面板几何；`null` 表示还没量到（先别渲染面板，否则会闪一帧）。 */
  style: CSSProperties | null
  /** 铺到面板根节点上：把浮层矩形从宿主的窗口拖拽区里挖掉（见 {@link WINDOW_DRAG_EXCLUDE}）。 */
  panelProps: { 'data-window-drag-exclude': string }
  /** 标题栏用：按住拖动位置。 */
  moveProps: DragHandlers
  /** 右下角把手用：拖动大小。 */
  resizeProps: DragHandlers
}

/** 与右栏左边界、窗口边缘之间的留白。 */
const GAP = 10
/** 顶边偏移：落在触发按钮（top:4，高 22）下方。 */
const TOP_OFFSET = 32
/** 退回右栏内时的左缩进。 */
const INSIDE_INSET = 8
/** 右栏内可用宽度的兜底下限。 */
const INSIDE_MIN_WIDTH = 160
/** 拖宽的硬上限，再宽只是白白盖住正文。 */
const RESIZE_MAX_WIDTH = 720

/**
 * 面板根节点上的「别拖窗口」声明。
 *
 * macOS 宿主的窗口拖拽区是**几何矩形**，不是命中测试：它给整行 chrome 打
 * `data-window-drag`（对话头部、侧栏顶条、dockkit tabStrip …），浮层只要在几何上
 * 压住那一行，那段像素就归窗口拖拽 —— 谁画在上层、有没有 pointer capture 都不算数。
 * 于是把浮层拖到 y≈22（压到对话头部那行）后按住标题栏，动的是整个 DSH 窗口，
 * 浮层反而拖不动了。
 *
 * 宿主留的出口是 `[data-window-drag-exclude]{-webkit-app-region:no-drag}`（base.css），
 * 且 0.2.2-rc.1 起 `role="dialog"` 之类只在 `data-window-drag` / `-controls` 作用域内
 * 才自动豁免 no-drag —— 浮层在阅读区里，拿不到那份豁免，必须自己声明。挂了它，
 * 浮层的整个矩形从拖拽区里被减掉：无论拖到窗口哪儿，按下的都是浮层自己。
 *
 * 译文浮层（`viewer/TranslationCard`）压在正文上，会碰到同一行带子，共用这一份。
 */
export const WINDOW_DRAG_EXCLUDE = { 'data-window-drag-exclude': '' } as const

/** 手动拖动出来的位置（视口坐标）。`null` 表示用初始位置。 */
interface PanelPos {
  left: number
  top: number
}

/** 手动拖出来的尺寸。`null` 表示宽度用初始值、高度随内容。 */
interface PanelSize {
  width: number
  height: number
}

interface PanelLayout {
  left: number
  top: number
  width: number
  maxHeight: number
  /** 是否退回右栏内（不再是「正文外侧」）。 */
  inside: boolean
}

/** 拖动中的起点与基准矩形；`move` 改位置，`resize` 改尺寸。 */
interface DragState {
  kind: 'move' | 'resize'
  startX: number
  startY: number
  baseLeft: number
  baseTop: number
  baseWidth: number
  baseHeight: number
}

/**
 * 最近一次「摆到右栏外看得见吗」的结论，只用作下次打开的起点。
 *
 * 早先这里是「一次失败就整个会话锁死在右栏内」：拖动中取样点偶尔被别的元素
 * 临时盖住，就会误判成 `fixed` 被祖先裁剪，之后浮层跳回右栏内且再也拖不动。
 * 现在每次打开都重探一次、成功就复位；误判最坏只影响这次打开，关掉重开即好。
 */
let lastProbeBlocked = false

/**
 * 算浮层的位置。
 *
 * `rect` 是阅读区容器的视口矩形：它的 `left` 就是右栏左边界。放得下最小宽度就
 * 贴右栏左边往外摆，放不下（或本次判定摆不出去）就退回右栏内。
 */
function measureLayout(
  rect: DOMRect,
  options: FloatingBoxOptions,
  blockedOutside: boolean,
): PanelLayout {
  const top = Math.round(rect.top + TOP_OFFSET)
  const maxHeight = Math.max(180, Math.round(window.innerHeight - top - 16))
  const available = Math.round(rect.left - GAP * 2)
  if (!blockedOutside && available >= options.minWidth) {
    const width = Math.min(options.width, available)
    return { left: Math.round(rect.left - width - GAP), top, width, maxHeight, inside: false }
  }
  const width = Math.max(INSIDE_MIN_WIDTH, Math.min(options.width, Math.round(rect.width - 16)))
  return { left: Math.round(rect.left + INSIDE_INSET), top, width, maxHeight, inside: true }
}

/** 位置夹在可视区内，别把浮层拖到窗口外找不回来。 */
function clampPos(pos: PanelPos, width: number, height: number): PanelPos {
  const maxLeft = Math.max(0, window.innerWidth - width)
  const maxTop = Math.max(0, window.innerHeight - height)
  return {
    left: Math.round(Math.min(Math.max(0, pos.left), maxLeft)),
    top: Math.round(Math.min(Math.max(0, pos.top), maxTop)),
  }
}

/** 尺寸同样夹在可视区内：右下角拖动时 `left` / `top` 不动，可用空间按它们算。 */
function clampSize(size: PanelSize, left: number, top: number, options: FloatingBoxOptions): PanelSize {
  const maxWidth = Math.max(
    options.minWidth,
    Math.min(RESIZE_MAX_WIDTH, window.innerWidth - left - 8),
  )
  const maxHeight = Math.max(options.minHeight, window.innerHeight - top - 8)
  return {
    width: Math.round(Math.min(Math.max(options.minWidth, size.width), maxWidth)),
    height: Math.round(Math.min(Math.max(options.minHeight, size.height), maxHeight)),
  }
}

/**
 * 自检：浮层左右上角取两个点，`elementFromPoint` 都应该落在浮层自己身上。
 *
 * 被 `transform` / `filter` / `contain` 祖先建立包含块后，`fixed` 会相对那个祖先
 * 定位并被它的 `overflow` 裁掉，取样点就落到别的元素上 —— 此时返回 false。
 */
function probeOutside(node: HTMLElement, box: { left: number; top: number; width: number }): boolean {
  const points: Array<[number, number]> = [
    [box.left + 6, box.top + 12],
    [box.left + box.width - 6, box.top + 12],
  ]
  return points.every(([x, y]) => {
    const hit = document.elementFromPoint(x, y)
    return hit !== null && node.contains(hit)
  })
}

export function useFloatingBox(options: FloatingBoxOptions): FloatingBoxApi {
  const { open, anchorRef, itemKey, kind } = options
  const panelRef = useRef<HTMLDivElement>(null)

  const [layout, setLayout] = useState<PanelLayout | null>(null)
  const [pos, setPos] = useState<PanelPos | null>(null)
  const [size, setSize] = useState<PanelSize | null>(null)
  /** 本次打开是否被判成「摆不到右栏外」；只在这次打开里生效。 */
  const [blockedOutside, setBlockedOutside] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  /** 这次按下是否真的挪动过：只在标题栏点一下不该把位置钉死。 */
  const movedRef = useRef(false)
  /** 本次打开用户是否真拖过位置：退回右栏内后也要让他继续挪得动。 */
  const draggedRef = useRef(false)

  /** 镜像一份给 `measure` 用：那里在事件回调里跑，读 state 会拿到旧闭包。 */
  const posRef = useRef<PanelPos | null>(null)
  const sizeRef = useRef<PanelSize | null>(null)
  posRef.current = pos
  sizeRef.current = size
  /** 同上：ResizeObserver 回调里读降级结论。 */
  const blockedRef = useRef(false)
  blockedRef.current = blockedOutside

  /** 事件回调里读参数：`options` 每次渲染都是新对象，不适合进依赖。 */
  const optsRef = useRef(options)
  optsRef.current = options

  // 打开 / 换条目时把这一条自己记的几何搬回来；没记过就用右栏左侧的初始位。
  //
  // 用 layout effect 而不是 effect：否则会先按初始位画一帧再跳到记住的位置。
  // 恢复时先夹一次：存档可能来自更大的窗口，直接照搬会把浮层扔到可视区外。
  // 每次打开都把降级结论清掉重探一遍：上次的结论只用来跳过记忆里的外侧坐标
  // （真被裁时那些坐标会画到看不见的地方），不能让它一直生效。
  useLayoutEffect(() => {
    if (!open) return
    draggedRef.current = false
    setBlockedOutside(false)
    blockedRef.current = false
    const saved = optsRef.current.persist === false ? null : readPanelBox(itemKey, kind)
    const nextSize = saved?.size === undefined ? null : clampSize(saved.size, 0, 0, optsRef.current)
    setSize(nextSize)
    const savedPos = lastProbeBlocked ? undefined : saved?.pos
    setPos(savedPos === undefined
      ? null
      : clampPos(
        savedPos,
        nextSize?.width ?? optsRef.current.width,
        nextSize?.height ?? Math.min(480, window.innerHeight),
      ))
  }, [open, itemKey, kind])

  // 打开时量一次，之后跟右栏宽度 / 窗口尺寸走。
  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (anchor === null) return

    const measure = (): void => {
      const rect = anchor.getBoundingClientRect()
      if (rect.width === 0) return
      const next = measureLayout(rect, optsRef.current, blockedRef.current)
      setLayout((prev) => (prev !== null
        && prev.left === next.left
        && prev.top === next.top
        && prev.width === next.width
        && prev.maxHeight === next.maxHeight
        && prev.inside === next.inside
        ? prev
        : next))

      // 拖过的浮层跟着窗口收敛：窗口一变，别让它一半留在可视区外。
      setPos((prev) => {
        if (prev === null) return prev
        const width = sizeRef.current?.width ?? next.width
        const height = sizeRef.current?.height ?? next.maxHeight
        const clamped = clampPos(prev, width, height)
        return clamped.left === prev.left && clamped.top === prev.top ? prev : clamped
      })
      setSize((prev) => {
        if (prev === null) return prev
        const clamped = clampSize(
          prev,
          posRef.current?.left ?? next.left,
          posRef.current?.top ?? next.top,
          optsRef.current,
        )
        return clamped.width === prev.width && clamped.height === prev.height ? prev : clamped
      })
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer !== null) observer.observe(anchor)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, blockedOutside])

  // 在右栏外时确认一次「真的看得见」；被裁才退回右栏内原位。
  //
  // 只探**默认外侧位**（`pos === null`、本次没拖过）：用户拖过 / 记忆恢复的位置上，
  // 取样点可能落在聊天区别的高层元素上，拿它判「祖先是否裁剪」是假阳性。取样一律
  // 用 DOM 实际矩形，不用 state 里的坐标快照 —— 拖动中每帧都变，快照与画面错开一帧
  // 就会误判，把用户正在拖的窗口一把抢回右栏内。
  //
  // 连续两帧都看不见自己才降级：宿主偶尔闪一下的遮罩不该让人换位置。
  useLayoutEffect(() => {
    if (!open || layout === null || layout.inside) return
    if (pos !== null || draggedRef.current) return
    const node = panelRef.current
    if (node === null) return
    /** 拖动起手、或中途换条目，都让待执行的判定作废。 */
    const stillDefault = (): boolean => dragRef.current === null && !draggedRef.current
    let confirmFrame = 0
    const frame = window.requestAnimationFrame(() => {
      if (!stillDefault()) return
      if (probeOutside(node, node.getBoundingClientRect())) {
        lastProbeBlocked = false
        return
      }
      confirmFrame = window.requestAnimationFrame(() => {
        if (!stillDefault()) return
        if (probeOutside(node, node.getBoundingClientRect())) {
          lastProbeBlocked = false
          return
        }
        lastProbeBlocked = true
        setBlockedOutside(true)
        setPos(null)
        const anchor = anchorRef.current
        if (anchor !== null) {
          setLayout(measureLayout(anchor.getBoundingClientRect(), optsRef.current, true))
        }
      })
    })
    return () => {
      window.cancelAnimationFrame(frame)
      if (confirmFrame !== 0) window.cancelAnimationFrame(confirmFrame)
    }
  }, [open, layout, pos, anchorRef])

  /**
   * 开始拖：记下起点与当前几何，把指针捕获到把手上。
   *
   * 指针捕获是必须的 —— 不然鼠标一滑出面板（或窗口），后续 `pointermove` 就没了，
   * 浮层会卡在半路。
   */
  function beginDrag(mode: 'move' | 'resize', event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0) return
    // 标题栏里的图钉是按钮：按它不能顺手把面板拖走。
    if ((event.target as HTMLElement).closest('button') !== null) return
    const node = panelRef.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    dragRef.current = {
      kind: mode,
      startX: event.clientX,
      startY: event.clientY,
      baseLeft: rect.left,
      baseTop: rect.top,
      baseWidth: rect.width,
      baseHeight: rect.height,
    }
    movedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function handleDrag(event: ReactPointerEvent<HTMLElement>): void {
    const drag = dragRef.current
    if (drag === null) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) movedRef.current = true
    if (drag.kind === 'move') {
      // 哪怕已经退回右栏内，本次手动拖的位置也要照用，别把窗口锁死。
      if (movedRef.current) draggedRef.current = true
      setPos(clampPos({ left: drag.baseLeft + dx, top: drag.baseTop + dy }, drag.baseWidth, drag.baseHeight))
      return
    }
    setSize(clampSize(
      { width: drag.baseWidth + dx, height: drag.baseHeight + dy },
      drag.baseLeft,
      drag.baseTop,
      optsRef.current,
    ))
  }

  /**
   * 收尾时落盘：位置和尺寸各记各的，只写这次动过的那一项。
   *
   * 用 `getBoundingClientRect()` 而不是 state —— `pointerup` 前最后一次
   * `pointermove` 的 setState 不一定已经提交，量 DOM 最准。
   */
  function endDrag(event: ReactPointerEvent<HTMLElement>): void {
    const drag = dragRef.current
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag === null || !movedRef.current) return
    movedRef.current = false
    const node = panelRef.current
    if (node === null) return
    const rect = node.getBoundingClientRect()
    if (optsRef.current.persist === false) return
    if (drag.kind === 'move') {
      writePanelBox(itemKey, kind, { pos: { left: Math.round(rect.left), top: Math.round(rect.top) } })
      return
    }
    writePanelBox(itemKey, kind, { size: { width: Math.round(rect.width), height: Math.round(rect.height) } })
  }

  // 退回右栏内时，记忆里的外侧坐标不该把浮层又顶出去；但**本次真的拖过**的位置
  // 是用户明确的意图，照用 —— 否则一旦降级，标题栏就成了按不动的死把手。
  const usePos = layout !== null && (!layout.inside || draggedRef.current)
  const style: CSSProperties | null = layout === null
    ? null
    : {
      left: usePos ? (pos?.left ?? layout.left) : layout.left,
      top: usePos ? (pos?.top ?? layout.top) : layout.top,
      width: size?.width ?? layout.width,
      // 没人拖过大小就让高度跟着内容走（顶到 maxHeight 为止）。
      ...(size === null ? { maxHeight: layout.maxHeight } : { height: size.height }),
    }

  const moveProps: DragHandlers = {
    onPointerDown: (event) => beginDrag('move', event),
    onPointerMove: handleDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }
  const resizeProps: DragHandlers = {
    onPointerDown: (event) => beginDrag('resize', event),
    onPointerMove: handleDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }

  return { panelRef, style, panelProps: WINDOW_DRAG_EXCLUDE, moveProps, resizeProps }
}
