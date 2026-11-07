/**
 * 笔记的写操作：新建 / 编辑 / 删除。
 *
 * 三条规矩各有出处：
 *
 * 1. **只发 PATCH**。PUT 会把 `data` 里未提交的既有字段静默移除（本地 API 参考 §更新），
 *    笔记虽然只有一个正文字段，但作者、日期、key 都由 Zotero 维护，不值得冒险。
 * 2. **不做正文规范化**。含引文（`class="citation"`）与标注反链（`data-annotation`）的
 *    笔记也能编辑：调用方给什么就写什么，锚点原样往返。风险提示交给界面（`note.anchored`），
 *    写入口不再一刀切拒绝——那会让「只想改一句话」的笔记连门都进不去。
 * 3. **并发前置条件用调用方给的版本**。比版本号新旧更靠谱的是 Zotero 自己的 412。
 */

import { ZoteroError } from './client.js'
import { createItems, deleteItem, patchItem } from './write.js'
import type { ZoteroWriteRef } from './types.js'

/** 单条笔记正文的字节上限（面板与模型工具同受此约束）。 */
const NOTE_MAX_WRITE_BYTES = 512 * 1024

/**
 * 正文里的脚本载体。
 *
 * 只**拒绝**、不静默剥离：静默改写用户刚写的内容，比告诉他「这段不能存」更难排查。
 * 这三条都不是全局正则（无 `g`），免得 `lastIndex` 在多次调用间串味。
 */
const BLOCKED_TAGS = /<\s*\/?\s*(?:script|style|iframe|object|embed|form|base|link|meta|noscript)\b/iu
const EVENT_ATTR = /\son[a-z]+\s*=/iu
const SCRIPT_URL = /\s(?:href|src)\s*=\s*["']?\s*javascript:/iu

function assertNoteBody(html: string): void {
  if (html.trim() === '') {
    throw new ZoteroError('bad_request', '笔记正文是空的：要清掉这条笔记请用删除。')
  }
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > NOTE_MAX_WRITE_BYTES) {
    throw new ZoteroError('bad_request', `笔记正文约 ${Math.round(bytes / 1024)} KB，超出 ${NOTE_MAX_WRITE_BYTES / 1024} KB 上限，请拆成几条。`)
  }
  if (BLOCKED_TAGS.test(html) || EVENT_ATTR.test(html) || SCRIPT_URL.test(html)) {
    throw new ZoteroError('bad_request', '笔记正文里有脚本类标签或事件属性（script / iframe / on…= 等），本插件不会把它写进文库。')
  }
}

/**
 * 在父条目下新建一条笔记。
 *
 * `note` 是 HTML 字符串：面板对新笔记会把纯文本按空行切成 `<p>`，因此这里不再加工。
 */
export async function createNote(input: { parentItem: string; note: string }): Promise<ZoteroWriteRef> {
  assertNoteBody(input.note)
  const [created] = await createItems([{ itemType: 'note', parentItem: input.parentItem, note: input.note }])
  if (created === undefined) {
    throw new ZoteroError('internal_error', 'Zotero 建成了笔记但没回结果，请刷新详情确认。')
  }
  return { key: created.key, version: created.version }
}

/** 替换一条笔记的正文。正文原样落库，锚点不做任何改写。 */
export async function updateNote(input: { key: string; version: number; note: string }): Promise<void> {
  assertNoteBody(input.note)
  await patchItem(input.key, { note: input.note }, input.version)
}

/** 删除一条笔记。**硬删**，不进 Zotero 回收站，撤销不了。 */
export async function deleteNote(input: { key: string; version: number }): Promise<void> {
  await deleteItem(input.key, input.version)
}
