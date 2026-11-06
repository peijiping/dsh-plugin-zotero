/**
 * PDF.js 静态资产：`GET /dsh-zotero/static/*`。
 *
 * 只服务 `client/pdfjs/` 下的白名单内容（Worker、cmaps、标准字体、wasm），
 * 不做通用静态服务器。路径在 `path.resolve` 后必须仍落在资产根内，
 * 因此 `..`、绝对路径、跨平台分隔符都穿不出去。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { STATIC_ROUTE_PREFIX } from '../zotero/config.js'
import { isTrusted } from './router.js'

/** `lib/host/static.js` → 包根 `client/pdfjs/`。 */
const ASSET_ROOT = fileURLToPath(new URL('../../client/pdfjs/', import.meta.url))

/** 白名单：根下单个 Worker 文件 + 三个资产目录。 */
const ALLOWED_DIRECTORIES = ['cmaps/', 'standard_fonts/', 'wasm/']
const ALLOWED_FILES = new Set(['pdf.worker.min.mjs', 'pdf.worker.mjs'])

const MIME: Record<string, string> = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/x-font-type1',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttc': 'font/collection',
  '.icc': 'application/vnd.iccprofile',
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

/** 校验并还原相对路径；非法返回 null。 */
function relativePath(pathname: string): string | null {
  if (!pathname.startsWith(STATIC_ROUTE_PREFIX)) return null
  let relative: string
  try {
    relative = decodeURIComponent(pathname.slice(STATIC_ROUTE_PREFIX.length))
  } catch {
    return null
  }
  if (relative === '' || relative.includes('\\') || relative.includes('\0')) return null
  const segments = relative.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  if (!ALLOWED_FILES.has(relative) && !ALLOWED_DIRECTORIES.some((prefix) => relative.startsWith(prefix))) {
    return null
  }
  return relative
}

export function createStaticHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      fail(res, 405, '仅支持 GET')
      return
    }
    if (!isTrusted(req)) {
      fail(res, 403, '拒绝非回环来源的请求')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const relative = relativePath(url.pathname)
    if (relative === null) {
      fail(res, 404, '未知静态资源')
      return
    }
    const full = resolve(ASSET_ROOT, relative)
    if (!full.startsWith(ASSET_ROOT.endsWith(sep) ? ASSET_ROOT : ASSET_ROOT + sep)) {
      fail(res, 404, '未知静态资源')
      return
    }
    let stats
    try {
      stats = await stat(full)
    } catch {
      fail(res, 404, '静态资源不存在')
      return
    }
    if (!stats.isFile()) {
      fail(res, 404, '静态资源不存在')
      return
    }

    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stats.size,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    })
    const stream = createReadStream(full)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}
