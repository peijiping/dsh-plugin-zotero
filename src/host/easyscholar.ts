/**
 * easyScholar 期刊等级查询：Host 侧代理。
 *
 * 为什么走 Host 而不是渲染层：
 * - 面板跑在宿主 webview 里，直连第三方接口会被 CORS 挡住；
 * - SecretKey 不能落到渲染层，只能留在 Host。
 *
 * 接口是 easyScholar 的**官方开放接口**（`/open/getPublicationRank`），免登录、
 * 不与会员服务绑定、靠用户自己的 SecretKey 识别身份。它返回的是第三方转抄的
 * 期刊等级数据，权威性有限 —— 所以插件**只显示、不写回 Zotero、不落盘**：
 * 写回会污染用户文库并让插件替数据错误负责，落盘则会在数据更新后留下过期副本。
 *
 * 文档明确要求「每秒最多 2 次请求」，这里用一个全局时间槽做节流，并对同一刊名
 * 做内存缓存（跨文献复用，切来切去不会反复打接口）。
 */

import { ZoteroError } from '../zotero/client.js'
import { getSettings } from '../zotero/config.js'

/** 一次查询能拿到的字段，全部原样保留字符串形态。 */
export interface JournalRank {
  /** SCI 影响因子（JCR）。 */
  impactFactor: string
  /** SCI 分区（JCR），形如 `Q1`。 */
  jcrQuartile: string
  /** SCI 五年影响因子（JCR）。 */
  fiveYearIf: string
  /** 中科院升级版分区。 */
  casUp: string
  /** 中科院升级版小类分区。 */
  casUpSmall: string
  /** 中科院升级版 Top 分区标记。 */
  casUpTop: string
  /** 中科院预警标记。 */
  casWarn: string
  /** 新锐学术分区（中科院分区停更后出现的第三方替代口径）。 */
  xr: string
  /** 新锐学术 Top 分区标记。 */
  xrTop: string
  /** CCF 推荐等级。 */
  ccf: string
  /** 北大核心。 */
  pku: string
  /** 南大核心（CSSCI）。 */
  cssci: string
}

/** 查询结果。`no_key` 与 `miss` 都是正常态，只有 `failed` 是异常。 */
export type JournalRankOutcome =
  | { status: 'ok'; rank: JournalRank }
  | { status: 'no_key' }
  | { status: 'miss' }
  | { status: 'failed'; message: string }

export interface JournalRankInput {
  publicationName: string
}

const ENDPOINT = 'https://www.easyscholar.cc/open/getPublicationRank'

const TIMEOUT_MS = 8000

/** 文档写「每秒最多 2 次」，留 50ms 余量避免踩边界。 */
const MIN_INTERVAL_MS = 550

const CACHE_LIMIT = 300

/** 缓存 6 小时：期刊等级是年度量级的数据，但预警名单会临时变。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

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
  sciwarn: 'casWarn',
  xr: 'xr',
  xrTop: 'xrTop',
  ccf: 'ccf',
  pku: 'pku',
  cssci: 'cssci',
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
    casWarn: '',
    xr: '',
    xrTop: '',
    ccf: '',
    pku: '',
    cssci: '',
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

    const outcome = await request(key, secretKey)
    remember(key, outcome)
    return outcome
  }
}
