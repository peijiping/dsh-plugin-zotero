/**
 * 「截图加入对话」的共享类型与常量。
 *
 * 设计要点：上层（controller / overlay / composer / inserter）只认一张 PNG 位图，
 * 不关心底下是 PDF canvas、父 DOM 还是 sandbox iframe；差异全部收在
 * `CaptureAdapter` 里。这样微信式「先定格、再框选、再裁切」的交互对所有文档一致。
 */

/** 相对正文容器可视区的 CSS 像素矩形（左上角为原点）。 */
export interface ClientRect {
  left: number
  top: number
  width: number
  height: number
}

/** 一片可提取文字及其位置，用于生成「截的是哪一部分」的摘要。 */
export interface TextBox {
  text: string
  rect: ClientRect
}

export interface HeadingBox {
  title: string
  rect: ClientRect
  depth: number
}

export interface PageBox {
  /** 1 基页号，与 `[data-zp-page]` 一致。 */
  pageNumber: number
  /** 印刷页码标签（PDF 书签里可能是 `iv` / `S3`）。 */
  label: string
  rect: ClientRect
}

/** 一次采集的产物：整块可见区的位图 + 反查出处用的几何信息。 */
export interface CaptureFrame {
  png: Blob
  /** 位图对应的 CSS 尺寸（= 可见区 box 的宽高）。 */
  cssWidth: number
  cssHeight: number
  /** 位图像素 / CSS 像素，裁切时按它换算源坐标。 */
  dpr: number
  /**
   * 位图左上角相对正文容器左上角的偏移（CSS 像素）。
   *
   * PDF 自己按容器原点合成整块图，恒为 0；纯 DOM 采集以滚动容器为克隆根，
   * 它可能比正文容器向内缩，裁切时要把这段偏移减掉，否则框选会整体错位。
   */
  origin: { left: number; top: number }
  boxes: TextBox[]
  headings: HeadingBox[]
  pages: PageBox[]
}

/** 渲染器声明的采集能力；由 `registry.ts` 给出，按钮不猜 `renderer.id`。 */
export type CaptureKind = 'pdf' | 'dom' | 'iframe' | 'none'

/**
 * 截图此刻不可用的原因。三种情形的修法完全不同，别再一律提示「重启 DSH」：
 *
 * - `not-ready`：桥接脚本还没报到（刚打开快照 / 正在重新加载），等一下即可；
 * - `bridge-missing`：脚本压根没注入（客户端构建产物缺失，或快照过大跳过了注入）。
 *   Host 每次请求读盘、不缓存脚本，补完产物**刷新页面**就好，重启 DSH 没用；
 * - `stale`：脚本确实跑起来了，但版本低于 `SNAPSHOT_BRIDGE_VERSION`，
 *   这才是宿主拿着旧脚本、需要重启 DSH 的情形。
 */
export type CaptureUnavailable = 'not-ready' | 'bridge-missing' | 'stale'

/**
 * 分类型采集适配器。
 *
 * PDF / 纯文本由 `shot/` 自己按正文容器现做；网页快照的那份由 `SnapshotViewer`
 * 提供（它才拿得到 iframe 与消息通道），通过 `DocumentRendererProps.captureRef`
 * 注册进来。
 */
export interface CaptureAdapter {
  capture(root: HTMLElement, box: DOMRectReadOnly): Promise<CaptureFrame | null>
  /**
   * 此刻不可用的**具体原因**；返回 `null` 或方法缺省表示可以采集。
   *
   * 快照用它把「还没加载完 / 脚本没注入 / 脚本版本过旧」分开：按钮置灰并按原因
   * 显示 title，比点下去弹一个笼统的失败提示好。
   */
  unavailable?(): CaptureUnavailable | null
}

/**
 * 一份截图的出处，事实源唯一。
 *
 * 三种载体（图片内水印条 / chip 的可见 label / 提交时展开给模型的文本）都由它派生，
 * 保证「哪个文献、哪一部分」在图片被单独转发时也不丢。
 */
export interface ShotMeta {
  key: string
  title: string
  /** 作者 · 年份 · 出处 · DOI 拼成的一行。 */
  byline: string
  /** `3-4` 这类可本地化的页码串；无页码时为空串。 */
  pages: string
  /** 最近章节标题；无则空串。 */
  section: string
  /** 选区里的文字摘要（已清理、已夹取）；无文字时为空串。 */
  digest: string
  /** 只用于文件名与日志关联，不进模型文本。 */
  shotId: string
}

export type ShotPhase = 'idle' | 'capturing' | 'frozen' | 'selected' | 'inserting'

/**
 * `shot:` ref 的长度上限。
 *
 * 中文经 `encodeURIComponent` 会膨胀约 9 倍，所以按**编码后长度**夹取，
 * 不能用「原文字符数」配 2000 上限——正常中文标题就会误报超限。
 */
export const MAX_SHOT_REF_CHARS = 8000

/** 各段编码后的长度预算，总和留足余量给前缀、分隔符与 shotId。 */
export const SHOT_PART_LIMITS = {
  title: 540,
  byline: 360,
  pages: 90,
  section: 270,
  digest: 540,
} as const

/** 区域文字摘要的最大字符数（按码点算，不是字节）。 */
export const SHOT_DIGEST_CHARS = 160

/** 水印条高度（CSS 像素）。 */
export const WATERMARK_HEIGHT = 26

/** 选区小于这个边长（CSS 像素）视为误点，不进入 selected。 */
export const MIN_SELECTION_SIZE = 12

/** 单张位图的像素上限，避免超长 PDF 可视区把 canvas 撑爆。 */
export const MAX_SHOT_PIXELS = 16_000_000

export function shotFileName(meta: ShotMeta): string {
  return `zotero-${meta.shotId}.png`
}
