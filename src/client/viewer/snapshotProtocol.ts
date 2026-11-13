/**
 * 快照 iframe 与父页面之间的消息协议。
 *
 * 子文档的 origin 是 opaque（sandbox 不给 `allow-same-origin`），所以：
 *   - 父 → 子必须 `targetOrigin: '*'`；
 *   - 父页面**不能**用 `event.origin` 校验（值是字符串 `"null"`），只能比较
 *     `event.source === iframe.contentWindow`。
 *
 * 子 → 父**没有**写入口：iframe 只上报「选区快照」，真正落库必须由用户在父页面
 * 点色块触发。这样快照里的脚本即使伪造消息，也最多伪造一个选区。
 */

export const SNAPSHOT_CHANNEL = 'dsh-zotero/snapshot'
export const SNAPSHOT_VERSION = 1

/**
 * 桥接脚本的契约版本，随 `ready` 上报。
 *
 * 父页面据此判断「iframe 里跑的是不是新版脚本」：Host 若把脚本缓存在内存里，
 * 改了脚本但没重启 DSH 就会拿到旧的一份——旧脚本不带点击矩形，编辑卡片只能
 * 退化成居中显示，界面上要明说，别让用户以为卡片位置是坏的。
 *
 * 2：`annotation-click` 携带 `rect`（点击位置）。
 * 3：上报网页标题目录 `outline`，并能响应 `scroll-to-outline`。
 * 4：响应 `capture`，把整页序列化成自包含 HTML + CSS 回传（截图用）。
 */
export const SNAPSHOT_BRIDGE_VERSION = 4

/** 桥接脚本响应 `capture` 时回传的自包含页面快照。 */
export interface SnapshotCapturePayload {
  /** `<body>` 的 innerHTML，脚本 / 样式 / 外链样式表已剔除。 */
  html: string
  /** 页面自己的样式表**原文**（内联 `<style>` 原样取 textContent），与 `html` 一起在父页面重建。 */
  css: string
  /** `<body>` 的关键计算样式（字体、颜色、底色），重建时套到容器上。 */
  bodyStyle: string
  /**
   * `<html>` / `<body>` 上的属性（`style` 除外）。
   *
   * 重建时会新建一对空的 `html` / `body`，属性得显式搬过去。`class` 最要紧：
   * 站点常把 `mac` / `dark` / `home` 挂在这里，整组样式分支都靠它切换，丢了
   * 就会变成浅色主题、快捷键提示从 ⌘ 变 Ctrl。
   */
  htmlAttrs?: Array<[string, string]>
  bodyAttrs?: Array<[string, string]>
  /** iframe 视口尺寸（CSS 像素）。 */
  width: number
  height: number
  /**
   * 重建内容的宽度。
   *
   * 页面整体滚动时等于 `width`；滚动发生在内部容器时，等于那个容器的
   * `clientWidth`（内容按它自己的宽度排版，不是按视口）。
   */
  stageWidth: number
  scrollLeft: number
  scrollTop: number
  /**
   * 内容原点的位置：页面整体滚动时是 `0,0`，内部容器滚动时是该容器相对
   * iframe 视口的左上角。父页面据此把内容摆回它原来在页面里的位置。
   */
  offsetLeft: number
  offsetTop: number
  dpr: number
  /** 文字盒（相对 iframe 视口），用于生成区域文字摘要。 */
  boxes: SnapshotTextBox[]
  /** 标题盒（相对 iframe 视口），用于反查最近章节。 */
  headings: SnapshotHeadingBox[]
}

export interface SnapshotTextBox {
  text: string
  left: number
  top: number
  width: number
  height: number
}

export interface SnapshotHeadingBox {
  title: string
  left: number
  top: number
  width: number
  height: number
}

/** iframe 侧的一条标注（只带渲染高亮需要的最小字段）。 */
export interface SnapshotAnnotationItem {
  key: string
  type: string
  color: string
  text: string
  webPosition: { selector: string; start: number; end: number }
}

