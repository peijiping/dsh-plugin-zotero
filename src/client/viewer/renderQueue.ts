/**
 * PDF 渲染串行队列。
 *
 * pdf.js 绘制一页时会在主线程上按帧分片（每帧最多约 15ms）。多页同时开画时，
 * 一帧里会叠加多个分片，滚动就掉帧。这里统一排队，同一时刻只让一页绘制，
 * 并按「离当前页的距离」排序，先画看得见的那页。
 */

export interface RenderJob {
  /** 越小越先渲染。 */
  priority(): number
  /** 开始渲染；无论成功、失败还是被取消，返回的 Promise 都必须 resolve。 */
  start(): Promise<void>
}

const queue: RenderJob[] = []
let running = false

function pump(): void {
  if (running) return
  let index = -1
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < queue.length; i += 1) {
    const value = queue[i]!.priority()
    if (value < best) {
      best = value
      index = i
    }
  }
  if (index < 0) return
  const [job] = queue.splice(index, 1)
  if (job === undefined) return
  running = true
  void job.start()
    .catch(() => undefined)
    .finally(() => {
      running = false
      pump()
    })
}

/** 入队并返回撤销函数（只对尚未开始的渲染有效）。 */
export function enqueueRender(job: RenderJob): () => void {
  queue.push(job)
  pump()
  return () => {
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }
}

let lastScrollAt = Number.NEGATIVE_INFINITY

/** 滚动事件里调用；文本层等非必要工作会等它停下来再做。 */
export function markScrollActivity(): void {
  lastScrollAt = performance.now()
}

const IDLE_MS = 150
const POLL_MS = 50

/** 等滚动停止 `ms` 毫秒后 resolve；调用方自己用取消标记丢弃过期结果。 */
export function waitForScrollIdle(ms = IDLE_MS): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      const remaining = ms - (performance.now() - lastScrollAt)
      if (remaining <= 0) resolve()
      else window.setTimeout(check, Math.min(remaining, POLL_MS))
    }
    check()
  })
}
