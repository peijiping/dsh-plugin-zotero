/**
 * 「读到哪一页」——**只记在本插件自己的存储里**，与 Zotero 完全无关。
 *
 * 为什么不去读 Zotero 那份：
 *
 * 1. 它的位置分散在 `<dataDir>/storage/<key>/.zotero-reader-state`，而 `dataDir`
 *    可能是 macOS / Windows 的默认位置，也可能是用户在 Zotero 里改过的任意目录，
 *    插件没有可靠办法拿到（Zotero 本地 API 不报告这个路径）。读不到就是永久失效。
 * 2. 更重要的是语义不对：用户完全可能在面板里读、在 Zotero 里读，两边的进度本就
 *    是两回事。把 Zotero 的页码搬过来，反而会在「我明明在这读到 20 页」时跳回
 *    Zotero 记的第 3 页。
 *
 * 所以这里只有一份数据：`<dsh 数据目录>/storages/dsh-plugin-zotero/read-positions.json`，
 * 按附件 key 记 0 基页号。面板自己读、自己写、自己续读。
 *
 * 页号一律 **0 基**（与 Zotero 的 `pageIndex` 同约定，便于将来导出），
 * 进位到界面的 1 基换算只在 Client 的 `useReadPosition` 里做。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ZoteroReadPosition } from './types.js'

/** 本插件数据目录（与写权限凭证同一处）。 */
function storageDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-plugin-zotero')
}

function storeFilePath(): string {
  return join(storageDir(), 'read-positions.json')
}

/** 一条本地记录。 */
interface StoredPosition {
  pageIndex: number
  updatedAt: string
}

/**
 * 记录条数上限。
 *
 * 这个文件是「翻过的每篇都留一行」，长期只会越攒越多；按 `updatedAt` 淘汰最旧的，
 * 500 篇足够覆盖真实阅读史，文件也就几十 KB。
 */
const MAX_ENTRIES = 500

/** 进程内缓存：写请求很密（每次翻页都来），没必要反复读盘。 */
let cache: Record<string, StoredPosition> | null = null

/** 读整份文件；坏了、没有都当空。 */
async function loadAll(): Promise<Record<string, StoredPosition>> {
  if (cache !== null) return cache
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(storeFilePath(), 'utf8'))
  } catch {
    cache = {}
    return cache
  }
  const positions = (parsed as { positions?: unknown } | null)?.positions
  const result: Record<string, StoredPosition> = {}
  if (typeof positions === 'object' && positions !== null) {
    for (const [key, value] of Object.entries(positions as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const record = value as { pageIndex?: unknown; updatedAt?: unknown }
      if (typeof record.pageIndex !== 'number' || !Number.isInteger(record.pageIndex)) continue
      if (record.pageIndex < 0) continue
      if (typeof record.updatedAt !== 'string') continue
      result[key] = { pageIndex: record.pageIndex, updatedAt: record.updatedAt }
    }
  }
  cache = result
  return cache
}

/** 淘汰最旧的若干条，返回新对象（不改入参）。 */
function trimmed(positions: Record<string, StoredPosition>): Record<string, StoredPosition> {
  const keys = Object.keys(positions)
  if (keys.length <= MAX_ENTRIES) return positions
  const keep = keys
    .sort((a, b) => positions[b].updatedAt.localeCompare(positions[a].updatedAt))
    .slice(0, MAX_ENTRIES)
  const next: Record<string, StoredPosition> = {}
  for (const key of keep) next[key] = positions[key]
  return next
}

/** 整份落盘：先写临时文件再 rename，避免半截 JSON 把历史进度全废掉。 */
async function persist(positions: Record<string, StoredPosition>): Promise<void> {
  const file = storeFilePath()
  const temp = `${file}.tmp`
  try {
    await mkdir(storageDir(), { recursive: true, mode: 0o700 })
    await writeFile(temp, `${JSON.stringify({ version: 1, positions }, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    console.warn('[dsh-plugin-zotero] 保存阅读进度失败：', error)
  }
}

/** 写串行化：并发翻页时不能让两次 read-modify-write 互相盖掉。 */
let writeQueue: Promise<unknown> = Promise.resolve()

/** 某个附件上次读到第几页（0 基）；没记过则 `null`。 */
export async function loadPosition(key: string): Promise<ZoteroReadPosition | null> {
  const all = await loadAll()
  const entry = all[key]
  return entry === undefined ? null : { key, pageIndex: entry.pageIndex, updatedAt: entry.updatedAt }
}

/** 记下「这个附件读到第几页」（0 基）。 */
export function savePosition(key: string, pageIndex: number): Promise<ZoteroReadPosition> {
  const next = writeQueue.then(async (): Promise<ZoteroReadPosition> => {
    const all = await loadAll()
    const entry: StoredPosition = { pageIndex, updatedAt: new Date().toISOString() }
    cache = trimmed({ ...all, [key]: entry })
    await persist(cache)
    return { key, pageIndex, updatedAt: entry.updatedAt }
  })
  // 失败不能把队列卡死，但要把错误还给调用方。
  writeQueue = next.catch(() => undefined)
  return next
}