/** iframe 里的一条网页标题（h1–h6 拍平后的层级由 `depth` 表示）。 */
export interface SnapshotOutlineItem {
  title: string
  /** 0 起；以页面里最小的标题级别为 0，见 `outline.ts` 的 headingDepths。 */
  depth: number
  /** 桥接脚本给标题元素打的锚点序号（`data-dsh-zotero-outline`）。 */
  id: string
}

/** 父页面 → iframe。 */
export type SnapshotCommand =
  | { type: 'annotations'; items: SnapshotAnnotationItem[] }
  | { type: 'locate'; key: string }
  | { type: 'clear-selection' }
  | { type: 'scroll-to-outline'; id: string }
  /** 截图：把整页序列化回传（不传送位图，栅格化在父页面做）。 */
  | { type: 'capture' }

/** 相对 iframe 视口的矩形。 */
export interface SnapshotRect {
  left: number
  top: number
  width: number
  height: number
}

/** 用户在快照里划出的一段选区，已全部转成纯数据。 */
export interface SnapshotSelection {
  text: string
  selector: string
  start: number
  end: number
  /** 7 位零填充的排序键（近似值，见 runtime.js）。 */
  sortIndex: string
  /** 相对 iframe 视口的矩形，父页面据此摆浮条。 */
  rect: SnapshotRect
}

/** iframe → 父页面。 */
export type SnapshotEvent =
  /** `bridge` 缺省视为 1（没有这个字段的老脚本）。 */
  | { type: 'ready'; bridge?: number }
  | { type: 'outline'; items: SnapshotOutlineItem[] }
  | { type: 'applied'; total: number; resolved: number; rev: number; error?: string | null }
  | { type: 'selection'; selection: SnapshotSelection | null }
  | { type: 'locate-result'; key: string; ok: boolean }
  /**
   * 点了网页里的一段高亮。`rect` 是被点元素相对 iframe 视口的矩形，父页面据此
   * 摆编辑卡片；老版本桥接脚本不带它，所以按可选处理。
   */
  | { type: 'annotation-click'; key: string; rect?: SnapshotRect }
  /**
   * 网页正文里按下指针。父页面的 `document` 监听不到 iframe 内部的事件，
   * 收到这条就交给 `notifyDocumentPress()`（见 `dismiss.ts`），让打开着的浮层
   * 与父页面里的点击走同一套「点别处就收起」。
   */
  | { type: 'pointerdown' }
  | { type: 'open-external'; href: string }
  /**
   * `capture` 的结果。为什么不在这里出位图：iframe 的 origin 是 opaque，
   * `blob:` 图像画进 canvas 会 taint（实测 `SecurityError`），而 `data:` SVG
   * 在 iframe 内栅格化又要另装一份序列化器。改成只回传 HTML + CSS，
   * 由父页面用已经跑通的 html-to-image 出图，两条路径共用同一套保真度。
   */
  | { type: 'capture-result'; payload: SnapshotCapturePayload }
  | { type: 'capture-failed'; message: string }

const EVENT_TYPES = new Set([
  'ready',
  'outline',
  'applied',
  'selection',
  'locate-result',
  'annotation-click',
  'pointerdown',
  'open-external',
  'capture-result',
  'capture-failed',
])

/** 给父页面用：把 `MessageEvent.data` 收窄成 {@link SnapshotEvent}。 */
export function asSnapshotEvent(data: unknown): SnapshotEvent | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as { s?: unknown; v?: unknown; type?: unknown }
  if (record.s !== SNAPSHOT_CHANNEL || record.v !== SNAPSHOT_VERSION) return null
  if (typeof record.type !== 'string' || !EVENT_TYPES.has(record.type)) return null
  return data as SnapshotEvent
}

/** 父页面发给 iframe 的信封。 */
export function commandEnvelope(command: SnapshotCommand): Record<string, unknown> {
  return { s: SNAPSHOT_CHANNEL, v: SNAPSHOT_VERSION, ...command }
}
