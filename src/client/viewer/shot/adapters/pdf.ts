/**
 * PDF 采集适配器：直接读 pdf.js 画好的页 canvas，跨页拼成一张可见区位图。
 *
 * 不走 DOM→图库的理由：页面像素本来就在 canvas 里，`drawImage` 精确无损；
 * 序列化整个 viewer 子树（上千个文本层 span + `mixBlendMode:multiply` 标注层）
 * 既会撞 dataURI 上限，也会把用户自己画的高亮混进「原始版面」。
 *
 * 全部资源同源（`/dsh-zotero/api/file`、`/dsh-zotero/static/`），pdf.js 内嵌图
 * 走 data:/blob:/ImageBitmap，项目里 `crossOrigin` 0 处 → canvas 未污染，`toBlob` 安全。
 */

import type {
  CaptureAdapter,
  CaptureFrame,
  PageBox,
  TextBox,
} from '../types'

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('pdf screenshot encode failed'))
      else resolve(blob)
    }, 'image/png')
  })
}

/** 相对可见区左上角的矩形。 */
function relative(rect: DOMRect, box: DOMRectReadOnly): {
  left: number; top: number; width: number; height: number
} {
  return {
    left: rect.left - box.left,
    top: rect.top - box.top,
    width: rect.width,
    height: rect.height,
  }
}

/** 文本层的 span 用来生成「这一块写了什么」的摘要（不含浮层与按钮）。 */
function collectText(root: HTMLElement, box: DOMRectReadOnly): TextBox[] {
  const boxes: TextBox[] = []
  const hosts = root.querySelectorAll<HTMLElement>('.dsh-zotero-pdf-text')
  for (const host of hosts) {
    for (const node of host.querySelectorAll<HTMLElement>('span, div')) {
      const text = node.textContent ?? ''
      if (text.trim() === '' || node.childElementCount > 0) continue
      const rect = relative(node.getBoundingClientRect(), box)
      if (rect.width <= 0 || rect.height <= 0) continue
      boxes.push({ text, rect })
    }
  }
  boxes.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
  return boxes
}

export function createPdfAdapter(): CaptureAdapter {
  return {
    async capture(root, box): Promise<CaptureFrame | null> {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round(box.width * dpr))
      const height = Math.max(1, Math.round(box.height * dpr))
      // 先收集几何，再建画布：没有任何可见页时不要白白申请一块大内存。
      const pages = root.querySelectorAll<HTMLElement>('[data-zp-page]')
      const sources: {
        canvas: HTMLCanvasElement
        left: number
        top: number
        width: number
        height: number
      }[] = []
      const pageBoxes: PageBox[] = []

      for (const page of pages) {
        const canvas = page.querySelector<HTMLCanvasElement>('.dsh-zotero-pdf-canvas-host canvas')
        if (canvas === null || canvas.width === 0 || canvas.height === 0) continue
        const rect = relative(canvas.getBoundingClientRect(), box)
        if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0
          || rect.left >= box.width || rect.top >= box.height) continue
        sources.push({ canvas, ...rect })
        const number = Number.parseInt(page.getAttribute('data-zp-page') ?? '', 10)
        pageBoxes.push({
          pageNumber: Number.isFinite(number) ? number : pageBoxes.length + 1,
          /**
           * 只用印刷页码（将来渲染器若提供 `data-zp-page-label`）。
           * 别退回 `aria-label`：那是「第 3 页」这类随界面语言变化的 UI 文案，
           * 会让水印出现「P第 3 页-第 4 页」。空串时 `pageRange` 自动退回页序号。
           */
          label: page.getAttribute('data-zp-page-label')?.trim() ?? '',
          rect: relative(page.getBoundingClientRect(), box),
        })
      }
      if (sources.length === 0) return null

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (ctx === null) return null
      // 页面之外的区域留白（PDF 页面本身是白的，深色主题下也不该出现黑底）。
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      for (const source of sources) {
        try {
          ctx.drawImage(
            source.canvas,
            0, 0, source.canvas.width, source.canvas.height,
            source.left * dpr, source.top * dpr, source.width * dpr, source.height * dpr,
          )
        } catch {
          // 单页被污染/已释放时跳过它，别让整次采集失败。
        }
      }
      const png = await toBlob(canvas)
      pageBoxes.sort((a, b) => a.pageNumber - b.pageNumber)
      return {
        png,
        cssWidth: box.width,
        cssHeight: box.height,
        dpr,
        // 整块图按正文容器原点合成，没有内缩。
        origin: { left: 0, top: 0 },
        boxes: collectText(root, box),
        headings: [],
        pages: pageBoxes,
      }
    },
  }
}
