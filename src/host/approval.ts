/**
 * 破坏性写操作的对话框审批（Host 半）。
 *
 * 为什么不用插件面板自己弹确认框：删除是**模型发起的工具调用**，用户唯一在意的
 * 地方是对话流本身。宿主 `@deepseek-ai/dsh-user-approval` 已提供 approval
 * 服务，执行前暂停、在对话框输入区上方弹卡片（允许一次 / 拒绝 / 始终允许），
 * 拒绝就不执行；无需本插件造 UI，也不用注入新的 client 组件。
 *
 * 这里的接口都是最小结构面：审批服务由宿主装配，不在本包的类型面内。
 * 设计上 **fail closed** —— 拿不到审批服务 / 没有 agent / 任何非 allowed-once
 * 的结果一律中止写操作，绝不「审批失败就照删」。
 *
 * **取服务必须走 `ctx.get('approval')`，不能用 `ctx.approval`。** cordis 的
 * Context 是 Proxy：只有列进本 fiber `inject` 的服务名才能直接读，其余名字在
 * 属性读取那一刻就抛 `cannot get property "approval" without inject`，连
 * `undefined` 都拿不到。1.6.0 的 `mcp__zotero__trash_item` /
 * `delete_collection` / `remove_items_from_collection` 与
 * `zotero_delete_note` / `zotero_delete_annotation` 因此全部在审批环节崩掉，
 * 请求根本没到 Zotero。`reflect.get` 按服务名直读装配表、不要求 inject，也与
 * dsh-tools 内部 `serviceAsk` 的取法一致。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 宿主 ApprovalRequest 里本插件用得到的字段。 */
export interface ApprovalRequestLike {
  agent: unknown
  toolName: string
  callId?: unknown
  reason?: string
  displayReason?: Record<string, string>
  signal?: AbortSignal
}

/** 宿主审批服务的最小结构面。 */
export interface ApprovalServiceLike {
  request(req: ApprovalRequestLike): Promise<unknown>
}

/** 工具执行上下文（宿主 ToolRunContext）里本插件用得到的字段。 */
export interface ApprovalExec {
  /** 发起调用的 agent；审批服务靠它定位会话与 turn。 */
  agent?: unknown
  /** 关联已流式呈现的工具调用，审批卡片据此显示参数详情。 */
  callId?: unknown
  signal?: AbortSignal
}

/** 本地化确认文案。宿主的 displayReason 要求 en 键必填。 */
export interface ApprovalText {
  en: string
  zh: string
}

/** 宿主四种 outcome 里，只有这一种放行。 */
const ALLOWED = 'allowed-once'

/** 取不到审批服务时的统一文案（模型与用户都会看到）。 */
const NO_SERVICE =
  '宿主的审批通道不可用（没有装配 approval 服务），为安全起见未执行操作，Zotero 未被改动。' +
  '这不是条目的问题：请让用户在 Zotero 里手动完成删除，或重启 DSH 后再试。'

/**
 * 读宿主审批服务，取不到就返回 `undefined`（调用方据此 fail closed）。
 *
 * 见文件头：直接 `ctx.approval` 会抛 Proxy 错误，所以先走 `ctx.get`。
 * 两层兜底 —— `ctx.get` 本身不存在时退回直接读属性（并吞掉 Proxy 的抛错），
 * 保证任何宿主版本都只会得到「没有服务」，不会把一句 cordis 内部错误丢给模型。
 */
function readApproval(ctx: Context): ApprovalServiceLike | undefined {
  const candidate = ctx as unknown as {
    get?: (name: string) => unknown
    approval?: ApprovalServiceLike
  }
  // 连 `ctx.get` 的读取本身都在 try 里：它是 mixin 出来的 accessor，若宿主换了
  // 装配方式、连这个都没有，读取也会抛 Proxy 错误。
  let get: ((name: string) => unknown) | undefined
  try {
    const fn = candidate.get
    if (typeof fn === 'function') get = fn
  } catch {
    get = undefined
  }
  if (get !== undefined) {
    try {
      const service = get.call(candidate, 'approval')
      if (service !== undefined && service !== null) return service as ApprovalServiceLike
    } catch {
      // 服务还没装配好：当作没有，走下面的兜底。
    }
  }
  try {
    return candidate.approval
  } catch {
    return undefined
  }
}

function refusalText(outcome: unknown): string {
  switch (outcome) {
    case 'rejected': return '用户拒绝了本次操作，未改动 Zotero。'
    case 'cancelled': return '审批已取消，未改动 Zotero。'
    case 'unavailable': return '当前没有可用的审批应答器，为安全起见未执行操作，Zotero 未被改动。'
    default: return `审批未通过（${String(outcome)}），未改动 Zotero。`
  }
}

/**
 * 请求一次对话框审批；只有拿到 `allowed-once` 才返回，否则抛错让工具调用失败。
 *
 * `reason` 写进审计日志（纯文本），`displayReason` 给审批卡片做本地化展示。
 * `signal` 透传工具调用的取消信号：用户中途取消这次工具调用，审批一并作废。
 */
export async function requireApproval(
  ctx: Context,
  exec: ApprovalExec | undefined,
  toolName: string,
  text: ApprovalText,
): Promise<void> {
  const approval = readApproval(ctx)
  if (approval === undefined || typeof approval.request !== 'function') {
    throw new Error(NO_SERVICE)
  }
  // 离线冒烟/嵌套调度可能不给 exec：按「没有 agent」处理，同样 fail closed。
  const agent = exec?.agent
  const callId = exec?.callId
  const signal = exec?.signal
  if (agent === undefined) {
    throw new Error('这次工具调用没有携带 agent，无法请求审批，已中止（Zotero 未被改动）。')
  }

  const req: ApprovalRequestLike = {
    agent,
    toolName,
    reason: text.zh,
    displayReason: { en: text.en, zh: text.zh },
  }
  if (callId !== undefined) req.callId = callId
  if (signal !== undefined) req.signal = signal

  let outcome: unknown
  try {
    outcome = await approval.request(req)
  } catch (error) {
    throw new Error(`审批请求失败，已中止：${error instanceof Error ? error.message : String(error)}`)
  }
  if (outcome !== ALLOWED) throw new Error(refusalText(outcome))
}
