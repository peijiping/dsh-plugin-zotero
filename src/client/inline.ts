/**
 * 往会话输入框草稿插入文本。
 *
 * `inputActions` 由 ui-conversation 通过 `uiSession.provide` 作为会话级标准
 * prop 下发；`insertText` 要求 span 里的 draftRev 未变，因此**必须先
 * captureInsertion()、后取（可能异步的）文本、再 insertText()**。
 */

export interface InsertionSpan {
  start: number
  end: number
  draftRev: number
}

export interface InputActions {
  captureInsertion(): InsertionSpan
  insertText(text: string, span: InsertionSpan): boolean
}

/** 插入结果：失败原因用于提示用户。 */
export type InsertOutcome = 'inserted' | 'no-editor' | 'draft-changed'

/**
 * 捕获草稿当前位置，再构建文本并插入。
 *
 * @param actions 面板从 props 拿到的 `inputActions`（缺失表示不在会话上下文）
 * @param build 文本构建器；在捕获之后才执行，允许异步取数据
 */
export async function insertBuilt(
  actions: InputActions | undefined,
  build: () => string | Promise<string>,
): Promise<InsertOutcome> {
  if (!actions) return 'no-editor'
  const span = actions.captureInsertion()
  const text = await build()
  return actions.insertText(text, span) ? 'inserted' : 'draft-changed'
}
