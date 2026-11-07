/**
 * Zotero 本地 API 的**写**通道（面板与模型侧改库的唯一路径）。
 *
 * 与只读的 `client.ts` 分家：读路径是纯 GET、成熟且量大；写路径的复杂度全在
 * 「鉴权状态 + 并发前置条件 + 错误语义」上，混在一起只会互相拖累。
 *
 * 下面三条来自本机 Zotero 10.0.7 源码（`xpcom/server/server_localAPI.js`）的事实
 * 决定了本模块的形状：
 *
 * 1. `POST /api/local/authorize` **每次必弹框**（没有「已记住就免弹」分支），且
 *    每分钟 5 次限流（超限 429 + `Retry-After`）。因此「一次授权、永久可用」靠的是
 *    **自己把 key 存住**（{@link key-store}）：授权成功即落盘，启动时静默复用，
 *    写操作里永远不主动申请授权。
 * 2. 只有「始终允许」的 key 可复用；「允许」的 key 被首个成功写请求消耗
 *    （`consumeLocalAPIKey`）。所以一次性 key **不落盘**，且一次用户操作尽量压进
 *    单个请求；**401 只提示不自动重试** —— 自动重新授权等于替用户点弹窗。
 * 3. 写请求必须带 `Zotero-Server-ID`（缺失 428、不匹配 412，正文含 "Server-ID"），
 *    更新/删除必须带版本（body 的 `version` 或 `If-Unmodified-Since-Version`，
 *    缺失 428）。版本对不上 → 412，语义是「Zotero 那边改过了」，与实例变更不同，
 *    因此只对 412/428 且正文提到 Server-ID 的响应换 ID 重试一次。
 */

import {
  AUTHORIZE_APP_NAME,
  AUTHORIZE_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  getSettings,
  libraryBase,
  zoteroProbeUrl,
} from './config.js'
import { ZoteroError } from './client.js'
import { forgetKey, loadStoredKey, readZoteroRememberedKey, storeKey } from './key-store.js'

