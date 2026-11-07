/**
 * 高亮 / 下划线的写操作：新建、改色、改评论、换类型、改页码、改标签、删除。
 *
 * 四条规矩各有出处：
 *
 * 0. **新建的内容由客户端算，Host 只校验**。位置（`annotationPosition`）与排序键
 *    （`annotationSortIndex`）离不开 pdf.js 的 viewport 与文本层，Host 拿不到；这里
 *    逐字段核对形状，越界一律抛错而不是替他补一个「看起来对」的值。
 * 1. **只发 PATCH，且只发改动的那几个字段**。PUT 会把 `data` 里未提交的既有字段静默
 *    移除；实测（本机 Zotero 10.0.7）单字段 PATCH 不会冲掉 `annotationText` /
 *    `annotationPosition` / `annotationSortIndex`，所以按字段提交既安全又省流量。
 *    `tags` 是唯一例外：PATCH 对数组是**整表替换**，因此要改标签必须把全表发来。
 * 2. **只碰 highlight 与 underline**。截图、墨迹、文本框这几类的 `position` 结构不同，
 *    本插件不渲染也不重建，改错了在 Zotero 里也难复原，故一律只读（面板不给入口，
 *    这里再挡一次，模型工具同受约束）。
 * 3. **并发前置条件用调用方给的版本**。写前确实会读一次现状（为了核对类型），但拿
 *    那个新版本去写等于覆盖 Zotero 侧刚发生的改动，因此只读不采信。
 */

import { getAnnotationHost, getAnnotationState, ZoteroError } from './client.js'
import { createItems, deleteItem, patchItem } from './write.js'
import { isPaletteColor } from './palette.js'
import type { ZoteroAnnotationPatch, ZoteroTagRef } from './types.js'

/** 本插件可写、且可在两者之间互转的标注类型。 */
const EDITABLE_TYPES = new Set(['highlight', 'underline'])

/** 各类型的展示名，用于错误文案（用户看得懂「墨迹」，看不懂 `ink`）。 */
const TYPE_NAMES: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  note: '笔记式标注',
  text: '文本框',
  image: '截图',
  ink: '墨迹',
}

/** 评论的字节上限：Zotero 侧没有硬限，这里防的是误把整段论文贴进来。 */
const COMMENT_MAX_BYTES = 16 * 1024

/** 页码标签的字符上限（Zotero 给的是「印刷页码」串，通常三五个字符）。 */
const PAGE_LABEL_MAX = 24

const TAG_MAX_COUNT = 20
const TAG_MAX_LENGTH = 60

/** `patch` 认识的字段名。 */
const PATCH_FIELDS = new Set(['color', 'comment', 'type', 'pageLabel', 'tags'])

function readStringField(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  if (typeof value !== 'string') {
    throw new ZoteroError('bad_request', `patch 里的 ${name} 必须是字符串。`)
  }
  return value
}

/** 面板传来的标签表：元素形状来自 JSON，不可信，逐项核。 */
function readTags(value: unknown): ZoteroTagRef[] {
  if (!Array.isArray(value)) throw new ZoteroError('bad_request', 'patch 里的 tags 必须是数组。')
  if (value.length > TAG_MAX_COUNT) {
    throw new ZoteroError('bad_request', `一条标注最多带 ${TAG_MAX_COUNT} 个标签，现在给了 ${value.length} 个。`)
  }
  return value.map((item) => {
    const tag = typeof (item as { tag?: unknown } | null)?.tag === 'string' ? (item as { tag: string }).tag : ''
    return { tag, type: 1 }
  })
}

