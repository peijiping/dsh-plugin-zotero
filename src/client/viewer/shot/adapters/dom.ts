/**
 * 父 DOM 采集适配器（纯文本 / Markdown / Zotero 笔记）。
 *
 * 只用 `html-to-image@1.11.13` 这一个第三方依赖（SVG foreignObject + cloneNode
 * + computedStyle 内联，gzip 5.1 KB / 0 依赖 / MIT）。`light-dark()` 与 CSS 变量
 * 靠 computed value 解析成具体 rgb 内联进 clone —— 这是推理链而非官方支持声明，
 * 深浅主题是否偏色必须实跑比对。
 *
 * 两条硬约束：
 * 1. **filter 丢掉外链 `<img>`**：`sanitizeNoteHtml()` 保留笔记原外链 URL，
 *    不丢会 taint canvas 让 `toBlob` 抛 `SecurityError`。项目无 Web 字体 → skipFonts。
 * 2. **只截可见区**：整篇 clone 会撞 dataURI 上限；用 width/height + 滚动平移。
 */

import { toBlob } from 'html-to-image'

import type {
  CaptureAdapter,
  CaptureFrame,
  HeadingBox,
  TextBox,
} from '../types'

/** 1×1 浅灰 PNG，作为保留图片 decode 失败时的占位。 */
const IMAGE_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const ANIMATION_FREEZE = '*, *::before, *::after { animation: none !important; transition: none !important; }'

function relative(rect: DOMRect, box: DOMRectReadOnly): {
  left: number; top: number; width: number; height: number
} {
  return { left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height }
}

/** `rgba(0,0,0,0)` / `transparent` 都算没底色，需要往上层找。 */
function isTransparent(color: string): boolean {
  if (color === '' || color === 'transparent') return true
  const match = /^rgba?\(([^)]+)\)$/u.exec(color)
  if (match === null) return false
  const parts = match[1].split(/[\s,/]+/u).filter((part) => part !== '')
  return parts.length >= 4 && Number.parseFloat(parts[3] ?? '1') === 0
}

/**
 * 找到一层不透明底色作为位图背景。
 *
 * 正文容器自己通常是透明的（底色在 panel 上），直接取会拿到 `rgba(0, 0, 0, 0)`，
 * 导出的 PNG 就成了透明底——深色主题里看着没事，转发到别处或被模型读图时
 * 会合成成黑块。所以逐层往上找，都不透明才退回白色。
 */
function opaqueBackground(root: HTMLElement): string {
  let element: HTMLElement | null = root
  while (element !== null) {
    const color = window.getComputedStyle(element).backgroundColor
    if (!isTransparent(color)) return color
    element = element.parentElement
  }
  return '#ffffff'
}

function isScrollable(overflowX: string, overflowY: string): boolean {
  return overflowY === 'auto' || overflowY === 'scroll' || overflowX === 'auto' || overflowX === 'scroll'
}

/**
 * 找真正滚动的那一层（TextViewer 的正文容器就是它的根节点）。
 *
 * **必须以它为克隆根**，不能克隆外层容器：`cloneNode` 不复制 `scrollTop`，
 * 克隆出来的是文档顶部；而滚动容器自己会裁切内容，整体平移外层只能拿到
 * 顶部那一段。以滚动容器为根 + `overflow: visible` 再平移，窗口里才是当前
 * 可见区。
 */
function findScroller(root: HTMLElement): HTMLElement {
  const own = window.getComputedStyle(root)
  if (isScrollable(own.overflowX, own.overflowY)
    && (root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1)) {
    return root
  }
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const style = window.getComputedStyle(element)
    if (!isScrollable(style.overflowX, style.overflowY)) continue
    if (element.scrollTop !== 0 || element.scrollLeft !== 0
      || element.scrollHeight > element.clientHeight + 1
      || element.scrollWidth > element.clientWidth + 1) {
      return element
    }
  }
  return root
}

/**
 * 几何信息自己取，不依赖第三方库：文字盒按矩形相交给摘要，标题盒给章节反查。
 * 用 TreeWalker 只遍历文本节点，避免把整棵 DOM 复制一份。
 */
function collectGeometry(root: HTMLElement, box: DOMRectReadOnly): {
  boxes: TextBox[]
  headings: HeadingBox[]
} {
  const boxes: TextBox[] = []
  const headings: HeadingBox[] = []

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node !== null) {
    const text = node.textContent ?? ''
    if (text.trim() !== '' && node.parentElement !== null) {
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = relative(range.getBoundingClientRect(), box)
      if (rect.width > 0 && rect.height > 0) boxes.push({ text, rect })
    }
    node = walker.nextNode()
  }

  for (const element of root.querySelectorAll<HTMLElement>(
    'h1, h2, h3, h4, h5, h6, [data-dsh-zp-outline], [data-dsh-zotero-outline]',
  )) {
    const title = (element.textContent ?? '').trim()
    if (title === '') continue
    const rect = relative(element.getBoundingClientRect(), box)
    const level = Number.parseInt(element.tagName.slice(1), 10)
    headings.push({ title, rect, depth: Number.isFinite(level) ? level : 1 })
  }
  boxes.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
  headings.sort((a, b) => a.rect.top - b.rect.top)
  return { boxes, headings }
}

export function createDomAdapter(): CaptureAdapter {
  return {
    async capture(root, box): Promise<CaptureFrame | null> {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const target = findScroller(root)
      const targetBox = target.getBoundingClientRect()
      const origin = { left: targetBox.left - box.left, top: targetBox.top - box.top }
      const scroll = { left: target.scrollLeft, top: target.scrollTop }
      const background = opaqueBackground(target)
      const freeze = document.createElement('style')
      freeze.textContent = ANIMATION_FREEZE
      // 挂在克隆根上才管得住这次采集里的动画（克隆根是滚动容器，不一定是正文容器）。
      target.appendChild(freeze)
      try {
        const png = await toBlob(target, {
          width: box.width,
          height: box.height,
          pixelRatio: dpr,
          backgroundColor: background,
          skipFonts: true,
          cacheBust: false,
          imagePlaceholder: IMAGE_PLACEHOLDER,
          filter: (node) => {
            if (node instanceof HTMLImageElement) return /^(data|blob):/u.test(node.src)
            // 冻结用的 <style> 没必要进 clone。
            return !(node instanceof HTMLStyleElement && node.textContent === ANIMATION_FREEZE)
          },
          style: {
            // 克隆里 scrollTop 恒为 0：先让内容不再被裁切，再把整块内容上移
            // 一个滚动量，窗口（= 可见区）里就正好是用户此刻看到的那一段。
            transform: `translate(${-scroll.left}px, ${-scroll.top}px)`,
            transformOrigin: '0 0',
            overflow: 'visible',
            width: `${box.width}px`,
            height: `${box.height}px`,
            maxWidth: 'none',
            maxHeight: 'none',
            margin: '0',
          },
        })
        if (png === null) return null
        const geometry = collectGeometry(root, box)
        return {
          png,
          cssWidth: box.width,
          cssHeight: box.height,
          dpr,
          origin,
          boxes: geometry.boxes,
          headings: geometry.headings,
          pages: [],
        }
      } catch {
        return null
      } finally {
        freeze.remove()
      }
    },
  }
}
