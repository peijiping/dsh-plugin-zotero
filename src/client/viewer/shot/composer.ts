/**
 * 把定格位图裁成选区矩形，并在底部叠一条出处水印。
 *
 * 这是全项目唯一使用 2D canvas 绘制文字的地方：水印让图片即使被单独转发
 * （或用户把输入框里的 chip 删掉）也带着「哪个文献、哪一部分」。
 */

import { MAX_SHOT_PIXELS, WATERMARK_HEIGHT, type CaptureFrame, type ClientRect } from './types'

type Bitmap = HTMLImageElement | ImageBitmap

/** Blob → 可 drawImage 的位图；`createImageBitmap` 不可用时退回 `<img>` + object URL。 */
async function decode(blob: Blob): Promise<{ bitmap: Bitmap; release(): void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return { bitmap, release: () => bitmap.close() }
  }
  const url = URL.createObjectURL(blob)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('screenshot decode failed'))
      image.src = url
    })
    return { bitmap: image, release: () => URL.revokeObjectURL(url) }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

function sizeOf(bitmap: Bitmap): { width: number; height: number } {
  return bitmap instanceof HTMLImageElement
    ? { width: bitmap.naturalWidth, height: bitmap.naturalHeight }
    : { width: bitmap.width, height: bitmap.height }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('screenshot encode failed'))
      else resolve(blob)
    }, 'image/png')
  })
}

/** 按像素上限等比缩小输出尺寸，避免长页面把 canvas 撑爆。 */
function fit(width: number, height: number): { width: number; height: number; scale: number } {
  const pixels = width * height
  if (pixels <= MAX_SHOT_PIXELS) return { width, height, scale: 1 }
  const scale = Math.sqrt(MAX_SHOT_PIXELS / pixels)
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale }
}

/** 超宽水印文字按画布宽度截断成省略号。 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  const chars = Array.from(text)
  let low = 0
  let high = chars.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (ctx.measureText(`${chars.slice(0, mid).join('')}…`).width <= maxWidth) low = mid + 1
    else high = mid
  }
  return `${chars.slice(0, Math.max(0, low - 1)).join('')}…`
}

/**
 * 裁切 + 水印。
 *
 * `rect` 是相对定格位图左上角的 CSS 像素坐标；源位图按 `frame.dpr` 换算。
 * 输出 PNG 保留选区原始像素密度，水印条按 CSS 像素排版（先 scale）。
 */
export async function composeShot(
  frame: CaptureFrame,
  rect: ClientRect,
  watermark: string,
): Promise<Blob> {
  const { bitmap, release } = await decode(frame.png)
  try {
    const source = sizeOf(bitmap)
    const ratio = frame.dpr > 0 ? frame.dpr : 1
    // 框选坐标相对正文容器；位图原点可能内缩（见 `CaptureFrame.origin`），先换算。
    const left = rect.left - frame.origin.left
    const top = rect.top - frame.origin.top
    const srcX = Math.max(0, Math.min(source.width - 1, Math.round(left * ratio)))
    const srcY = Math.max(0, Math.min(source.height - 1, Math.round(top * ratio)))
    const srcW = Math.max(1, Math.min(source.width - srcX, Math.round(rect.width * ratio)))
    const srcH = Math.max(1, Math.min(source.height - srcY, Math.round(rect.height * ratio)))

    const target = fit(srcW, srcH)
    const barHeight = Math.max(1, Math.round(WATERMARK_HEIGHT * ratio * target.scale))
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height + barHeight
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('screenshot canvas unavailable')

    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, 0, 0, target.width, target.height)

    if (watermark !== '') {
      ctx.fillStyle = 'rgba(0,0,0,0.68)'
      ctx.fillRect(0, target.height, target.width, barHeight)
      ctx.save()
      ctx.scale(ratio * target.scale, ratio * target.scale)
      ctx.fillStyle = '#ffffff'
      ctx.font = '12px system-ui, -apple-system, sans-serif'
      ctx.textBaseline = 'middle'
      const maxWidth = Math.max(8, target.width / (ratio * target.scale) - 16)
      ctx.fillText(ellipsize(ctx, watermark, maxWidth), 8, (target.height / (ratio * target.scale)) + WATERMARK_HEIGHT / 2)
      ctx.restore()
    }
    return await toBlob(canvas)
  } finally {
    release()
  }
}
