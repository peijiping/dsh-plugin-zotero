/**
 * 网页快照采集适配器（sandbox iframe）。
 *
 * iframe 的 origin 是 opaque：父页面碰不到里面的 DOM，也没法把 html-to-image
 * 送进去。所以分两步：
 *   1. 桥接脚本把整页序列化成自包含 HTML + CSS，连同滚动位置、文字盒、标题盒
 *      一起回传（见 `src/snapshot/runtime.js` 的 `capturePage`）；
 *   2. 父页面把这份 DOM 重建在一个**屏幕外、透明**的层里（样式已限定在该层内），
 *      用与纯文本路径同一个 html-to-image 出图。
 *
 * 为什么不让 iframe 自己 `toDataURL`：opaque origin 下 `blob:` 图像会 taint
 * canvas（实测抛 `SecurityError`），而 `data:` SVG 那条路要在桥接脚本里再装一份
 * 序列化器。交给父页面还有个好处——两条路径共用同一套保真度与失败兜底。
 *
 * 重建宽度取**正文容器**（而不是 iframe 的 `clientWidth`）：两者差一条滚动条的
 * 宽度，用容器宽度才不会让框选坐标与位图差一个比例。
 */

import { toBlob } from 'html-to-image'

import type { SnapshotCapturePayload } from '../../snapshotProtocol'
import { IMAGE_PLACEHOLDER } from './dom'
import type { CaptureAdapter, CaptureFrame } from '../types'

/** 桥接脚本版本低于这个值时，说明宿主加载的还是旧脚本（构建产物没更新）。 */
export class StaleBridgeError extends Error {
  constructor() {
    super('snapshot bridge is stale')
    this.name = 'StaleBridgeError'
  }
}

export interface IframeAdapterDeps {
  /** 当前 iframe 里桥接脚本的版本；`0` 表示还没收到 `ready`。 */
  bridgeVersion(): number
  /** 发 `capture` 并等结果；超时或失败返回 `null`。 */
  request(): Promise<SnapshotCapturePayload | null>
  frame(): HTMLIFrameElement | null
}

const FALLBACK_BACKGROUND = '#ffffff'

/**
 * 重建前必须剥掉的标签。
 *
 * 回传的 HTML 来自一个**不可信的文档**（网页快照里的脚本随便怎么写），而它要被
 * 注入到父页面 —— 也就是本机回环 origin 的文档里。`script` 标签在快照侧已经
 * 剥过一遍，这里再来一次是「不信任上游」：任何能执行、能外发、能自建文档表面的
 * 元素都不留。
 */
const DROP_TAGS = new Set([
  'SCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'FORM', 'LINK', 'META', 'BASE', 'TEMPLATE', 'NOSCRIPT', 'STYLE',
])

/** `javascript:` 一类的伪协议；`data:` 只放行图片，别的（含 svg 文档）一律不认。 */
function isDangerousUrl(value: string): boolean {
  const normalized = value.replace(/[\u0000-\u0020]/gu, '').toLowerCase()
  return normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')
}

/**
 * 就地净化一棵惰性 DOM。
 *
 * 只清 `on*` 不够，也不该只清 `on*`：`href="javascript:..."`、`<form action>`、
 * `<iframe srcdoc>` 同样是执行面。CSS 里的 `url(http://...)` 能外发数据，但那是
 * 追踪像素级别的问题，剪掉样式反而会把版面弄坏，只处理 `url(javascript:)`。
 */
function sanitize(root: ParentNode): void {
  const doomed: Element[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let element = walker.nextNode() as Element | null
  while (element !== null) {
    if (DROP_TAGS.has(element.tagName.toUpperCase())) {
      doomed.push(element)
    } else {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase()
        if (name.startsWith('on')) {
          element.removeAttribute(attribute.name)
          continue
        }
        if (isDangerousUrl(attribute.value)) {
          element.removeAttribute(attribute.name)
          continue
        }
        if (name === 'srcdoc') element.removeAttribute(attribute.name)
      }
    }
    element = walker.nextNode() as Element | null
  }
  for (const node of doomed) node.remove()
}