/** 把外部传来的 `patch` 收成结构化字段；不认识或不合规的键一律报错而不是静默忽略。 */
function readPatch(value: unknown): ZoteroAnnotationPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZoteroError('bad_request', 'patch 必须是对象，例如 `{ "color": "#ffd400" }`。')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!PATCH_FIELDS.has(key)) {
      throw new ZoteroError('bad_request', `patch 里的「${key}」不能改，可改的只有 color / comment / type / pageLabel / tags。`)
    }
  }
  const patch: ZoteroAnnotationPatch = {}
  if (record.color !== undefined) patch.color = readStringField(record, 'color')
  if (record.comment !== undefined) patch.comment = readStringField(record, 'comment')
  if (record.type !== undefined) patch.type = readStringField(record, 'type')
  if (record.pageLabel !== undefined) patch.pageLabel = readStringField(record, 'pageLabel')
  if (record.tags !== undefined) patch.tags = readTags(record.tags)
  return patch
}

/**
 * 语义校验 + 翻译成 Zotero 的字段名。
 *
 * 空串对 `color` / `type` 没有意义（那是「没选颜色」「没类型」，Zotero 自己不会这么存），
 * 但对 `comment` 与 `pageLabel` 是合法意图：清除。
 */
function toZoteroFields(patch: ZoteroAnnotationPatch): Record<string, unknown> {
  const fields: Record<string, unknown> = {}

  if (patch.color !== undefined) {
    if (!isPaletteColor(patch.color)) {
      throw new ZoteroError('bad_request', `「${patch.color.trim()}」不是 Zotero 的标注颜色，请从色块里选。`)
    }
    fields.annotationColor = patch.color.trim().toLowerCase()
  }

  if (patch.comment !== undefined) {
    const comment = patch.comment.replace(/\r\n?/gu, '\n')
    const bytes = Buffer.byteLength(comment, 'utf8')
    if (bytes > COMMENT_MAX_BYTES) {
      throw new ZoteroError('bad_request', `评论约 ${Math.round(bytes / 1024)} KB，超出 ${COMMENT_MAX_BYTES / 1024} KB 上限，请精简。`)
    }
    fields.annotationComment = comment
  }

  if (patch.type !== undefined) {
    if (!EDITABLE_TYPES.has(patch.type)) {
      throw new ZoteroError('bad_request', '标注类型只能在高亮与下划线之间切换。')
    }
    fields.annotationType = patch.type
  }

  if (patch.pageLabel !== undefined) {
    const label = patch.pageLabel.trim()
    if (label.length > PAGE_LABEL_MAX) {
      throw new ZoteroError('bad_request', `页码标签最多 ${PAGE_LABEL_MAX} 个字符。`)
    }
    // 页码标签会显示在列表与 PDF 叠加层里，换行和控制字符会把版面顶开。
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(label)) {
      throw new ZoteroError('bad_request', '页码标签里不能有换行或控制字符。')
    }
    fields.annotationPageLabel = label
  }

  if (patch.tags !== undefined) fields.tags = normalizeTags(patch.tags)

  if (Object.keys(fields).length === 0) {
    throw new ZoteroError('bad_request', 'patch 是空的：没有要改的内容。')
  }
  return fields
}

/**
 * 标签整表归一：去空白、去重、限长。
 *
 * `type` 一律给 1（手动标签）：0 是 Zotero 从附件里自动抽的，插件不该「造」自动标签。
 */
function normalizeTags(tags: ZoteroTagRef[]): { tag: string; type: number }[] {
  const out: { tag: string; type: number }[] = []
  for (const item of tags) {
    const tag = item.tag.trim()
    if (tag === '') continue
    if (tag.length > TAG_MAX_LENGTH) {
      throw new ZoteroError('bad_request', `标签「${tag.slice(0, 12)}…」有 ${tag.length} 字，单个标签最多 ${TAG_MAX_LENGTH} 字。`)
    }
    if (!out.some((existing) => existing.tag === tag)) out.push({ tag, type: 1 })
  }
  return out
}

/** 类型闸门：只允许改/删高亮与下划线。 */
function assertEditable(type: string, action: string): void {
  if (EDITABLE_TYPES.has(type)) return
  const name = TYPE_NAMES[type] ?? type
  throw new ZoteroError(
    'bad_request',
    `本插件只改高亮与下划线，这条是「${name}」；要${action}它请在 Zotero 里操作。`,
  )
}