/** 写通道支持的 HTTP 动词（本地 API 与 Web API 同构）。 */
export type WriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface WriteOptions {
  /** 请求体；对象或数组都行，一律 JSON 序列化。 */
  body?: unknown
  /**
   * 并发前置条件的条目 / 库版本。
   *
   * 更新与删除必须给：Zotero 缺它就直接 428，绝不「盲写」。
   */
  version?: number
  /** 额外请求头（如 `Zotero-Write-Token`）。 */
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 一次写请求的结果。 */
export interface WriteResult<T> {
  status: number
  /** 解析后的 JSON 正文；`204` 与无正文时为 `null`。 */
  data: T | null
  /** 响应头 `Last-Modified-Version`（写完成后的**库**版本）；缺失为 `null`。 */
  version: number | null
}

/** 写通道状态（进程内快照，不含 key 本体）。 */
export interface WriteChannelStatus {
  enabled: boolean
  hasKey: boolean
  remembered: boolean
}

// ---- 凭证态 -----------------------------------------------------------------

/** 一条可用凭证：key 本体 + 它是否可复用 + 是否已落盘（决定 401 时要不要删文件）。 */
interface Credentials {
  key: string
  /** 「始终允许」的 key 可无限复用；一次性 key 用一次就废。 */
  remembered: boolean
  /** 落盘过（含从 Zotero 密钥库导入），失效时要把本地副本一并删掉。 */
  stored: boolean
}

/**
 * 当前凭证。
 *
 * 首次用到时才去磁盘上找（{@link restoreCredentials}），避免在插件加载时做 IO；
 * 找到即缓存在内存，读操作与状态查询不会反复读文件。
 */
let credentials: Credentials | undefined

/** 从 Zotero 密钥库导入只做一次：导入过就不再回读，避免失效 key 被反复捞回来。 */
let imported = false

/** 已经被 Zotero 判过 401 的 key，不再从磁盘恢复。 */
let rejectedKey: string | undefined

/** 正在进行的恢复流程（并发调用共享同一次读盘）。 */
let restoring: Promise<void> | undefined

/**
 * `Zotero-Server-ID` 缓存。
 *
 * ID 随 Zotero 实例变化（重启即换），故连接失败时就作废，下次写重新探。
 * 同时按 `baseUrl` 分区：用户在配置页改地址后旧 ID 不再适用。
 */
let cachedServerId: { baseUrl: string; id: string } | undefined

function shortMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invalidateServerId(): void {
  cachedServerId = undefined
}

/**
 * 恢复写权限：本插件自己的副本 → Zotero 的密钥库（仅在首次启动迁移时）。
 *
 * 三步都失败就当没授权，用户点一次按钮即可 —— 绝不在这里替用户弹 Zotero 的框。
 */
async function restoreCredentials(): Promise<void> {
  if (credentials !== undefined) return
  restoring ??= (async () => {
    try {
      let key = await loadStoredKey()
      let fromZotero = false
      if (key === null && !imported) {
        imported = true
        key = await readZoteroRememberedKey(AUTHORIZE_APP_NAME)
        fromZotero = key !== null
      }
      if (key === null || key === rejectedKey) return
      // 用户此前点过「始终允许」，把 Zotero 那份搬进本插件自己的库，之后不再依赖它的文件布局。
      if (fromZotero) await storeKey(key)
      credentials = { key, remembered: true, stored: true }
    } catch (error) {
      console.warn('[dsh-plugin-zotero] 读取本地写权限凭证失败：', error)
    } finally {
      restoring = undefined
    }
  })()
  await restoring
}

// ---- 状态查询 ---------------------------------------------------------------

/** 当前写通道状态，供配置卡渲染状态徽标与按钮。 */
export async function writeChannelStatus(): Promise<WriteChannelStatus> {
  await restoreCredentials()
  return {
    enabled: getSettings().writeEnabled,
    hasKey: credentials !== undefined,
    remembered: credentials?.remembered === true,
  }
}

/**
 * 写操作的前置检查：开关打开 + 手上有 key，否则直接抛错不发请求。
 *
 * 放在 {@link requestWrite} 内部做唯一闸门，面板路由与模型工具因此同受约束。
 * 手上有 key 就不会再问用户要授权 —— 这是「一次授权永久可用」的落点。
 */
export async function ensureWritable(): Promise<void> {
  if (!getSettings().writeEnabled) {
    throw new ZoteroError(
      'bad_request',
      '本插件的 Zotero 写入未开启：请在插件「配置」页打开「允许写入 Zotero」。',
    )
  }
  await restoreCredentials()
  if (credentials === undefined) {
    throw new ZoteroError(
      'zotero_need_auth',
      '尚未取得 Zotero 写权限：请在插件「配置」页点一次「授权 Zotero 写权限」，并在 Zotero 弹窗里选「始终允许」——该授权会保存下来，之后不会再问。',
    )
  }
}

// ---- Server ID --------------------------------------------------------------

async function serverId(force: boolean): Promise<string> {
  const baseUrl = getSettings().zoteroBaseUrl
  if (!force && cachedServerId && cachedServerId.baseUrl === baseUrl) return cachedServerId.id
  let res: Response
  try {
    res = await fetch(zoteroProbeUrl(), { signal: AbortSignal.timeout(getSettings().requestTimeoutMs) })
  } catch (error) {
    invalidateServerId()
    throw new ZoteroError(
      'zotero_unreachable',
      `无法连接 Zotero 本地 API（${baseUrl}）：${shortMessage(error)}`,
    )
  }
  if (res.status === 403) {
    throw new ZoteroError(
      'zotero_disabled',
      'Zotero 本地 API 未开放：请在 Zotero「设置 → 高级 → 其他」中勾选「允许本机其他应用与 Zotero 通信」。',
    )
  }
  const id = res.headers.get('zotero-server-id')
  if (!id) {
    invalidateServerId()
    throw new ZoteroError('zotero_unreachable', 'Zotero 未返回 Zotero-Server-ID：请确认本机 Zotero 为 10 及以上版本且正在运行。')
  }
  cachedServerId = { baseUrl, id }
  return id
}

// ---- 错误归一化 -------------------------------------------------------------

/** 正文里出现过的 Server-ID 相关措辞（412 与 428 两种都见过）。 */
function isServerIdProblem(status: number, text: string): boolean {
  return (status === 412 || status === 428) && /server-id/iu.test(text)
}

/** 错误正文只回一小段：Zotero 出错时可能塞整页 HTML。 */
function brief(text: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 180)}…`
}

/** 把非 2xx 响应转成 {@link ZoteroError}；顺带处理「key 失效」这一副作用。 */
function toWriteError(status: number, text: string, retryAfter: string | null): ZoteroError {
  const detail = brief(text)
  switch (status) {
    case 401: {
      // 一次性 key 已耗尽、或用户在 Zotero 里清了授权。
      const dead = credentials
      credentials = undefined
      rejectedKey = dead?.key
      // 落过盘的失效 key 顺手删掉，免得下次启动又从磁盘上捞回来。
      if (dead?.stored === true) void forgetKey()
      return new ZoteroError(
        'zotero_need_auth',
        'Zotero 拒绝了当前写权限（可能是一次性 key 已用完，或在 Zotero 里撤销了授权）：请在插件「配置」页重新授权并选「始终允许」。',
      )
    }
    case 403:
      if (/"denied"\s*:\s*true/u.test(text)) {
        return new ZoteroError('zotero_denied', '你在 Zotero 的授权弹窗里点了「拒绝」。')
      }
      return new ZoteroError(
        'zotero_disabled',
        'Zotero 拒绝了该请求（403）。若本地 API 开关未打开，请在 Zotero「设置 → 高级 → 其他」中允许本机应用通信。',
      )
    case 404:
      return new ZoteroError('zotero_not_found', `Zotero 中找不到该资源（404）${detail ? `：${detail}` : ''}`)
    case 409:
      return new ZoteroError('zotero_conflict', 'Zotero 文库当前被锁定（通常在同步中），请稍后重试。')
    case 412:
      return new ZoteroError('zotero_stale', '该内容在 Zotero 里已被改动，本次操作未生效，请刷新后重试。')
    case 413:
      return new ZoteroError('bad_request', '一次性提交的内容过多，请减少后重试。')
    case 428:
      return new ZoteroError('bad_request', `Zotero 要求携带版本前置条件但本次未提供（428）${detail ? `：${detail}` : ''}`)
    case 429: {
      const seconds = retryAfter === null ? null : Number.parseInt(retryAfter, 10)
      return new ZoteroError(
        'zotero_rate_limited',
        `授权请求过于频繁，请${Number.isFinite(seconds as number) ? `约 ${seconds} 秒` : '稍后'}后再试。`,
      )
    }
    default:
      return new ZoteroError('bad_request', `Zotero 本地 API 返回 ${status}${detail ? `：${detail}` : ''}`)
  }
}

function parseData<T>(text: string): T | null {
  if (text === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function versionOf(res: Response): number | null {
  const raw = res.headers.get('last-modified-version')
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function baseHeaders(id: string): Record<string, string> {
  const headers: Record<string, string> = { 'Zotero-Server-ID': id }
  // 故意不发 `Zotero-API-Version`：该头可省，Zotero 会用自己的当前版本兜底；
  // 写死 3 等于在未来 Zotero 升 API 版本时自我否决。
  if (credentials) headers['Zotero-API-Key'] = credentials.key
  return headers
}

// ---- 授权 -------------------------------------------------------------------

/**
 * 申请本地写权限（会弹 Zotero 对话框，等用户点按钮才返回）。
 *
 * 只在用户明确点击配置卡上的授权按钮时调用；写请求收到 401 时**不**自动调它。
 *
 * 用户选「始终允许」时**立刻落盘**，从此重启 dsh 也复用同一把 key —— 这正是
 * 「一次授权、永久使用」。选「允许」（一次性）则不落盘，用完即废。
 */
export async function authorize(): Promise<{ remembered: boolean }> {
  if (!getSettings().writeEnabled) {
    throw new ZoteroError(
      'bad_request',
      '本插件的 Zotero 写入未开启：请在插件「配置」页打开「允许写入 Zotero」后再授权。',
    )
  }
  const url = `${getSettings().zoteroBaseUrl}/api/local/authorize`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = await serverId(attempt === 1)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...baseHeaders(id), 'content-type': 'application/json' },
        body: JSON.stringify({ appName: AUTHORIZE_APP_NAME }),
        // 这个请求挂在 Zotero 的模态弹窗上，超时按「人读完一句话」的量级给。
        signal: AbortSignal.timeout(AUTHORIZE_TIMEOUT_MS),
      })
    } catch (error) {
      invalidateServerId()
      throw new ZoteroError('zotero_unreachable', `无法连接 Zotero 本地 API 申请授权：${shortMessage(error)}`)
    }
    const text = res.status === 204 ? '' : await res.text().catch(() => '')
    if (!res.ok) {
      if (isServerIdProblem(res.status, text) && attempt === 0) {
        invalidateServerId()
        continue
      }
      throw toWriteError(res.status, text, res.headers.get('retry-after'))
    }
    const payload = parseData<{ key?: unknown; remember?: unknown }>(text)
    if (typeof payload?.key !== 'string' || payload.key === '') {
      throw new ZoteroError('internal_error', 'Zotero 的授权响应里没有 key，无法继续。')
    }
    const remembered = payload.remember === true
    // 一次性 key 不落盘：它本来就用一次即废，存下来只会在下次启动时白白失败一次。
    if (remembered) await storeKey(payload.key)
    credentials = { key: payload.key, remembered, stored: remembered }
    rejectedKey = undefined
    return { remembered }
  }
  throw new ZoteroError('internal_error', '授权请求未能完成。')
}

// ---- 写请求 -----------------------------------------------------------------

const SERVER_ID_STALE = Symbol('server-id-stale')

async function attemptWrite<T>(
  method: WriteMethod,
  path: string,
  options: WriteOptions,
  refreshId: boolean,
): Promise<WriteResult<T> | typeof SERVER_ID_STALE> {
  const url = `${libraryBase()}${path}`
  const id = await serverId(refreshId)
  const headers: Record<string, string> = { ...baseHeaders(id), ...options.headers }
  if (options.version !== undefined) headers['If-Unmodified-Since-Version'] = String(options.version)
  const hasBody = options.body !== undefined
  if (hasBody) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? WRITE_TIMEOUT_MS),
    })
  } catch (error) {
    // 连不上通常意味着 Zotero 退出或重启（Server ID 随之失效），清缓存。
    invalidateServerId()
    throw new ZoteroError('zotero_unreachable', `写入 Zotero 本地 API 失败（${url}）：${shortMessage(error)}`)
  }
  const text = res.status === 204 ? '' : await res.text().catch(() => '')
  if (!res.ok) {
    if (isServerIdProblem(res.status, text) && !refreshId) {
      invalidateServerId()
      return SERVER_ID_STALE
    }
    throw toWriteError(res.status, text, res.headers.get('retry-after'))
  }
  return { status: res.status, data: parseData<T>(text), version: versionOf(res) }
}

/**
 * 向 Zotero 本地 API 发一次写请求。
 *
 * 走 {@link ensureWritable} 闸门：总开关未开或没有 key 时直接抛错，不产生任何请求。
 * Server ID 失配是唯一会被自动重试的情形（换 ID 再试一次，不会重复落库）。
 */
export async function requestWrite<T = unknown>(
  method: WriteMethod,
  path: string,
  options: WriteOptions = {},
): Promise<WriteResult<T>> {
  await ensureWritable()
  const first = await attemptWrite<T>(method, path, options, false)
  if (first !== SERVER_ID_STALE) return first
  const second = await attemptWrite<T>(method, path, options, true)
  if (second !== SERVER_ID_STALE) return second
  throw new ZoteroError('zotero_unreachable', 'Zotero 本地 API 的 Server ID 始终不匹配，写入未完成。')
}

// ---- 条目级写操作 -----------------------------------------------------------

/**
 * `POST /items` 的响应体（实测四段齐全，即使只提交一个对象）。
 *
 * `successful` 里带完整条目对象（含 key / version / data），因此新建后无需再 GET 一次
 * 就能拿到版本；`success` 只给 key，作为兜底。下标是入参数组的位置。
 */
interface BatchResponse {
  successful?: Record<string, { key?: unknown; version?: unknown }>
  success?: Record<string, unknown>
  failed?: Record<string, unknown>
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function briefFailure(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 180)}…`
}

