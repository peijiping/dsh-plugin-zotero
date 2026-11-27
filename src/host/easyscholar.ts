/**
 * easyScholar 期刊等级查询：Host 侧代理。
 *
 * 为什么走 Host 而不是渲染层：
 * - 面板跑在宿主 webview 里，直连第三方接口会被 CORS 挡住；
 * - SecretKey 不能落到渲染层，只能留在 Host。
 *
 * 接口是 easyScholar 的**官方开放接口**（`/open/getPublicationRank`），免登录、
 * 不与会员服务绑定、靠用户自己的 SecretKey 识别身份。它返回的是第三方转抄的
 * 期刊等级数据，权威性有限 —— 插件**不写回 Zotero**：写回会污染用户文库并让
 * 插件替数据错误负责。查询结果只落在本插件自己的缓存文件里（24h TTL），
 * 供条目列表直接复用，列表不会为此打接口。
 *
 * 文档明确要求「每秒最多 2 次请求」，这里用一个全局时间槽做节流，并对同一刊名
 * 做内存缓存（跨文献复用，切来切去不会反复打接口）。
 */

import { ZoteroError } from '../zotero/client.js'
import { getSettings } from '../zotero/config.js'
import type { JournalRank, JournalRankOutcome } from '../zotero/types.js'

// 统一类型放在 zotero/types.ts，Host 与 Client 共用同一份字段定义。
export type { JournalRank, JournalRankOutcome }

export interface JournalRankInput {
  publicationName: string
}

const ENDPOINT = 'https://www.easyscholar.cc/open/getPublicationRank'

const TIMEOUT_MS = 8000

/** 文档写「每秒最多 2 次」，留 50ms 余量避免踩边界。 */
const MIN_INTERVAL_MS = 550

const CACHE_LIMIT = 300

/**
 * 缓存 24 小时。
 *
 * 期刊等级是年度量级的数据（JCR 每年 6 月、中科院分区原本 10–11 月更新），
 * 6 小时太短 —— 用户一天里反复开同一篇文献会白白重复打接口。预警名单确实
 * 会临时变，但那种变化不是「今天必须知道」的量级。
 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** 字段值长度上限：正常等级值是 `Q1` / `1区` / `A` 这种，超长一定不是。 */
const MAX_VALUE_LEN = 40

/**
 * 接口字段 → 结果字段。
 *
 * 官方附录 1 里一共 37 个字段（各校自建目录、ABDC、FT50 之类），这里只取与
 * 「这刊什么档次」直接相关的那些：全显示会把面板撑爆，而校内目录各家口径不同，
 * 显示一两个反而误导。
 */
const FIELD_MAP: Record<string, keyof JournalRank> = {
  sciif: 'impactFactor',
  sci: 'jcrQuartile',
  sciif5: 'fiveYearIf',
  sciUp: 'casUp',
  sciUpSmall: 'casUpSmall',
  sciUpTop: 'casUpTop',
  // 中科院基础版（Style 的 `sciBase`）：与升级版口径不同，必须单独留一列。
  sciBase: 'casBase',
  sciwarn: 'casWarn',
  xr: 'xr',
  xrTop: 'xrTop',
  ccf: 'ccf',
  pku: 'pku',
  cssci: 'cssci',
  // 与 Style 结果归一：中文刊经常只有这几项，没有 JCR / 中科院分区。
  ei: 'ei',
  eii: 'ei',
  zhongguokejihexin: 'zhongguokejihexin',
}

function clean(raw: unknown): string {
  if (typeof raw === 'number') return String(raw)
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  return value.length > MAX_VALUE_LEN ? '' : value
}

/**
 * 从 `officialRank` 里抽字段。
 *
 * `all` 是全部已知等级，`select` 是用户在浏览器扩展里勾选的数据集；本插件不带
 * 扩展上下文，所以以 `all` 为准，`select` 只在 `all` 缺项时兜底。
 */
