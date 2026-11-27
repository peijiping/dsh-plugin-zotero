/**
 * 期刊标签的「读结果 + 本地缓存」层。
 *
 * 复用边界：读 Style 算好的 `zoterostyle.json`，并按用户明确授权读取它的
 * PublicationTags 列配置（Fields / Map / source）来复刻显示范围；仍然不读密钥、
 * 不改它的文件、不复刻第二个设置页。显示口径的实现见 `publicationTags.ts`。
 *
 * 查询优先级（详见 `host/journal-tags.ts`）：
 *   ① Style 的 `zoterostyle.json`（用户装了并且查过这本刊）
 *   ② 本插件的 `journal-ranks.json`（我们自己的 API 补过的结果）
 *   ③ easyScholar API（由 Host 归一层发起，结果写回②）
 *
 * 本模块**不发网络请求**：列表摘要构造时会同步消费①②，一屏几十行不能打接口。
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getSettings } from './config.js'
import { journalRankToRaw, publicationTagEntries, readPublicationTagsPrefs } from './publicationTags.js'
import { readZoteroPaths } from './prefs.js'
import { KNOWN_STYLE_FIELDS } from './styleFields.js'
import type { JournalRank, JournalTags } from './types.js'

/** 缓存 24 小时：期刊等级是年度量级的数据，6 小时太短。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** 缓存刊数上限；按写入时间淘汰最旧的，文件始终只有几十 KB。 */
const CACHE_LIMIT = 500

/** 字段值长度上限：正常等级值是 `Q1` / `医学3区` 这种，超长不认。 */
const MAX_VALUE_LEN = 40

interface CacheEntry {
  at: number
  rank: JournalRank
}

interface CacheFile {
  version: 1
  ranks: Record<string, CacheEntry>
}

const EMPTY_CACHE: CacheFile = { version: 1, ranks: {} }

function storageDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-plugin-zotero')
}

function cachePath(): string {
  return join(storageDir(), 'journal-ranks.json')
}

/** 刊名 key：统一小写、去首尾空白，与 easyScholar 查询器保持一致。 */
function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

function clean(raw: unknown): string {
  if (typeof raw === 'number') return String(raw)
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  return value === '' || value.length > MAX_VALUE_LEN ? '' : value
}

function emptyRank(): JournalRank {
  return {
    impactFactor: '', jcrQuartile: '', fiveYearIf: '',
    casUp: '', casUpSmall: '', casUpTop: '', casBase: '',
    casWarn: '', xr: '', xrTop: '', ccf: '', pku: '', cssci: '',
    ei: '', zhongguokejihexin: '',
  }
}

/**
 * Style 结果里的键 → 我们的字段。
 *
 * 键名取自实际文件（`sciif` / `sci` / `sciBase` / `sciUp` / `xr` / `xrTop` /
 * `pku` / `cssci`），不做模糊匹配：宁可漏一枚，也不把 `jci` 认成影响因子。
 */
const STYLE_FIELDS: ReadonlyArray<readonly [string, keyof JournalRank]> = [
  ['sciif', 'impactFactor'],
  ['sci', 'jcrQuartile'],
  ['sciif5', 'fiveYearIf'],
  ['sciUp', 'casUp'],
  ['sciUpSmall', 'casUpSmall'],
  ['sciUpTop', 'casUpTop'],
  ['sciBase', 'casBase'],
  ['sciwarn', 'casWarn'],
  ['xr', 'xr'],
  ['xrTop', 'xrTop'],
  ['ccf', 'ccf'],
  ['pku', 'pku'],
  ['cssci', 'cssci'],
  // EI 与科技核心：中文刊经常只有这两项，没有 IF / 分区。
  ['eii', 'ei'],
  ['zhongguokejihexin', 'zhongguokejihexin'],
]

/**
 * 已知键并集，只用于判断「文件结构是不是变了」。
 *
 * 除上面映射的字段外，还收 Style 会写的校内目录与收录标记（见 `styleFields.ts`）——
 * 一个全是中文期刊或军工期刊的库，键名同样合法，不该被误报成结构异常。
 */
const KNOWN_STYLE_KEYS = KNOWN_STYLE_FIELDS

export function styleRankToJournalRank(raw: unknown): JournalRank | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>
  const rank = emptyRank()
  for (const [key, field] of STYLE_FIELDS) rank[field] = clean(fields[key])
  // 只有用户配置里才用到的字段（如某校目录）时 rank 会全空，但 raw 仍有效。
  const hit = Object.entries(fields).some(
    ([key, value]) => KNOWN_STYLE_KEYS.has(key) && clean(value) !== '',
  )
  return hit ? rank : null
}

