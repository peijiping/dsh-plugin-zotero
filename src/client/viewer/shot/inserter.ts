/**
 * 宿主图片附件 API 的唯一收口。
 *
 * 插件现有「加入对话」全是纯文本 chip；图片走的是另一条宿主内部通道：
 * `conversation.createDrafts` → `inputActions.addAttachments` → `captureInsertion`
 * → `slash/input-insert-reference`。第 0 步 Spike 已端到端实跑通过。
 *
 * 三条实测得到的硬约束（改动前先读）：
 * 1. `ctx.get('conversation')` **只能在用户点击回调里惰性取** —— apply 同步阶段
 *    服务未 ACTIVE；写进 `inject` 会让 fiber 永久 PENDING、apply 静默不执行。
 * 2. `addAttachments` 返回 `boolean`：`frozen(phase)` 时 false 且**静默失败**，
 *    必须检查，失败时不要插 chip。
 * 3. `uploadImages=false`（内联 base64）链路最短，不依赖上传状态机 / receipt 校验。
 *
 * 全流程同步执行：`captureInsertion()` 之后不能夹任何 await，否则 draftRev CAS 失配。
 */

import type { InputActions, InsertOutcome } from '../../inline'
import type { Translate } from '../../locales'
import { shotChipLabel } from '../../compose'
import { insertChip, shotReference, type SessionsFace } from '../../reference'
import { shotFileName, type ShotMeta } from './types'

/** 宿主 `ConversationController.createDrafts` 的最小镜像。 */
interface ComposerAttachment {
  id: string
}

interface ConversationFace {
  createDrafts(
    sessionId: string,
    files: File[],
    uploadImages: boolean,
  ): readonly ComposerAttachment[]
}

export interface ShotInsertDeps {
  t: Translate
  sessions: SessionsFace
  sessionId: string | undefined
  inputActions: InputActions | undefined
  /** 惰性取数：由插件入口闭包提供，不在 apply 期缓存实例。 */
  getConversation(): unknown
}

function asConversation(value: unknown): ConversationFace | null {
  if (value === null || typeof value !== 'object') return null
  const candidate = value as { createDrafts?: unknown }
  return typeof candidate.createDrafts === 'function' ? value as ConversationFace : null
}

/**
 * 把一张 PNG 和它的一枚出处 chip 一起放进当前会话草稿。
 *
 * 发送时宿主会组装成 `[{type:'image',…}, {type:'text',…}]` 一次 prompt，
 * 图文同条消息；用户可在发送前单独删掉缩略图或 chip（图内水印条仍带出处）。
 */
export function insertShotToConversation(
  deps: ShotInsertDeps,
  png: Blob,
  meta: ShotMeta,
): InsertOutcome {
  const { t, sessions, sessionId, inputActions } = deps
  if (inputActions === undefined) return 'no-editor'
  if (typeof inputActions.addAttachments !== 'function') return 'no-conversation'
  const conversation = asConversation(deps.getConversation())
  if (conversation === null || sessionId === undefined) return 'no-conversation'

  let drafts: readonly ComposerAttachment[]
  try {
    drafts = conversation.createDrafts(
      sessionId,
      [new File([png], shotFileName(meta), { type: 'image/png' })],
      false,
    )
  } catch {
    return 'no-conversation'
  }
  const ids = drafts.map((draft) => draft.id).filter((id) => typeof id === 'string' && id !== '')
  if (ids.length === 0) return 'no-conversation'

  // 附件没进 input state 时不要插 chip：否则输入框里出现一枚指向不存在图片的说明。
  if (inputActions.addAttachments(ids) === false) return 'attachment-rejected'

  const span = inputActions.captureInsertion()
  let reference
  try {
    reference = shotReference(meta, shotChipLabel(t, meta))
  } catch {
    return 'ref-too-long'
  }
  return insertChip(sessions, sessionId, reference, span) ? 'inserted' : 'draft-changed'
}
