/**
 * 从会话历史的引用文本反查条目 key（纯函数，可单独测试）。
 *
 * 老会话的胶囊没有结构化的节点数据，只能从展开后的引用首行解析，所以这里
 * 只依赖文本格式，不碰 React 与宿主 UI 原语。
 */

/** Zotero key 的字母表（排除易混淆的 0 / 1 / O），与宿主 KEY_PATTERN 一致。 */
const ITEM_KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/u

/**
 * 条目类引用的第一行都带 key，目录 / 标签没有。
 * key 必是 `｜KEY｜` / `｜KEY】` 这样的独立段——只认整段，避免标题里的连续大写字误判。
 */
export function itemKeyOf(body: string): string | null {
  const first = body.trimStart().split('\n', 1)[0] ?? ''
  // 目录引用的也是 8 位 key，但那是 collectionKey，开条目 tab 会落空。
  if (first.includes('Zotero 目录') || first.includes('Zotero collection')) return null
  for (const part of first.split(/[｜】]/u)) {
    const token = part.match(ITEM_KEY_PATTERN)?.[0]
    if (token !== undefined) return token
  }
  return null
}
