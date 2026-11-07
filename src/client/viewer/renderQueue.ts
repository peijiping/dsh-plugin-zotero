/**
 * PDF 渲染节奏控制。
 *
 * 两件事：
 *
 * 1. **串行**：pdf.js 把一个画布的绘制切成很多片，多页同时开画时一帧里会叠加
 *    好几个分片。这里统一排队，同一时刻只让一页绘制，先画离当前阅读页最近的。
 * 2. **让路**：pdf.js 每个分片的预算写死为 `EXECUTION_TIME = 15ms`
 *    （见 `pdf.mjs` 的 `executeOperatorList`），而 120Hz 屏幕一帧只有 8.3ms、
 *    60Hz 也只有 16.7ms —— 只要有一页在画，那几帧就必然被挤掉，滚动看起来就是
 *    「一顿一顿」。所以分片之间的间隔改由 {@link paceChunk} 决定（走官方的
 *    `RenderTask.onContinue` 接缝）：滚动中远处的页直接等停手，近处的页也隔帧再画。
 *
 * 文本层、选区框校正这些副产品等滚动停稳再做（{@link waitForScrollIdle}）。
 */

export interface RenderJob {
  /** 越小越先渲染。 */
  priority(): number
  /**
   * 返回 `false` 表示「此刻不该画」（例如滚动中的远处页）。
   *
   * 队列会跳过它先把别人画掉，隔一会儿再问；**不能**在 `start()` 里干等 ——
   * 串行队列的槽位会被一直占着，眼前那页反而画不出来。
   */
  ready?(): boolean
  /** 开始渲染；无论成功、失败还是被取消，返回的 Promise 都必须 resolve。 */
  start(): Promise<void>
}

const queue: RenderJob[] = []
let running = false
let retryTimer: number | null = null
/** 整队都被推迟时的重试间隔。 */
const RETRY_MS = 60

function scheduleRetry(): void {
  if (retryTimer !== null) return
  retryTimer = window.setTimeout(() => {
    retryTimer = null
    pump()
  }, RETRY_MS)
}

function pump(): void {
  if (running) return
  let index = -1
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < queue.length; i += 1) {
    const job = queue[i]!
    if (job.ready !== undefined && !job.ready()) continue
    const value = job.priority()
    if (value < best) {
      best = value
      index = i
    }
  }
  if (index < 0) {
    if (queue.length > 0) scheduleRetry()
    return
  }
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

/** 最近一次滚动的时间戳；负无穷表示这次会话还没滚过。 */
let lastScrollAt = Number.NEGATIVE_INFINITY

/** 停手多久算「不滚了」。 */
export const SCROLL_IDLE_MS = 150
const POLL_MS = 50
/** 滚动中每画一片，先空出的帧数。 */
const CHUNK_GAP_FRAMES = 1

/**
 * 滚动中仍然可以接着画的优先级上限。
 *
 * 优先级是「与当前阅读页的页号差」，0~2 基本就是屏幕里看得见、或者再滚一下就
 * 会露出来的那几页。比这更远的页（预渲染余量里的远处页）在滚动期间一律让路：
 * 拿滚动的帧去换还没人看的内容不划算，滚完往往它也出范围了。
 */
export const SCROLL_NEAR_PRIORITY = 2

/** 滚动事件里调用；文本层等非必要工作会等它停下来再做。 */
export function markScrollActivity(): void {
  lastScrollAt = performance.now()
}

/** 距上次滚动的毫秒数。 */
export function scrollIdleFor(): number {
  return performance.now() - lastScrollAt
}

/** 等滚动停止 `ms` 毫秒后 resolve；调用方自己用取消标记丢弃过期结果。 */
export function waitForScrollIdle(ms = SCROLL_IDLE_MS): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      const remaining = ms - (performance.now() - lastScrollAt)
      if (remaining <= 0) resolve()
      else window.setTimeout(check, Math.min(remaining, POLL_MS))
    }
    check()
  })
}

function afterFrames(frames: number, run: () => void): void {
  if (frames <= 0) {
    run()
    return
  }
  window.requestAnimationFrame(() => afterFrames(frames - 1, run))
}

/** 远处的页在滚动中最多干等这么久；真的一直在滚，就退化成慢画，别堵住串行队列。 */
const FAR_YIELD_MS = 500
/** 退化之后每画一片先空出的帧数。 */
const FAR_GAP_FRAMES = 2

/**
 * 排下一片绘制（交给 `RenderTask.onContinue`）。
 *
 * - 没在滚动：立刻排，全速画。
 * - 滚动中且是眼前这几页：隔一帧再排，滚动的帧不被 15ms 的分片占满。
 * - 滚动中且是远处的页：等手停下来再排；等太久（`FAR_YIELD_MS`）就退化成隔两帧
 *   画一片 —— 队列是串行的，一直占着槽位会把眼前那页也堵在外面。
 *
 * 无论哪条路都保证最终调用 `next()`，否则 pdf.js 的绘制会永远停在半路。
 */
export function paceChunk(priority: number, next: () => void): void {
  if (scrollIdleFor() >= SCROLL_IDLE_MS) {
    next()
    return
  }
  if (priority <= SCROLL_NEAR_PRIORITY) {
    afterFrames(CHUNK_GAP_FRAMES, next)
    return
  }
  const giveUpWaiting = new Promise<void>((resolve) => {
    window.setTimeout(resolve, FAR_YIELD_MS)
  })
  void Promise.race([waitForScrollIdle(), giveUpWaiting]).then(() => {
    afterFrames(FAR_GAP_FRAMES, next)
  })
}
