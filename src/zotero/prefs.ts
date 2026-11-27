/**
 * 读 Zotero 的 `prefs.js`。
 *
 * 为什么要读它：相对路径的链接附件（`attachments:papers/x.pdf`）在本地 API 的
 * `links.enclosure` 里拿不到绝对路径——补全基础目录这一步只发生在 Zotero 进程内。
 * 结果是「Zotero 里打开正常，插件里 404」，最容易被当成插件 bug。
 * 本地 API 不暴露 prefs，`prefs.js` 是唯一可靠来源。
 *
 * 这里只解析键值，具体挑哪些键由 `parsePrefs`（路径）与 `publicationTags.ts`
 * （期刊标签列配置）各自决定；读不到就当没设置，不影响既有行为。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { profileDirs } from './profile.js'

/** 从 prefs 里能拿到的路径设置。 */
export interface ZoteroPaths {
  /** 链接附件的基础目录；未设置为空串。 */
  baseAttachmentPath: string
  /** 数据目录；未设置为空串（此时 Zotero 用默认的 `~/Zotero`）。 */
  dataDir: string
}

const NO_PATHS: ZoteroPaths = { baseAttachmentPath: '', dataDir: '' }

/** pref 键 → 字段。只认这两个：其余键读了也没用。 */
const WANTED: ReadonlyArray<readonly [string, keyof ZoteroPaths]> = [
  ['extensions.zotero.baseAttachmentPath', 'baseAttachmentPath'],
  ['extensions.zotero.dataDir', 'dataDir'],
]

/**
 * 解析 `prefs.js` 里的全部 `user_pref("key", value);`。
 *
 * Zotero 的值部分是 JSON 字面量（字符串带引号与转义），直接交给 `JSON.parse`
 * 比手写反转义可靠。只给需要具体键的调用方挑，不在这一层做语义判断。
 */
export function parsePrefValues(text: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line.startsWith('user_pref(')) continue
    const match = /^user_pref\(\s*"([^"]+)"\s*,\s*(.+?)\s*\);\s*$/u.exec(line)
    if (match === null) continue
    try {
      out.set(match[1] ?? '', JSON.parse(match[2] ?? ''))
    } catch {
      continue
    }
  }
  return out
}

/** 只取路径设置：其余 pref 一律忽略，调用方另有需要时走 `parsePrefValues`。 */
export function parsePrefs(text: string): ZoteroPaths {
  const paths: ZoteroPaths = { ...NO_PATHS }
  for (const [key, value] of parsePrefValues(text)) {
    const field = WANTED.find(([name]) => name === key)?.[1]
    if (field !== undefined && typeof value === 'string') paths[field] = value
  }
  return paths
}

/** 上一次读取的缓存：同一次会话里 prefs 几乎不变，别每次请求都读盘。 */
let cached: { stamp: string; paths: ZoteroPaths } | null = null

/**
 * 本机 Zotero 的路径设置；读不到时返回空值（调用方按「未设置」处理）。
 *
 * 多 profile 时取第一个能读到的 `prefs.js`：Zotero 同一时间只跑一个 profile，
 * 而找错 profile 的最坏后果也只是「基础目录为空」→ 退回原来的报错路径。
 */
export async function readZoteroPaths(): Promise<ZoteroPaths> {
  for (const dir of await profileDirs()) {
    const file = join(dir, 'prefs.js')
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    const stamp = `${file}:${info.mtimeMs}:${info.size}`
    if (cached !== null && cached.stamp === stamp) return cached.paths
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const paths = parsePrefs(text)
    cached = { stamp, paths }
    return paths
  }
  return NO_PATHS
}