/** `rgba(0,0,0,0)` / `transparent` / 空串都算没有底色。 */
function isTransparent(color: string): boolean {
  if (color === '' || color === 'transparent') return true
  const match = /^rgba?\(([^)]+)\)$/u.exec(color)
  if (match === null) return false
  const parts = match[1].split(/[\s,/]+/u).filter((part) => part !== '')
  return parts.length >= 4 && Number.parseFloat(parts[3] ?? '1') === 0
}

/** 从桥接脚本带回来的 body 计算样式里取底色。 */
function backgroundColorOf(payload: SnapshotCapturePayload): string {
  const match = /background-color:\s*([^;]+)/u.exec(payload.bodyStyle)
  const value = match?.[1]?.trim() ?? ''
  return isTransparent(value) ? FALLBACK_BACKGROUND : value
}

/**
 * 重建层的定位：**外壳**移出屏幕，被截元素自己始终待在 `(0,0)`。
 *
 * 有个两难：容器不能留在视口里（栅格化要几十毫秒，用户会看见整页内容闪一下），
 * 也不能把偏移写在容器自己身上 —— html-to-image 会把容器的计算样式（含
 * `left:-10000px`）一起抄进 foreignObject，内容整块跑出画布，导出的是一张纯白图；
 * 用 `options.style` 事后覆盖也救不回来（实测仍是全白）。
 *
 * 所以拆两层：外壳负责挪走和透明，被截元素的计算样式里 `position:relative` +
 * `left:auto`，没有任何偏移可抄。祖先的位移不会进 inline style。
 *
 * 不用 `visibility:hidden`：它是可继承属性，每个子节点算出来都是 `hidden`，会被
 * 逐个写成 inline style，比 opacity 更难收拾。`opacity` 只污染外壳自己。
 */
const OFFSCREEN_LEFT = -10000

/** 重建层根节点的标记属性，样式规则全部以它为前缀。 */
const SCOPE = '[data-dsh-zp-shot-root]'

/** 顶层逗号切分：`:is(a, b)` 里的逗号不算。 */
function splitSelectors(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 单条选择器限定到重建层内；返回空串表示这条规则丢弃。 */
function scopeSelector(selector: string): string {
  const trimmed = selector.trim()
  if (trimmed === '') return ''
  // `html` / `body` / `:root` 就是重建层自己，body 的排版另由 bodyStyle 补。
  if (/^(?:html|body|:root)$/u.test(trimmed)) return SCOPE
  const head = /^(?:html|body|:root)(?![\w-])/u.exec(trimmed)
  if (head !== null) {
    const rest = trimmed.slice(head[0].length).trim()
    if (rest === '') return SCOPE
    return `${SCOPE} ${rest}`
  }
  return `${SCOPE} ${trimmed}`
}

/**
 * 把快照样式表限定在重建层内。
 *
 * 注入的 `<style>` 是**文档级作用域**：快照页面里的 `body {}`、`p {}`、`* {}`
 * 会在采集那几十毫秒里改掉宿主自己的排版（然后随节点移除恢复），用户看到的就是
 * 「点一下截图，界面抖一下」。所以每条规则都要挂前缀。
 *
 * `@import` 直接丢弃：它会在宿主文档里外发请求。
 */
function scopeCss(css: string): string {
  let sheet: CSSStyleSheet
  try {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
  } catch {
    return ''
  }

  const walk = (rules: CSSRuleList): string => {
    const chunks: string[] = []
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const scoped = splitSelectors(rule.selectorText)
          .map(scopeSelector)
          .filter((item) => item !== '')
        if (scoped.length === 0) continue
        chunks.push(`${scoped.join(',')}{${rule.style.cssText}}`)
      } else if (rule instanceof CSSMediaRule) {
        chunks.push(`@media ${rule.conditionText}{${walk(rule.cssRules)}}`)
      } else if (rule instanceof CSSSupportsRule) {
        chunks.push(`@supports ${rule.conditionText}{${walk(rule.cssRules)}}`)
      } else if (
        rule instanceof CSSKeyframesRule
        || rule instanceof CSSFontFaceRule
        || rule instanceof CSSPageRule
      ) {
        // 名字型规则对选择器无关，原样保留（否则动画与自定义字体会失效）。
        chunks.push(rule.cssText)
      }
    }
    return chunks.join('')
  }

  return walk(sheet.cssRules)
}

/**
 * 把回传的 DOM 重建成一张位图。
 *
 * 真身全程不可见，`ItemDetail` 里 zIndex 23 的「正在采集」层只负责告诉用户
 * 在干活。
 */
