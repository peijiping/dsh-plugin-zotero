/**
 * 网页快照：`GET /dsh-zotero/snapshot/<附件key>/[子路径]`。
 *
 * 与 `/api/file` 分开的两条硬理由：HTML 要注入桥接脚本（字节数变了，和 PDF 的
 * Range 语义没法共存），且它需要一套自己的 CSP 把文档锁进沙箱。
 *
 * 安全边界（三层，任一层单独都够用）：
 *   1. iframe 带 `sandbox="allow-scripts"`，不给 `allow-same-origin` → origin 是
 *      opaque，脚本摸不到父页面，也带不上本机 API 的同源凭据；
 *   2. 这里的 `sandbox allow-scripts` 指令让上述限制**不依赖** iframe 属性；
 *   3. `default-src 'none'` 关掉一切外连，图片/字体只放 `data:` 与 `blob:`。
 *
 * 代价是相对路径资源加载不了（SingleFile 快照自包含，可接受）。子路径分支保留
 * 下来是为了将来放开 CSP 时不用再改路由。
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as zotero from '../zotero/client.js'
import { SNAPSHOT_INJECT_MAX_BYTES, SNAPSHOT_ROUTE_PREFIX } from '../zotero/config.js'
import { isTrusted, KEY_PATTERN } from './router.js'

/** `lib/host/snapshot.js` → 包根 `client/snapshot/runtime.js`。 */
const RUNTIME_PATH = fileURLToPath(new URL('../../client/snapshot/runtime.js', import.meta.url))

/** 快照文档的 CSP：能跑内联脚本，但一个字节都出不了回环之外。 */
const SNAPSHOT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
].join('; ')

const HTML_MIME = new Set(['text/html', 'application/xhtml+xml'])

/** 子资源可能出现的类型；未知扩展名一律 octet-stream（配合 nosniff）。 */
const SUB_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
}

/** 只认这几种字符集：它们既能在 Node 侧原样透传，也不会被浏览器误解。 */
const CHARSET_ALLOW = new Set([
  'utf-8',
  'utf8',
  'gbk',
  'gb2312',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'iso-8859-1',
  'windows-1252',
])

/** 资源路由回纯文本：iframe 里出现一段 JSON 错误信封毫无意义。 */
function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

interface Target {
  key: string
  /** 空串表示「这个附件自己的文件」。 */
  relative: string
}