/** 中科院分区统一取基础版：与 Style 的 `sciBase` 口径一致；再退新锐 / 升级版 / 仅 TOP。 */
function casOf(rank: JournalRank): string {
  return rank.casBase || rank.xr || rank.casUp || rank.xrTop
}

/**
 * 收录标记的值校验：宁可漏，也不要把「EI 收录：否」或校内目录备注当成核心收录。
 *
 * - `eii`：Style 实际写的是 `EI`；大小写放开，但不认 `EI检索` 之外的长串。
 * - `pku`：Style 与 easyScholar 都用 `1` 表示北大核心，`0` / 空都不算。
 * - `zhongguokejihexin`：认「科技核心」字样，原样留着供界面显示。
 */
function coreValue(raw: unknown, kind: 'ei' | 'pku' | 'keji'): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (kind === 'ei') return /^ei$/iu.test(value) ? 'EI' : ''
  if (kind === 'pku') return value === '1' ? '1' : ''
  return value.includes('科技核心') ? value : ''
}

/**
 * 归一成可展示标签。缺项留空，由界面跳过那一枚胶囊；旧缓存条目没有新字段时
 * 用 `?? ''` 兜底，不能让 `undefined` 混进 `hasTags` 被当成命中。
 */
export function rankToTags(rank: JournalRank, source: JournalTags['source']): JournalTags {
  return {
    impactFactor: rank.impactFactor ?? '',
    jcrQuartile: rank.jcrQuartile ?? '',
    casQuartile: casOf(rank),
    ei: coreValue(rank.ei, 'ei'),
    pku: coreValue(rank.pku, 'pku'),
    zhongguokejihexin: coreValue(rank.zhongguokejihexin, 'keji'),
    mirrored: [],
    source,
  }
}

/** 按 Zotero 列配置决定「这一本有没有可显示的项」：配置没选的字段一律不算。 */
function hasTags(tags: JournalTags): boolean {
  return (tags.mirrored?.length ?? 0) > 0
}

// ---- Style 结果缓存 ---------------------------------------------------------

interface StyleEntry {
  rank: JournalRank | null
  /** Style 的原始 rank，按用户 Fields 配置生成胶囊时要用。 */
  raw: Record<string, unknown>
}

interface StyleFile {
  stamp: string
  ranks: Map<string, StyleEntry>
}

let styleCache: StyleFile | null = null

/** 结构异常只提醒一次：每次重读文件都刷一遍日志没用，用户也不会看。 */
let warnedShape = false

/**
 * 读 `<dataDir>/zoterostyle.json`，按 mtime + size 判断是否需要重读。
 *
 * 用户可能随时在 Zotero 里新查了一本刊；每次请求 stat 一次足够便宜，又能让
 * 新结果在下一次打开详情时立刻可见（不需要重启 DSH）。
 */
async function loadStyleRanks(): Promise<Map<string, StyleEntry>> {
  const paths = await readZoteroPaths()
  // `extensions.zotero.dataDir` 只有用户改过数据目录才会写进 prefs.js；没写过的
  // 机器 Zotero 用默认的 `~/Zotero`。少了这步兜底，装了 Style 也读不到结果。
  const dir = paths.dataDir !== '' ? paths.dataDir : join(homedir(), 'Zotero')
  const file = join(dir, 'zoterostyle.json')
  let info
  try {
    info = await stat(file)
  } catch {
    return new Map()
  }
  const stamp = `${file}:${info.mtimeMs}:${info.size}`
  if (styleCache !== null && styleCache.stamp === stamp) return styleCache.ranks
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 插件正在写文件时可能读到半截 JSON：这次按未命中，下次 stamp 变了再读。
    return new Map()
  }
  const ranks = new Map<string, StyleEntry>()
  const unknown: string[] = []
  let knownHits = 0
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
      const record = entry !== null && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : {}
      const rankRaw = record.rank
      if (rankRaw !== null && typeof rankRaw === 'object') {
        for (const [key, value] of Object.entries(rankRaw as Record<string, unknown>)) {
          if (!KNOWN_STYLE_KEYS.has(key)) {
            if (unknown.length < 3 && !unknown.includes(key)) unknown.push(key)
            continue
          }
          if (clean(value) !== '') knownHits += 1
        }
      }
      ranks.set(nameKey(name), {
        rank: styleRankToJournalRank(rankRaw),
        raw: rankRaw !== null && typeof rankRaw === 'object' && !Array.isArray(rankRaw)
          ? { ...(rankRaw as Record<string, unknown>) }
          : {},
      })
    }
  }
  // 文件有内容却一个字段都对不上：多半是 Style 改了字段名。只报一次，且不打断
  // 查询（本次仍按未命中处理），否则用户只会看到「查不到」而不知道是解析失效。
  if (!warnedShape && ranks.size > 0 && knownHits === 0 && unknown.length > 0) {
    warnedShape = true
    console.warn(`[dsh-plugin-zotero] ${file} 里没有可识别的期刊字段（见到：${unknown.join('、')}），可能是 Style 改了字段名，已按未命中处理。`)
  }
  styleCache = { stamp, ranks }
  return ranks
}