/** 新建条目的回执。 */
export interface WrittenItem {
  key: string
  /** Zotero 未回版本时为 `null`（调用方随后重取即可，别拿它当前置条件）。 */
  version: number | null
}

/**
 * 一次请求里新建若干条目（笔记 / 标注）。
 *
 * 批量而非逐条：一次性授权（用户只点了「允许」）的 key 会被首个写请求消耗，
 * 把用户的这一次操作压进单个请求，才不会做一半就断。
 */
export async function createItems(objects: Record<string, unknown>[]): Promise<WrittenItem[]> {
  if (objects.length === 0) return []
  const { data } = await requestWrite<BatchResponse>('POST', '/items', { body: objects })
  const successful = data?.successful ?? {}
  const success = data?.success ?? {}
  const failed = data?.failed ?? {}
  const failedAt = Object.keys(failed)
  if (failedAt.length > 0) {
    const why = failedAt.map((index) => briefFailure(failed[index])).filter((text) => text !== '').join('；')
    throw new ZoteroError('bad_request', `Zotero 拒绝了这次新建${why ? `：${why}` : '。'}`)
  }
  return objects.map((_, index) => {
    const created = successful[String(index)]
    const key = typeof created?.key === 'string' ? created.key : success[String(index)]
    if (typeof key !== 'string' || key === '') {
      throw new ZoteroError('internal_error', 'Zotero 建成了条目但没回 key，无法继续。')
    }
    return { key, version: positiveInt(created?.version) }
  })
}

/**
 * 局部更新一个条目。
 *
 * 只用 PATCH：PUT 会把 `data` 里未提交的既有字段静默移除。
 * 响应是 `204` 无正文，因此不回条目版本；调用方写完重取详情即可。
 */
export async function patchItem(key: string, patch: Record<string, unknown>, version: number): Promise<void> {
  await requestWrite('PATCH', `/items/${encodeURIComponent(key)}`, { body: patch, version })
}

/**
 * 删除一个条目。
 *
 * 实测是**硬删**（不进回收站、无法撤销），调用方必须自己做二次确认，
 * 且失败时不得自动重试到底——412 意味着库里内容已变，硬删旧目标可能删错东西。
 */
export async function deleteItem(key: string, version: number): Promise<void> {
  await requestWrite('DELETE', `/items/${encodeURIComponent(key)}`, { version })
}
