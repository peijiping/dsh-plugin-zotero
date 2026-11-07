/**
 * Client 侧调 Host 端点（同源 fetch，前缀见 config.ROUTE_PREFIX）。
 *
 * 响应信封由 Host 产出：`{ok:true,data}` / `{ok:false,error}`。
 */

import type {
  ZoteroAnnotationDraft,
  ZoteroAnnotationPatch,
  ZoteroAuthResult,
  ZoteroHealth,
  ZoteroItemDetail,
  ZoteroItemScope,
  ZoteroItems,
  ZoteroNoteRaw,
  ZoteroTags,
  ZoteroTree,
  ZoteroWriteRef,
  ZoteroWriteStatus,
} from '../zotero/types'

const BASE = '/dsh-zotero/api'

/** 写端点的自定义头名（与 `src/zotero/config.ts` 的 WRITE_HEADER 同步）。 */
const WRITE_HEADER = 'x-dsh-zotero-write'

/** Host 返回的错误，携带 §6 的错误码。 */
export class ApiFailure extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
  }
}

type QueryValue = string | number | readonly string[] | undefined
type Query = Record<string, QueryValue>

function buildUrl(action: string, query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== '') params.append(key, item)
      }
    } else {
      params.set(key, String(value))
    }
  }
  const search = params.toString()
  return `${BASE}/${action}${search === '' ? '' : `?${search}`}`
}

async function readEnvelope<T>(res: Response): Promise<T> {
  const payload = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
    | null
  if (payload === null) throw new ApiFailure('internal_error', `Host 返回了非 JSON 响应（HTTP ${res.status}）`)
  if (!payload.ok) throw new ApiFailure(payload.error.code, payload.error.message)
  return payload.data
}

async function get<T>(action: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(buildUrl(action, query), { signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure('network_error', `无法访问 Host 端点：${message}`)
  }
  return readEnvelope<T>(res)
}

/**
 * 打写端点。
 *
 * Host 对写请求同时要求 JSON content-type 和自定义头，缺一个就 403 —— 这两样
 * 也正是「本插件的界面在操作」的证明，跨源网页凑不出来（要先过 CORS 预检）。
 */
async function post<T>(action: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(buildUrl(action), {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WRITE_HEADER]: '1' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure('network_error', `无法访问 Host 端点：${message}`)
  }
  return readEnvelope<T>(res)
}

export function fetchHealth(): Promise<ZoteroHealth> {
  return get<ZoteroHealth>('health')
}

export function fetchTree(signal?: AbortSignal): Promise<ZoteroTree> {
  return get<ZoteroTree>('tree', {}, signal)
}

export function fetchItems(
  query: {
    scope?: ZoteroItemScope
    collectionKey?: string
    q?: string
    tags?: readonly string[]
    tagMode?: 'all' | 'any'
    limit?: number
    offset?: number
  } = {},
  signal?: AbortSignal,
): Promise<ZoteroItems> {
  const { tags, ...rest } = query
  // Host 侧标签参数名是 `tag`（AND 靠重复出现，OR 由 Host 拼成 `A || B`）。
  return get<ZoteroItems>('items', { ...rest, ...(tags === undefined ? {} : { tag: tags }) }, signal)
}

export function fetchTags(signal?: AbortSignal): Promise<ZoteroTags> {
  return get<ZoteroTags>('tags', {}, signal)
}

/** 当前范围（分类子树 / 虚拟分类 + 搜索词）内的标签用量。 */
export function fetchTagUsage(
  query: {
    scope?: ZoteroItemScope
    collectionKeys?: readonly string[]
    q?: string
  } = {},
  signal?: AbortSignal,
): Promise<ZoteroTags> {
  const { collectionKeys, ...rest } = query
  // Host 侧参数名是 `collectionKey`（子树靠重复出现传多个 key）。
  return get<ZoteroTags>(
    'tag-usage',
    { ...rest, ...(collectionKeys === undefined ? {} : { collectionKey: collectionKeys }) },
    signal,
  )
}

export function fetchItem(key: string, style = 'apa', signal?: AbortSignal): Promise<ZoteroItemDetail> {
  return get<ZoteroItemDetail>('item', { key, style }, signal)
}

/** 附件文件地址；直接交给 PDF.js / Word 渲染器按 Range 取流。 */
export function fileUrl(key: string): string {
  return buildUrl('file', { key })
}

/** 用系统 Zotero 打开条目或附件页。 */
export async function openInZotero(
  input: { key: string; kind: 'item' | 'attachment'; page?: number },
): Promise<void> {
  await post<{ opened: boolean }>('open-in-zotero', input)
}

/** 写通道当前状态（开关 + 内存里有没有 key）。 */
export function fetchWriteStatus(signal?: AbortSignal): Promise<ZoteroWriteStatus> {
  return get<ZoteroWriteStatus>('auth-status', {}, signal)
}

/**
 * 申请 Zotero 写权限。
 *
 * Zotero 会弹框并**挂住本请求直到用户点按钮**，调用方须在等待期间禁用按钮：
 * 重复触发会撞上 Zotero 每分钟 5 次的授权限流。
 */
export function authorizeWrites(signal?: AbortSignal): Promise<ZoteroAuthResult> {
  return post<ZoteroAuthResult>('authorize', {})
}

// ---- 笔记 -------------------------------------------------------------------

/**
 * 笔记的原始 HTML（未清洗、未截断），编辑器的初始值。
 *
 * 详情里那份 `note.html` 是展示用的：属性被剥过、超长被切过，拿它回写等于毁数据。
 */
export function fetchNoteRaw(key: string, signal?: AbortSignal): Promise<ZoteroNoteRaw> {
  return get<ZoteroNoteRaw>('note-raw', { key }, signal)
}

/** 在 `parentItem` 下新建一条笔记；`note` 是 HTML。 */
export function createNote(input: { parentItem: string; note: string }): Promise<ZoteroWriteRef> {
  return post<ZoteroWriteRef>('note-create', input)
}

/** 替换笔记正文。`version` 必须是面板里那条笔记当前的版本，否则 Host 会报「已被改动」。 */
export function updateNote(input: { key: string; version: number; note: string }): Promise<ZoteroWriteRef> {
  return post<ZoteroWriteRef>('note-update', input)
}

/** 删除笔记。硬删，不进回收站。 */
export function deleteNote(input: { key: string; version: number }): Promise<ZoteroWriteRef> {
  return post<ZoteroWriteRef>('note-delete', input)
}

// ---- 标注 -------------------------------------------------------------------

/**
 * 局部改一条标注（色 / 评论 / 高亮↔划线 / 页码 / 标签）。
 *
 * 只发想改的字段，Host 按字段 PATCH；标签是整表替换，所以要给全表。
 */
export function patchAnnotation(input: {
  key: string
  version: number
  patch: ZoteroAnnotationPatch
}): Promise<ZoteroWriteRef> {
  return post<ZoteroWriteRef>('annotation-patch', input)
}

/** 删除标注。硬删，不进回收站。 */
export function deleteAnnotation(input: { key: string; version: number }): Promise<ZoteroWriteRef> {
  return post<ZoteroWriteRef>('annotation-delete', input)
}

/**
 * 在附件下新建标注（选区跨页时一次多条）。
 *
 * 单请求批量：一次授权可能被首个写请求消耗掉，逐条发会在中途失去写权限。
 */
export function createAnnotations(input: {
  parentItem: string
  annotations: ZoteroAnnotationDraft[]
}): Promise<ZoteroWriteRef[]> {
  return post<ZoteroWriteRef[]>('annotation-create', input)
}
