/**
 * 破坏性写操作的对话框审批（Host 半）。
 *
 * 为什么不用插件面板自己弹确认框：删除是**模型发起的工具调用**，用户唯一在意的
 * 地方是对话流本身。宿主 `@deepseek-ai/dsh-user-approval` 已提供 `ctx.approval`
 * 服务，执行前暂停、在对话框输入区上方弹卡片（允许一次 / 拒绝 / 始终允许），
 * 拒绝就不执行；无需本插件造 UI，也不用注入新的 client 组件。
 *
 * 这里的接口都是最小结构面：审批服务由宿主装配，不在本包的类型面内。
 * 设计上 **fail closed** —— 拿不到审批服务 / 没有 agent / 任何非 allowed-once
 * 的结果一律中止写操作，绝不「审批失败就照删」。
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
  exec: ApprovalExec,
  toolName: string,
  text: ApprovalText,
): Promise<void> {
  const approval = (ctx as unknown as { approval?: ApprovalServiceLike }).approval
  if (approval === undefined) {
    throw new Error('宿主未提供审批服务，无法安全地执行此操作，已中止（Zotero 未被改动）。')
  }
  if (exec.agent === undefined) {
    throw new Error('这次工具调用没有携带 agent，无法请求审批，已中止（Zotero 未被改动）。')
  }

  const req: ApprovalRequestLike = {
    agent: exec.agent,
    toolName,
    reason: text.zh,
    displayReason: { en: text.en, zh: text.zh },
  }
  if (exec.callId !== undefined) req.callId = exec.callId
  if (exec.signal !== undefined) req.signal = exec.signal

  let outcome: unknown
  try {
    outcome = await approval.request(req)
  } catch (error) {
    throw new Error(`审批请求失败，已中止：${error instanceof Error ? error.message : String(error)}`)
  }
  if (outcome !== ALLOWED) throw new Error(refusalText(outcome))
}
