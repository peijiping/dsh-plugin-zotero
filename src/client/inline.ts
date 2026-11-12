/**
 * 会话输入框的插入动作（只声明本插件用到的子集）。
 *
 * `inputActions` 由 ui-conversation 通过 `uiSession.provide` 作为会话级标准
 * prop 下发。本插件所有引用（条目 / 目录 / 笔记 / 标注 / 标签 / 划选摘录）都走
 * chip 路径：只取 `captureInsertion()` 的 span，连同 ReferenceInsert 一起派给
 * 会话事件 `slash/input-insert-reference`（见 reference.ts）。
 *
 * 宿主另有 `insertText(text, span)`，早期用它把摘录灌成一大段纯文本，已废弃：
 * 别再走回这条路。span 里的 `draftRev` 是插入时的草稿版本校验，取到 span 后
 * 必须立刻插入，中间不能夹异步取数。
 */

export interface InsertionSpan {
  start: number
  end: number
  draftRev: number
}

export interface InputActions {
  captureInsertion(): InsertionSpan
  /**
   * 挂图片附件（宿主完整 `shell.actions` 里的一枚，本插件只声明用到的两个）。
   *
   * **实测返回 `boolean`**：`frozen(phase)`（发送中 / 裁决中）会 false 且静默失败，
   * 附件不进 input state。调用方必须检查，不要把它当 void。
   */
  addAttachments?(ids: readonly string[]): boolean
}

/** 插入结果：失败原因用于提示用户。 */
export type InsertOutcome =
  | 'inserted'
  | 'no-editor'
  | 'draft-changed'
  /** 宿主 conversation 服务取不到 / 未就绪（只能惰性 `ctx.get`）。 */
  | 'no-conversation'
  /** `addAttachments` 返回 false（发送中 / 裁决中）。 */
  | 'attachment-rejected'
  /** 当前模型不支持图片输入，宿主发送时拒绝；草稿可恢复。 */
  | 'model-no-image'
  /** `shot:` ref 超过编码后长度上限。 */
  | 'ref-too-long'