/**
 * 局部更新一条标注。
 *
 * `patch` 声明成 `unknown`：它可能来自面板，也可能来自模型工具，两条路都必须经过
 * 这里的同一套校验。
 */
export async function patchAnnotation(input: { key: string; version: number; patch: unknown }): Promise<void> {
  const fields = toZoteroFields(readPatch(input.patch))
  const state = await getAnnotationState(input.key)
  assertEditable(state.type, '修改')
  await patchItem(input.key, fields, input.version)
}

/** 删除一条标注。**硬删**，不进 Zotero 回收站，撤销不了。 */
export async function deleteAnnotation(input: { key: string; version: number }): Promise<void> {
  const state = await getAnnotationState(input.key)
  assertEditable(state.type, '删除')
  await deleteItem(input.key, input.version)
}

// ---- 新建 -------------------------------------------------------------------

/** 一次请求最多的条数：跨页选区一页一条，正常操作远达不到。 */
const CREATE_MAX_COUNT = 24

/** 原文长度上限（与客户端的截断值同一量级，挡的是误传整篇）。 */
const TEXT_MAX_CHARS = 20_000

/** 矩形数量与坐标量级：PDF 用户空间里正常页宽几千 pt，超出即畸形数据。 */
const RECT_MAX_COUNT = 512
const COORD_MAX = 1_000_000

/** `00001|000220|00179` —— Zotero 阅读器生成的形态，见 `annotationFactory.ts`。 */
const SORT_INDEX_PATTERN = /^\d{5}\|\d{6}\|\d{5}$/u

/** Zotero 侧标注字段的名前缀，出错文案里直接用它。 */
const DRAFT_FIELDS = new Set([
  'annotationType',
  'annotationText',
  'annotationColor',
  'annotationPageLabel',
  'annotationSortIndex',
  'annotationComment',
  'position',
])

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new ZoteroError('bad_request', `标注里的「${name}」必须是字符串。`)
  }
  return value
}

/**
 * 校验位置并序列化回 Zotero 的 `annotationPosition`。
 *
 * 数值重新按 3 位小数收敛一次：客户端已经这么做了，这里兜住模型工具那种直接手填
 * 坐标的调用，保证库里不会出现 `239.13900000000001` 那种噪声。
 */
function toPositionField(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZoteroError('bad_request', '标注的「position」必须是 `{ pageIndex, rects }` 对象。')
  }
  const record = value as Record<string, unknown>
  const pageIndex = record.pageIndex
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 100_000) {
    throw new ZoteroError('bad_request', '标注的「position.pageIndex」得是从 0 开始的页号。')
  }
  if (!Array.isArray(record.rects) || record.rects.length === 0) {
    throw new ZoteroError('bad_request', '标注的「position.rects」至少要有 1 个矩形。')
  }
  if (record.rects.length > RECT_MAX_COUNT) {
    throw new ZoteroError('bad_request', `一段选区最多 ${RECT_MAX_COUNT} 个矩形，这个选区太碎了。`)
  }
  const rects = record.rects.map((source) => {
    if (!Array.isArray(source) || source.length !== 4) {
      throw new ZoteroError('bad_request', '每个矩形都是 `[x1, y1, x2, y2]` 四个数。')
    }
    return source.map((coordinate) => {
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || Math.abs(coordinate) > COORD_MAX) {
        throw new ZoteroError('bad_request', '矩形坐标必须是 PDF 用户空间里的有限数值。')
      }
      return Math.round(coordinate * 1e3) / 1e3
    })
  })
  return JSON.stringify({ pageIndex, rects })
}

/**
 * 一条待写标注 → Zotero 的 annotation 条目。
 *
 * 越界与畸形字段一律抛错：这一份数据会原样进用户的库，静默修正是把脏东西写进去。
 */
