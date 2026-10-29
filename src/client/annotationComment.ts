/**
 * 标注评论的解析。
 *
 * Zotero 阅读器把评论里的加粗/斜体/上下标存成**字面量标签文本**
 * （`<b>` / `<i>` / `<sub>` / `<sup>`），换行是真实换行符；这不是可注入的 HTML。
 * 这里按白名单切成 token，交给 React 渲染，白名单外的尖括号原样当文本。
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
    tokens.push({ kind: 'text', text, bold: bold > 0, italic: italic > 0, sub: sub > 0, sup: sup > 0 })
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
  return comment.replace(tagRegex(), ' ').replace(/\s+/gu, ' ').trim()
}

/** 是否有可显示的内容（纯空白不算）。 */
export function hasComment(comment: string): boolean {
  return commentPlain(comment) !== ''
}