/** 解析 `/snapshot/<key>/<rel>`；非法一律 null（调用方回 404，不回 400）。 */
function parseTarget(pathname: string): Target | null {
  if (!pathname.startsWith(SNAPSHOT_ROUTE_PREFIX)) return null
  const rest = pathname.slice(SNAPSHOT_ROUTE_PREFIX.length)
  const slash = rest.indexOf('/')
  const key = slash === -1 ? rest : rest.slice(0, slash)
  if (!KEY_PATTERN.test(key)) return null
  if (slash === -1) return { key, relative: '' }

  const raw = rest.slice(slash + 1)
  if (raw === '') return { key, relative: '' }
  let relative: string
  try {
    relative = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (relative.includes('\\') || relative.includes('\0')) return null
  const segments = relative.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  // 隐藏文件（.zotero-ft-cache 是用户全文、.zotero-reader-state 是阅读位置）没有暴露理由。
  if (segments.some((segment) => segment.startsWith('.'))) return null
  return { key, relative }
}

function mimeOf(contentType: string, filename: string): string {
  const declared = contentType.split(';')[0].trim().toLowerCase()
  if (declared !== '') return declared
  return SUB_MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/** 附件是否是可渲染的网页快照。 */
function isHtml(contentType: string, filename: string): boolean {
  return HTML_MIME.has(mimeOf(contentType, filename)) || /\.x?html?$/iu.test(filename)
}

/** 从文件头找字符集；找不到就让浏览器按 meta 自己嗅探。 */
function detectCharset(head: string): string | null {
  const match = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)/iu.exec(head)
  const value = match?.[1]?.toLowerCase()
  if (value === undefined || !CHARSET_ALLOW.has(value)) return null
  return value === 'utf8' ? 'utf-8' : value
}

/**
 * 桥接脚本的插入位置。
 *
 * 必须在 charset meta **之后**：插在它前面会把 meta 推到 1024 字节嗅探窗口之外，
 * GBK 快照就会变乱码。同时也必须在快照自己的脚本之前 —— 要先把 storage shim
 * 装上，否则有状态管理的页面第一行 `localStorage.getItem` 就抛异常。
 */
function injectionPoint(buffer: Buffer): number {
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1')
  const lower = head.toLowerCase()
  const patterns = [/<meta[^>]*charset[^>]*>/u, /<head[^>]*>/u, /<html[^>]*>/u]
  for (const pattern of patterns) {
    const match = pattern.exec(lower)
    if (match !== null) return match.index + match[0].length
  }
  return 0
}

/**
 * 读桥接脚本。
 *
 * **故意不缓存**：`client/snapshot/runtime.js` 是构建产物，改了脚本只想让用户刷新
 * 一下页面就生效。进程级缓存会让「旧的脚本 + 新的界面」这种组合静默存在——旧脚本
 * 不带点击矩形，编辑卡片就只能退到左上角，排查起来极费劲。22 KB 的读盘一次请求
 * 一次，代价可以忽略。
 */
async function loadRuntime(): Promise<string | null> {
  try {
    return await readFile(RUNTIME_PATH, 'utf8')
  } catch (error) {
    // 构建没跑 copy 脚本时退化：页面照样能看，只是没有高亮。
    console.warn('[dsh-plugin-zotero] 快照桥接脚本缺失，网页高亮不可用：', error)
    return null
  }
}

/** 包成内联 classic `<script>`；内容必须纯 ASCII，才经得起 latin1 拼接。 */
function bridgeTag(script: string): string {
  return `<script data-dsh-zotero-bridge>${script.replace(/<\/script/giu, '<\\/script')}</script>`
}

/** 读回完整文档 → 注入 → 一次性送出。 */
async function sendDocument(res: ServerResponse, path: string, size: number): Promise<void> {
  const runtime = size <= SNAPSHOT_INJECT_MAX_BYTES ? await loadRuntime() : null
  if (runtime === null) {
    // 过大或脚本缺失：不注入，流式送出。前端会提示「高亮不可用」。
    // 这种情形极少（>32 MB），字符集交给浏览器按 meta 嗅探即可。
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-length': size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': SNAPSHOT_CSP,
      'x-dsh-zotero-snapshot': 'un-injected',
    })
    const stream = createReadStream(path)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  let body: Buffer
  let charset: string
  try {
    const buffer = await readFile(path)
    charset = detectCharset(buffer.subarray(0, 4096).toString('latin1')) ?? 'utf-8'
    const at = injectionPoint(buffer)
    body = Buffer.concat([
      buffer.subarray(0, at),
      Buffer.from(bridgeTag(runtime), 'latin1'),
      buffer.subarray(at),
    ])
  } catch (error) {
    console.warn('[dsh-plugin-zotero] 读取快照失败：', error)
    fail(res, 500, '快照读不出来')
    return
  }

  res.writeHead(200, {
    'content-type': `text/html; charset=${charset}`,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': SNAPSHOT_CSP,
  })
  res.end(body)
}

/** 子资源：同目录下按相对路径取，路径穿越与隐藏文件已在 {@link parseTarget} 挡掉。 */
async function sendAsset(res: ServerResponse, path: string, size: number): Promise<void> {
  const ext = extname(path).toLowerCase()
  res.writeHead(200, {
    'content-type': SUB_MIME[ext] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': SNAPSHOT_CSP,
  })
  const stream = createReadStream(path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

export function createSnapshotHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    // HEAD 也放行：Node 会自动省掉 body，便于用 curl -I 之类核对响应头。
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(res, 405, '仅支持 GET')
      return
    }
    if (!isTrusted(req)) {
      fail(res, 403, '拒绝非回环来源的请求')
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const target = parseTarget(url.pathname)
    if (target === null) {
      fail(res, 404, '未知快照')
      return
    }

    let file
    try {
      file = await zotero.getAttachmentFile(target.key)
    } catch {
      fail(res, 404, '快照不存在')
      return
    }
    if (!isHtml(file.contentType, file.filename)) {
      fail(res, 415, `不是网页快照：${file.contentType || file.filename}`)
      return
    }

    // 主文档：这个附件自己的文件。
    if (target.relative === '') {
      await sendDocument(res, file.path, file.size)
      return
    }

    const root = dirname(file.path)
    const full = resolve(root, target.relative)
    if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) {
      fail(res, 404, '未知快照资源')
      return
    }
    let stats
    try {
      stats = await stat(full)
    } catch {
      fail(res, 404, '快照资源不存在')
      return
    }
    if (!stats.isFile()) {
      fail(res, 404, '快照资源不存在')
      return
    }
    await sendAsset(res, full, stats.size)
  }
}