/** 查 Style 结果；关掉开关、没装插件、没查过这本刊都返回 `null`。 */
export async function lookupStyleTags(name: string): Promise<JournalTags | null> {
  if (!getSettings().styleJournalTags) return null
  const key = nameKey(name)
  if (key === '') return null
  const found = (await loadStyleRanks()).get(key)
  if (found === undefined || (found.rank === null && Object.keys(found.raw).length === 0)) return null
  const prefs = await readPublicationTagsPrefs()
  const tags = rankToTags(found.rank ?? emptyRank(), 'style')
  tags.mirrored = publicationTagEntries(found.raw, prefs)
  return hasTags(tags) ? tags : null
}

// ---- 本插件的本地缓存 -------------------------------------------------------

let cachePromise: Promise<CacheFile> | null = null

async function loadCache(): Promise<CacheFile> {
  if (cachePromise !== null) return cachePromise
  cachePromise = (async (): Promise<CacheFile> => {
    try {
      const raw = JSON.parse(await readFile(cachePath(), 'utf8')) as Partial<CacheFile>
      if (raw === null || typeof raw !== 'object' || raw.version !== 1) return EMPTY_CACHE
      const ranks = raw.ranks ?? {}
      if (ranks === null || typeof ranks !== 'object') return EMPTY_CACHE
      const out: Record<string, CacheEntry> = {}
      const now = Date.now()
      for (const [key, entry] of Object.entries(ranks as Record<string, unknown>)) {
        if (entry === null || typeof entry !== 'object') continue
        const record = entry as Partial<CacheEntry>
        if (typeof record.at !== 'number' || !Number.isFinite(record.at)) continue
        if (now - record.at >= CACHE_TTL_MS) continue
        if (record.rank === null || typeof record.rank !== 'object') continue
        out[key] = { at: record.at, rank: record.rank as JournalRank }
      }
      return { version: 1, ranks: out }
    } catch {
      // 文件不存在 / 坏 JSON 都当空：缓存只是加速，丢了随时能重查。
      return EMPTY_CACHE
    }
  })()
  return cachePromise
}

/** 写串行化，避免并发回填互相盖掉（与 view-state 同一套路）。 */
let writeQueue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task)
  writeQueue = next.catch(() => undefined)
  return next
}

async function persist(state: CacheFile): Promise<void> {
  const file = cachePath()
  const temp = `${file}.tmp`
  try {
    await mkdir(storageDir(), { recursive: true, mode: 0o700 })
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    console.warn('[dsh-plugin-zotero] 保存期刊标签缓存失败：', error)
  }
}

/** 读缓存里的 API 结果（已过 TTL 的按未命中；过期项不主动删，写时统一淘汰）。 */
export async function lookupCachedTags(name: string): Promise<JournalTags | null> {
  const key = nameKey(name)
  if (key === '') return null
  const entry = (await loadCache()).ranks[key]
  if (entry === undefined) return null
  if (Date.now() - entry.at >= CACHE_TTL_MS) return null
  const prefs = await readPublicationTagsPrefs()
  const tags = rankToTags(entry.rank, 'cache')
  tags.mirrored = publicationTagEntries(journalRankToRaw(entry.rank), prefs)
  return hasTags(tags) ? tags : null
}

/** API 查到结果后写回本地缓存，供列表与下次打开直接复用。 */
export function rememberRank(name: string, rank: JournalRank): Promise<void> {
  return enqueue(async (): Promise<void> => {
    const key = nameKey(name)
    if (key === '') return
    const state = await loadCache()
    const ranks: Record<string, CacheEntry> = { ...state.ranks, [key]: { at: Date.now(), rank } }
    const overflow = Object.keys(ranks).length - CACHE_LIMIT
    if (overflow > 0) {
      for (const old of Object.keys(ranks)
        .sort((a, b) => ranks[a].at - ranks[b].at)
        .slice(0, overflow)) {
        delete ranks[old]
      }
    }
    const next = { version: 1 as const, ranks }
    cachePromise = Promise.resolve(next)
    await persist(next)
  })
}

/**
 * 列表摘要用：只从①②取，绝不在构造一屏条目时打接口。
 *
 * 每次调用都读一次内存缓存 Promise（首次会读盘），之后是纯内存查找。
 */
export async function tagsForSummary(name: string): Promise<JournalTags | null> {
  const style = await lookupStyleTags(name)
  if (style !== null) return style
  return lookupCachedTags(name)
}
