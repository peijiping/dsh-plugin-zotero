/**
 * 面板里「点别处就关掉」的统一实现。
 *
 * 所有浮层（文献信息菜单、标注编辑卡片，以及以后新加的任何 popover）都走
 * {@link useDismiss}，不要再各写一份 `document.addEventListener('pointerdown')`：
 *
 * - **父页面 DOM 上的按下**：`document` 的 capture 监听，命中浮层自身（`ref` 子树）
 *   就放过。PDF / 纯文本 / 笔记条目都渲染在父 DOM 里，这一条已经覆盖。
 * - **文档正文里的按下**：网页快照跑在 sandbox iframe 里，指针事件不进父文档，
 *   `document` 监听永远看不到。这类渲染器把「听不见的那种按下」用
 *   {@link notifyDocumentPress} 转报一次即可 —— 浮层侧一行都不用改，也不用把回调
 *   沿着 `DocumentView` → 渲染器一路透传。
 * - **Esc** 与按下是同一份订阅：浮层打开期间按一下就关。
 *
 * 渲染器该做什么：只有**自带独立文档表面**（iframe、未来的 canvas 外挂窗口等）的
 * 渲染器需要调 `notifyDocumentPress()`；跑在父 DOM 里的渲染器什么都不用做。
 */

import { useEffect, useRef, type RefObject } from 'react'

/** 同时打开的浮层最多一两个，Set 直接遍历比任何通知框架都简单。 */
const pressListeners = new Set<() => void>()

/**
 * iframe 类渲染器专用：把「文档正文里按下了指针」转报给打开着的浮层。
 *
 * 只报事实，关什么由各浮层自己决定（信息菜单收菜单，编辑卡片收卡片）。
 * 父 DOM 里的渲染器**不要**调：那条路径已经被 `document` 监听覆盖。
 */
export function notifyDocumentPress(): void {
  for (const listener of [...pressListeners]) listener()
}

/**
 * 浮层打开期间（`open` 为 true）点 `ref` 外面或按 Esc 就调 `onDismiss`。
 *
 * `onDismiss` 由 ref 转发：调用方传内联箭头也不会让监听反复重挂。
 * 传 `null` 的 ref 视为「还没挂载」，此时任何按下都算在外面。
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    if (!open) return
    const dismiss = (): void => dismissRef.current()
    const onPointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node) === true) return
      dismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    pressListeners.add(dismiss)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      pressListeners.delete(dismiss)
    }
  }, [open, ref])
}
