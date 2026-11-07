/**
 * 笔记的写操作：新建 / 编辑 / 删除。
 *
 * 三条规矩各有出处：
 *
 * 1. **只发 PATCH**。PUT 会把 `data` 里未提交的既有字段静默移除（本地 API 参考 §更新），
 *    笔记虽然只有一个正文字段，但作者、日期、key 都由 Zotero 维护，不值得冒险。
 * 2. **含结构锚点的笔记拒绝编辑**。引文（`class="citation"`）与「添加至笔记」生成的
 *    标注反链（`data-annotation`）靠属性回指库里的对象；任何一进一出的规范化都可能
 *    让它们失联，所以在写入口再挡一次，而不只靠面板隐藏按钮。删除不受影响。
 * 3. **并发前置条件用调用方给的版本**。编辑前确实会重读一次当前正文（为了查锚点），
 *    但拿那个新版本去写等于覆盖 Zotero 侧刚发生的改动，因此只读不采信。
 */

import { getNoteRaw, hasZoteroAnchors, ZoteroError } from './client.js'
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

/** 替换一条笔记的正文。锚点笔记在这里会被挡下。 */
export async function updateNote(input: { key: string; version: number; note: string }): Promise<void> {
  assertNoteBody(input.note)
  // 目标已不存在时这里就抛 404，不会白跑一次 PATCH。
  const current = await getNoteRaw(input.key)
  if (hasZoteroAnchors(current.html)) {
    throw new ZoteroError(
      'bad_request',
      '该笔记含 Zotero 的引文或标注锚点，改正文会让它们失联；可以删除，但不能在这里编辑。',
    )
  }
  await patchItem(input.key, { note: input.note }, input.version)
}

/** 删除一条笔记。**硬删**，不进 Zotero 回收站，撤销不了。 */
export async function deleteNote(input: { key: string; version: number }): Promise<void> {
  await deleteItem(input.key, input.version)
}