async function rasterize(
  payload: SnapshotCapturePayload,
  width: number,
  height: number,
  pixelRatio: number,
): Promise<Blob | null> {
  const outer = document.createElement('div')
  outer.setAttribute('data-dsh-zp-shot-stage', '')
  outer.style.cssText = [
    'position:fixed',
    `left:${OFFSCREEN_LEFT}px`,
    'top:0',
    'z-index:1',
    `width:${width}px`,
    `height:${height}px`,
    'overflow:hidden',
    'opacity:0',
    'pointer-events:none',
  ].join(';')

  const host = document.createElement('div')
  host.setAttribute('data-dsh-zp-shot-root', '')
  host.style.cssText = [
    'position:relative',
    'width:100%',
    'height:100%',
    'overflow:hidden',
    `background:${backgroundColorOf(payload)}`,
  ].join(';')

  const style = document.createElement('style')
  style.textContent = scopeCss(payload.css)
  host.appendChild(style)

  /** body 的替身：字体与内边距套在这一层，和 iframe 里的 body 一致。 */
  const stage = document.createElement('div')
  stage.style.cssText = [
    `width:${payload.stageWidth}px`,
    payload.bodyStyle,
    'box-sizing:border-box',
    'overflow:visible',
    // 克隆出来的 DOM 滚动位置恒为 0：先按内容原点摆回它原来的位置，再把整块
    // 内容上移一个滚动量，窗口（= 可见区）里才是用户此刻看到的那一段。
    `transform:translate(${payload.offsetLeft - payload.scrollLeft}px, ${payload.offsetTop - payload.scrollTop}px)`,
    'transform-origin:0 0',
  ].join(';')

  /*
   * 用 `<template>` 装一次再搬过去，而不是直接 `innerHTML`：
   * template 的内容是惰性的 —— 不执行脚本、不加载图片，所以净化可以先跑完，
   * 等 `appendChild` 搬进文档时，`onerror` 这类钩子已经不在了。
   */
  const template = document.createElement('template')
  template.innerHTML = payload.html
  sanitize(template.content)
  stage.appendChild(template.content)
  host.appendChild(stage)
  outer.appendChild(host)

  document.body.appendChild(outer)
  try {
    return await toBlob(host, {
      width,
      height,
      pixelRatio,
      backgroundColor: backgroundColorOf(payload),
      // 快照把字体内联成 data:，不内联也不会缺字（回退到系统字体）；内联反而要
      // 走一遍 fetch，失败会把整张图拖下水。
      skipFonts: true,
      cacheBust: false,
      imagePlaceholder: IMAGE_PLACEHOLDER,
      filter: (node) => !(node instanceof HTMLScriptElement),
    })
  } finally {
    outer.remove()
  }
}

export function createIframeAdapter(deps: IframeAdapterDeps): CaptureAdapter {
  return {
    async capture(root, box): Promise<CaptureFrame | null> {
      if (deps.bridgeVersion() < 4) throw new StaleBridgeError()
      const payload = await deps.request()
      if (payload === null) return null

      const dpr = Math.min(payload.dpr > 0 ? payload.dpr : window.devicePixelRatio || 1, 2)
      const width = box.width
      const height = box.height
      const png = await rasterize(payload, width, height, dpr)
      if (png === null) return null

      const frame = deps.frame()
      const frameBox = frame?.getBoundingClientRect() ?? null
      const origin = frameBox === null
        ? { left: 0, top: 0 }
        : { left: frameBox.left - box.left, top: frameBox.top - box.top }

      return {
        png,
        cssWidth: width,
        cssHeight: height,
        dpr,
        origin,
        // 桥接脚本上报的是相对 iframe 视口的坐标，这里统一换算到正文容器。
        boxes: payload.boxes.map((item) => ({
          text: item.text,
          rect: {
            left: item.left - origin.left,
            top: item.top - origin.top,
            width: item.width,
            height: item.height,
          },
        })),
        headings: payload.headings.map((item) => ({
          title: item.title,
          depth: 0,
          rect: {
            left: item.left - origin.left,
            top: item.top - origin.top,
            width: item.width,
            height: item.height,
          },
        })),
        pages: [],
      }
    },
  }
}
