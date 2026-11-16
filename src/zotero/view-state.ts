/**
 * 本插件的「视图状态」——**一个文件管三件事**：
 *
 * - `positions`：每篇读到第几页（按附件 key）——左侧栏「最近阅读」也靠它排序；
 * - `sections`：信息浮层六块的开合（全局一份，换哪篇都一样）；
 * - `boxes`：目录 / 信息浮层被拖到哪、拉多大（按条目 key 各一份）。
 *
 * 文件：`<dsh 数据目录>/storages/dsh-plugin-zotero/view-state.json`。
 * 早先这份数据叫 `read-positions.json`，只装阅读进度；功能变多之后换了个贴合
 * 实际内容的文件名，**老文件会在首次读到时就地迁移过来并删除**（内容先落新文件
 * 再删旧文件，中途失败最多留一份旧的，不会丢数据）。
 *
 * 为什么阅读进度不去读 Zotero 那份：
 *
 * 1. 它的位置分散在 `<dataDir>/storage/<key>/.zotero-reader-state`，而 `dataDir`
 *    可能是 macOS / Windows 的默认位置，也可能是用户在 Zotero 里改过的任意目录，
 *    插件没有可靠办法拿到（Zotero 本地 API 不报告这个路径）。读不到就是永久失效。
 * 2. 更重要的是语义不对：用户完全可能在面板里读、在 Zotero 里读，两边的进度本就
 *    是两回事。把 Zotero 的页码搬过来，反而会在「我明明在这读到 20 页」时跳回
 *    Zotero 记的第 3 页。
 *
 * 页号一律 **0 基**（与 Zotero 的 `pageIndex` 同约定，便于将来导出），
 * 进位到界面的 1 基换算只在 Client 的 `useReadPosition` 里做。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type {
  ZoteroItemBoxes,
  ZoteroPanelBox,
  ZoteroPanelKind,
  ZoteroPanelPos,
  ZoteroPanelSize,
  ZoteroReadPosition,
  ZoteroViewState,
} from './types.js'

/** 本插件数据目录（与写权限凭证同一处）。 */
function storageDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-plugin-zotero')
}

function storeFilePath(): string {
  return join(storageDir(), 'view-state.json')
}

/** 旧版只装阅读进度的文件；迁移完即删。 */
function legacyFilePath(): string {
  return join(storageDir(), 'read-positions.json')
}

/** 一条阅读记录。 */
interface StoredPosition {
  pageIndex: number
  updatedAt: string
}

interface StoredFile {
  positions: Record<string, StoredPosition>
  sections: Record<string, boolean>
  boxes: Record<string, ZoteroItemBoxes>
}

/**
 * 记录条数上限。
 *
 * 阅读进度是「翻过的每篇都留一行」，长期只会越攒越多；按 `updatedAt` 淘汰最旧的，
 * 500 篇足够覆盖真实阅读史，文件也就几十 KB。浮层几何同理，300 个条目足够。
 */
const MAX_POSITIONS = 500
const MAX_BOXES = 300

/** 「最近阅读」最多列出多少篇（按 `updatedAt` 倒序取头部）。 */
export const RECENT_LIMIT = 50

/** 进程内缓存：写请求很密（每次翻页都来），没必要反复读盘。 */
let cache: StoredFile | null = null

function emptyState(): StoredFile {
  return { positions: {}, sections: {}, boxes: {} }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 不存在 / 坏 JSON 都当没有：宁可从头记，也不要因为一个坏文件抛错。
    return null
  }
}

function parsePositions(raw: unknown): Record<string, StoredPosition> {
  const result: Record<string, StoredPosition> = {}
  if (typeof raw !== 'object' || raw === null) return result
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const record = value as { pageIndex?: unknown; updatedAt?: unknown }
    if (typeof record.pageIndex !== 'number' || !Number.isInteger(record.pageIndex)) continue
    if (record.pageIndex < 0) continue
    if (typeof record.updatedAt !== 'string') continue
    result[key] = { pageIndex: record.pageIndex, updatedAt: record.updatedAt }
  }
  return result
}

/** 只收布尔值的开合表；键与取值的语义由 Client 定义，这边不做白名单。 */
function parseSections(raw: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  if (typeof raw !== 'object' || raw === null) return result
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') result[key] = value
  }
  return result
}

function finiteIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value < min || value > max ? null : value
}

function parsePos(raw: unknown): ZoteroPanelPos | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const left = finiteIn((raw as Record<string, unknown>).left, -20_000, 20_000)
  const top = finiteIn((raw as Record<string, unknown>).top, -20_000, 20_000)
  return left === null || top === null ? undefined : { left, top }
}

function parseSize(raw: unknown): ZoteroPanelSize | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const width = finiteIn((raw as Record<string, unknown>).width, 100, 20_000)
  const height = finiteIn((raw as Record<string, unknown>).height, 80, 20_000)
  return width === null || height === null ? undefined : { width, height }
}

function parseBox(raw: unknown): ZoteroPanelBox | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const pos = parsePos(record.pos)
  const size = parseSize(record.size)
  if (pos === undefined && size === undefined) return undefined
  const at = finiteIn(record.at, 0, Number.MAX_SAFE_INTEGER) ?? 0
  return { pos, size, at }
}

function parseBoxes(raw: unknown): Record<string, ZoteroItemBoxes> {
  const result: Record<string, ZoteroItemBoxes> = {}
  if (typeof raw !== 'object' || raw === null) return result
  for (const [itemKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const outline = parseBox(entry.outline)
    const info = parseBox(entry.info)
    if (outline === undefined && info === undefined) continue
    result[itemKey] = { ...(outline === undefined ? {} : { outline }), ...(info === undefined ? {} : { info }) }
  }
  return result
}

/**
 * 读整份文件；碰到旧的 `read-positions.json` 就把它并进来，然后删掉。
 *
 * 迁移是「先写新文件、再删旧文件」：中途崩了最多两份都在，下次启动还会再并一次，
 * 不会出现「新文件半截、旧文件已没」。两份都在时按 `updatedAt` 取较新的那条 ——
 * 于是「新代码已经建了新文件、旧版本插件又写了一次旧文件」这种过渡期也不会丢进度。
 */
async function loadAll(): Promise<StoredFile> {
  if (cache !== null) return cache
  const parsed = await readJson(storeFilePath())
  const state: StoredFile = parsed === null
    ? emptyState()
    : {
      positions: parsePositions((parsed as { positions?: unknown }).positions),
      sections: parseSections((parsed as { sections?: unknown }).sections),
      boxes: parseBoxes((parsed as { boxes?: unknown }).boxes),
    }

  const legacy = await readJson(legacyFilePath())
  if (legacy === null) {
    cache = state
    return cache
  }

  const migrated = parsePositions((legacy as { positions?: unknown }).positions)
  for (const [key, entry] of Object.entries(migrated)) {
    const current = state.positions[key]
    if (current === undefined || current.updatedAt < entry.updatedAt) state.positions[key] = entry
  }
  cache = state
  await persist(cache)
  try {
    await unlink(legacyFilePath())
  } catch {
    // 删不掉就留着：新文件已经是唯一数据源，多一份旧的不影响使用（下次还会再并一次）。
  }
  return cache
}

/** 淘汰最旧的若干条，返回新对象（不改入参）。 */
function trimmedPositions(positions: Record<string, StoredPosition>): Record<string, StoredPosition> {
  const keys = Object.keys(positions)
  if (keys.length <= MAX_POSITIONS) return positions
  const keep = keys
    .sort((a, b) => positions[b].updatedAt.localeCompare(positions[a].updatedAt))
    .slice(0, MAX_POSITIONS)
  const next: Record<string, StoredPosition> = {}
  for (const key of keep) next[key] = positions[key]
  return next
}

/** 浮层几何按 `at` 淘汰：一个条目算一条，取两项里较新的时间。 */
function trimmedBoxes(boxes: Record<string, ZoteroItemBoxes>): Record<string, ZoteroItemBoxes> {
  const keys = Object.keys(boxes)
  if (keys.length <= MAX_BOXES) return boxes
  const newest = (entry: ZoteroItemBoxes): number => Math.max(entry.outline?.at ?? 0, entry.info?.at ?? 0)
  const keep = keys.sort((a, b) => newest(boxes[b]) - newest(boxes[a])).slice(0, MAX_BOXES)
  const next: Record<string, ZoteroItemBoxes> = {}
  for (const key of keep) next[key] = boxes[key]
  return next
}

/** 整份落盘：先写临时文件再 rename，避免半截 JSON 把历史进度全废掉。 */
async function persist(state: StoredFile): Promise<void> {
  const file = storeFilePath()
  const temp = `${file}.tmp`
  try {
    await mkdir(storageDir(), { recursive: true, mode: 0o700 })
    await writeFile(temp, `${JSON.stringify({ version: 2, ...state }, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    console.warn('[dsh-plugin-zotero] 保存视图状态失败：', error)
  }
}

/** 写串行化：并发翻页时不能让两次 read-modify-write 互相盖掉。 */
let writeQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task)
  // 失败不能把队列卡死，但要把错误还给调用方。
  writeQueue = next.catch(() => undefined)
  return next
}

// ---- 阅读进度 ---------------------------------------------------------------

/** 某个附件上次读到第几页（0 基）；没记过则 `null`。 */
export async function loadPosition(key: string): Promise<ZoteroReadPosition | null> {
  const all = await loadAll()
  const entry = all.positions[key]
  return entry === undefined ? null : { key, pageIndex: entry.pageIndex, updatedAt: entry.updatedAt }
}

/**
 * 「最近阅读」：按最后记录时间倒序取前 `limit` 篇。
 *
 * 只回附件 key 与时间；条目摘要（标题 / 作者 / 年份）由调用方再去 Zotero 换，
 * 这样删掉的条目不会在列表里留下空壳，元数据也始终是库里的最新值。
 */
export async function listRecent(limit = RECENT_LIMIT): Promise<ZoteroReadPosition[]> {
  const all = await loadAll()
  return Object.entries(all.positions)
    .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map(([key, entry]) => ({ key, pageIndex: entry.pageIndex, updatedAt: entry.updatedAt }))
}

/** 记下「这个附件读到第几页」（0 基）。 */
export function savePosition(key: string, pageIndex: number): Promise<ZoteroReadPosition> {
  return enqueue(async (): Promise<ZoteroReadPosition> => {
    const all = await loadAll()
    const entry: StoredPosition = { pageIndex, updatedAt: new Date().toISOString() }
    cache = { ...all, positions: trimmedPositions({ ...all.positions, [key]: entry }) }
    await persist(cache)
    return { key, pageIndex, updatedAt: entry.updatedAt }
  })
}

// ---- 信息浮层开合 + 浮层几何 -------------------------------------------------

/** 一次写入的浮层几何：只传这次真的动过的那一项。 */
export interface PanelBoxPatch {
  itemKey: string
  kind: ZoteroPanelKind
  pos?: ZoteroPanelPos
  size?: ZoteroPanelSize
}

/** 视图状态写请求：`sections` 整表替换，`boxes` 逐条合并。 */
export interface ViewStatePatch {
  sections?: Record<string, boolean>
  boxes?: PanelBoxPatch[]
}

/** 信息浮层开合 + 每个条目的浮层几何。 */
export async function loadViewState(): Promise<ZoteroViewState> {
  const all = await loadAll()
  return { sections: { ...all.sections }, boxes: { ...all.boxes } }
}

/**
 * 落盘一次视图状态改动。
 *
 * `sections` 是整表替换（条目少、语义就是「当前这份开合」）；`boxes` 按
 * `itemKey + kind` 合并，没传 `pos` / `size` 的那一项保持原样 —— 只拖了位置
 * 的条目不该因为这次写入多出一个写死的高度。
 */
export function saveViewState(patch: ViewStatePatch): Promise<{ saved: boolean }> {
  return enqueue(async (): Promise<{ saved: boolean }> => {
    const all = await loadAll()
    const at = Date.now()
    const boxes: Record<string, ZoteroItemBoxes> = { ...all.boxes }
    for (const item of patch.boxes ?? []) {
      const prev = boxes[item.itemKey]?.[item.kind]
      const pos = item.pos ?? prev?.pos
      const size = item.size ?? prev?.size
      boxes[item.itemKey] = {
        ...boxes[item.itemKey],
        [item.kind]: {
          ...(pos === undefined ? {} : { pos }),
          ...(size === undefined ? {} : { size }),
          at,
        },
      }
    }
    cache = {
      positions: all.positions,
      sections: patch.sections === undefined ? all.sections : { ...patch.sections },
      boxes: trimmedBoxes(boxes),
    }
    await persist(cache)
    return { saved: true }
  })
}