function toRank(official: unknown): JournalRank | null {
  if (official === null || typeof official !== 'object') return null
  const record = official as Record<string, unknown>
  const all = record.all
  const select = record.select
  if (all === null && select === null) return null

  const rank: Record<keyof JournalRank, string> = {
    impactFactor: '',
    jcrQuartile: '',
    fiveYearIf: '',
    casUp: '',
    casUpSmall: '',
    casUpTop: '',
    casBase: '',
    casWarn: '',
    xr: '',
    xrTop: '',
    ccf: '',
    pku: '',
    cssci: '',
    ei: '',
    zhongguokejihexin: '',
  }

  for (const source of [all, select]) {
    if (source === null || typeof source !== 'object') continue
    const fields = source as Record<string, unknown>
    for (const [key, field] of Object.entries(FIELD_MAP)) {
      if (rank[field] !== '') continue
      rank[field] = clean(fields[key])
    }
  }

  const hit = Object.values(rank).some((value) => value !== '')
  return hit ? rank : null
}

interface CacheEntry {
  at: number
  outcome: JournalRankOutcome
}

/**
 * 创建查询器。返回值即 Host 的 `journalRank` 依赖，按刊名查询期刊等级。
 */
export function createJournalRanker(): (input: JournalRankInput) => Promise<JournalRankOutcome> {
  const cache = new Map<string, CacheEntry>()
  /** 正在飞行中的请求：同刊名并发时复用同一个 Promise，避免重复打接口。 */
  const inflight = new Map<string, Promise<JournalRankOutcome>>()
  /** 下一个可用时间槽（毫秒时间戳）。 */
  let nextSlot = 0

  function remember(key: string, outcome: JournalRankOutcome): void {
    // 失败不缓存：网络抖动或密钥刚填错，下一次该重试。
    if (outcome.status === 'failed') return
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, { at: Date.now(), outcome })
  }

  /** 预约一个时间槽，保证两次请求的**发起**间隔不小于 MIN_INTERVAL_MS。 */
  async function waitForSlot(): Promise<void> {
    const now = Date.now()
    const start = Math.max(now, nextSlot)
    nextSlot = start + MIN_INTERVAL_MS
    const wait = start - now
    if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait) })
  }

  async function request(key: string, secretKey: string): Promise<JournalRankOutcome> {
    await waitForSlot()
    const url = new URL(ENDPOINT)
    url.searchParams.set('secretKey', secretKey)
    // 文档强调必须 encode，否则刊名里的 `&` 会把参数截断。
    url.searchParams.set('publicationName', key)

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!res.ok) return { status: 'failed', message: `easyScholar 返回 HTTP ${res.status}` }
      const payload = await res.json() as {
        code?: number
        msg?: string
        data?: { officialRank?: unknown } | null
      }
      if (payload.code !== 200) {
        // 40002 是最常见的「密钥填错」，直接说人话，别让用户去猜。
        const message = payload.code === 40002
          ? 'SecretKey 无效：请到 easyScholar「用户信息 → 开放接口」重新复制'
          : (payload.msg ?? `easyScholar 返回 code ${String(payload.code)}`)
        return { status: 'failed', message }
      }
      const rank = toRank(payload.data?.officialRank)
      return rank === null ? { status: 'miss' } : { status: 'ok', rank }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { status: 'failed', message: '查询 easyScholar 超时' }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'failed', message: `查询 easyScholar 失败：${message}` }
    } finally {
      clearTimeout(timer)
    }
  }

  return async (input: JournalRankInput): Promise<JournalRankOutcome> => {
    const name = input.publicationName.trim()
    if (name === '') throw new ZoteroError('bad_request', '缺少期刊名')

    const secretKey = getSettings().easyScholarKey
    if (secretKey === '') return { status: 'no_key' }

    const key = name.toLowerCase()
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.outcome

    // 同一刊名并发只发一次：面板重开、快速切条目都可能让两个请求同时进来，
    // 而缓存要等请求回来才写入，光靠缓存挡不住。
    const pending = inflight.get(key)
    if (pending !== undefined) return pending

    const task = request(key, secretKey)
    inflight.set(key, task)
    try {
      const outcome = await task
      remember(key, outcome)
      return outcome
    } finally {
      inflight.delete(key)
    }
  }
}