function toAnnotationObject(parentItem: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZoteroError('bad_request', '每条标注都必须是对象。')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!DRAFT_FIELDS.has(key)) {
      throw new ZoteroError('bad_request', `标注里的「${key}」不是本插件认识的字段。`)
    }
  }

  const type = readString(record.annotationType, 'annotationType')
  if (!EDITABLE_TYPES.has(type)) {
    throw new ZoteroError('bad_request', '本插件只新建高亮与下划线。')
  }

  const text = record.annotationText
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ZoteroError('bad_request', '标注要有选中原文。')
  }
  if (text.length > TEXT_MAX_CHARS) {
    throw new ZoteroError('bad_request', `原文有 ${text.length} 字，超出 ${TEXT_MAX_CHARS} 字上限。`)
  }

  const color = readString(record.annotationColor, 'annotationColor')
  if (!isPaletteColor(color)) {
    throw new ZoteroError('bad_request', `「${color.trim()}」不是 Zotero 的标注颜色，请用色板里的值。`)
  }

  const sortIndex = readString(record.annotationSortIndex, 'annotationSortIndex')
  if (!SORT_INDEX_PATTERN.test(sortIndex.trim())) {
    throw new ZoteroError('bad_request', '排序键形状不对，应为 `00001|000220|00179` 这样的三段。')
  }

  const label = readString(record.annotationPageLabel, 'annotationPageLabel').trim()
  if (label.length > PAGE_LABEL_MAX) {
    throw new ZoteroError('bad_request', `页码标签最多 ${PAGE_LABEL_MAX} 个字符。`)
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(label)) {
    throw new ZoteroError('bad_request', '页码标签里不能有换行或控制字符。')
  }

  const comment = record.annotationComment === undefined ? '' : readString(record.annotationComment, 'annotationComment')
  const bytes = Buffer.byteLength(comment, 'utf8')
  if (bytes > COMMENT_MAX_BYTES) {
    throw new ZoteroError('bad_request', `评论约 ${Math.round(bytes / 1024)} KB，超出 ${COMMENT_MAX_BYTES / 1024} KB 上限。`)
  }

  return {
    itemType: 'annotation',
    parentItem,
    annotationType: type,
    annotationText: text,
    annotationColor: color.trim().toLowerCase(),
    annotationComment: comment,
    annotationPageLabel: label,
    annotationSortIndex: sortIndex.trim(),
    annotationPosition: toPositionField(record.position),
  }
}

/**
 * 在某个附件下新建标注（一次选区跨页时会有多条）。
 *
 * 单个 `POST /items` 数组体提交全部：一次授权可能被首个写请求消耗掉，把用户的这一个
 * 动作压成一次往返，才不会建了一半就断。
 */
export async function createAnnotations(input: {
  parentItem: string
  annotations: unknown
}): Promise<{ key: string; version: number | null }[]> {
  if (!Array.isArray(input.annotations)) {
    throw new ZoteroError('bad_request', 'annotations 必须是数组，哪怕只建一条也要写成 `[{ … }]`。')
  }
  if (input.annotations.length === 0) {
    throw new ZoteroError('bad_request', 'annotations 至少要有 1 条。')
  }
  if (input.annotations.length > CREATE_MAX_COUNT) {
    throw new ZoteroError('bad_request', `一次最多新建 ${CREATE_MAX_COUNT} 条标注，现在给了 ${input.annotations.length} 条。`)
  }
  const objects = input.annotations.map((item) => toAnnotationObject(input.parentItem, item))

  const host = await getAnnotationHost(input.parentItem)
  if (host.itemType !== 'attachment') {
    throw new ZoteroError(
      'bad_request',
      `标注要挂在 PDF 附件上，「${host.key}」是${host.itemType === '' ? '不存在的条目' : `「${host.itemType}」`}。请选附件那一层，或直接在 PDF 阅读区里划选。`,
    )
  }
  if (!/pdf/iu.test(host.contentType)) {
    throw new ZoteroError('bad_request', `附件「${host.title || host.key}」不是 PDF，Zotero 不给它建标注。`)
  }

  return createItems(objects)
}
