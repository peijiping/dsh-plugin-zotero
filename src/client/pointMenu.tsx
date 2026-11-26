/**
 * 在鼠标位置弹出的右键菜单（条目列表与分类树共用）。
 *
 * 宿主 `Menu` 的 `anchor` 只认一个元素，菜单会贴在元素边缘；右键菜单要跟着
 * 指针走，所以这里把菜单 portal 到 `document.body`，由一个 fixed 容器按点击坐标
 * 摆位，并按视口边界收回。
 *
 * 子菜单展开方向也要跟着位置判断：右边放不下就翻到左侧，见
 * `.dsh-zotero-point-menu-open-left`。
 */

import { useLayoutEffect, useRef, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

import { useDismiss } from './dismiss'

export interface MenuPoint {
  x: number
  y: number
}

const MENU_CSS = [
  '.dsh-zotero-point-menu [role="menu"]:not([role="menu"] [role="menu"]){position:absolute;inset:0 auto auto 0;position-area:none;margin:0}',
  '.dsh-zotero-point-menu-open-left [role="menu"] [role="menu"]{left:auto;right:calc(100% + 10px)}',
  '.dsh-zotero-point-menu-open-left [role="menu"] [role="menu"]::before{left:auto;right:-10px}',
].join('')

/** 菜单与视口边缘的最小留白。 */
const MENU_GUTTER = 8

/** 给包含长文案的子菜单预留的横向空间，判断是否需要向左翻。 */
const SUBMENU_SPACE = 250

export function MenuAtPoint({ point, items, onClose, onSelect }: {
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
      const x = Math.max(MENU_GUTTER, Math.min(point.x, clientWidth - width - MENU_GUTTER))
      const y = Math.max(MENU_GUTTER, Math.min(point.y + 4, clientHeight - height - MENU_GUTTER))
      container.style.left = `${x}px`
      container.style.top = `${y}px`
      container.classList.toggle('dsh-zotero-point-menu-open-left', x + width + SUBMENU_SPACE > clientWidth)
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
    <>
      <style>{MENU_CSS}</style>
      {/* 直接摆放整个菜单，宿主 Menu 仍负责交互和绘制。 */}
      <div ref={containerRef} className="dsh-zotero-point-menu"
        style={{ display: 'flex', position: 'fixed', left: point.x, top: point.y, zIndex: 1000 }}>
        <Menu
          open
          portal={false}
          onClose={onClose}
          onSelect={onSelect}
          items={items}
          anchor={<span aria-hidden="true" />}
        />
      </div>
    </>,
    document.body,
  )
}
