/**
 * 标注评论的解析。
 *
 * Zotero 阅读器把评论里的加粗/斜体/上下标存成**字面量标签文本**
 * （`<b>` / `<i>` / `<sub>` / `<sup>`），换行是真实换行符；这不是可注入的 HTML。
 * 这里按白名单切成 token，交给 React 渲染，白名单外的尖括号原样当文本。
 *
 * `parseComment` 与 `serializeComment` 互为逆运算：读的时候还原实体、写的时候再转义，
 * 评论在「Zotero ↔ 面板编辑器」之间走一个来回不会变样。
 */

export interface CommentToken {
  kind: 'text' | 'break'
  text: string
  bold: boolean
  italic: boolean
  sub: boolean
  sup: boolean
}

/** 只有这些标签有意义；属性不会出现，仍容忍以防手改。 */
const TAG_SOURCE = '<\\/?(?:b|i|sub|sup|br|div)\\b[^>]*>'

function tagRegex(): RegExp {
  return new RegExp(TAG_SOURCE, 'giu')
}

/**
 * 实体还原。
 *
 * Zotero 的评论框是个 contenteditable，存下来的就是 innerHTML：`<` `>` `&` 以实体形式
 * 存在。读的时候还原、写的时候再转义，一来一回才对称；只还原这一组命名实体，别的
 * （数字实体、生僻实体）原样当文本，免得把用户真写的 `&nbsp;` 之类吃掉。
 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/gu, (whole, name: string) => ENTITIES[name] ?? whole)
}

/** {@link decodeEntities} 的逆运算；标签由 serializeComment 自己拼，这里只管文本。 */
function escapeText(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** 评论 → 渲染 token；不平衡的闭合标签直接忽略。 */
export function parseComment(comment: string): CommentToken[] {
  const tokens: CommentToken[] = []
  let bold = 0
  let italic = 0
  let sub = 0
  let sup = 0
  let last = 0

  const pushText = (text: string): void => {
    if (text === '') return
    tokens.push({
      kind: 'text',
      text: decodeEntities(text),
      bold: bold > 0,
      italic: italic > 0,
      sub: sub > 0,
      sup: sup > 0,
    })
  }

  for (const match of comment.matchAll(tagRegex())) {
    const index = match.index ?? 0
    pushText(comment.slice(last, index))
    last = index + match[0].length

    const tag = match[0].toLowerCase()
    const closing = tag.startsWith('</')
    const name = tag.replace(/[</>\s]/gu, '')
    if (name === 'br' || name === 'div') {
      if (!closing) tokens.push({ kind: 'break', text: '', bold: false, italic: false, sub: false, sup: false })
      continue
    }
    const delta = closing ? -1 : 1
    if (name === 'b') bold = Math.max(0, bold + delta)
    else if (name === 'i') italic = Math.max(0, italic + delta)
    else if (name === 'sub') sub = Math.max(0, sub + delta)
    else if (name === 'sup') sup = Math.max(0, sup + delta)
  }
  pushText(comment.slice(last))

  // 去掉首尾换行 token，避免列表里多出空行。
  while (tokens[0]?.kind === 'break') tokens.shift()
  while (tokens[tokens.length - 1]?.kind === 'break') tokens.pop()
  return tokens
}

/** 去标签与换行，供插入草稿使用。 */
export function commentPlain(comment: string): string {
  return decodeEntities(comment.replace(tagRegex(), ' ')).replace(/\s+/gu, ' ').trim()
}

/** 是否有可显示的内容（纯空白不算）。 */
export function hasComment(comment: string): boolean {
  return commentPlain(comment) !== ''
}

/**
 * token 串 → Zotero 的字面量标签文本（{@link parseComment} 的逆运算）。
 *
 * 用途只有一个：把评论塞进 textarea 给用户改之前先归一化一遍。这样面板里看到的
 * 串一定是配平的、只含白名单标签，用户改完原样写回；Zotero 自己产出的评论本来就
 * 是这个形状，所以多数情况下这一步不改任何东西。
 * 嵌套顺序固定为 `b > i > sub > sup`，与解析时的标记顺序一致。
 */
export function serializeComment(tokens: CommentToken[]): string {
  let out = ''
  for (const token of tokens) {
    if (token.kind === 'break') {
      out += '<br>'
      continue
    }
    let text = escapeText(token.text)
    if (token.sup) text = `<sup>${text}</sup>`
    if (token.sub) text = `<sub>${text}</sub>`
    if (token.italic) text = `<i>${text}</i>`
    if (token.bold) text = `<b>${text}</b>`
    out += text
  }
  return out
}

/** 现有评论 → 编辑器初始值（归一化，不改变可见内容）。 */
export function commentForEditor(comment: string): string {
  return serializeComment(parseComment(comment))
}
