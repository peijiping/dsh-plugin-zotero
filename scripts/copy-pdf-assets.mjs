/**
 * 把 PDF.js 运行时资产从 node_modules 拷到 `client/pdfjs/`。
 *
 * `client/` 是构建产物目录（已 gitignore），Host 的静态路由从这里读取：
 * - `pdf.worker.min.mjs`：Worker 脚本（legacy 构建，内置 core-js polyfill，
 *   与主包的 `legacy/build/pdf.mjs` 配套），由客户端设置
 *   `GlobalWorkerOptions.workerSrc`；
 * - `pdf_viewer.css`：pdf.js 官方 Viewer 的页面/文本层样式；
 * - `images/`：`pdf_viewer.css` 引用的图标；
 * - `cmaps/`：CJK 编码表，中文 PDF 缺了会乱码；
 * - `standard_fonts/`：PDF 内置标准字体；
 * - `wasm/`：JPX / ICC 等可选解码器。
 *
 * 每次构建都先清空目标目录，避免 pdfjs 升级后残留旧文件。
 */

import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'node_modules', 'pdfjs-dist')
const target = join(root, 'client', 'pdfjs')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

await cp(join(source, 'legacy', 'build', 'pdf.worker.min.mjs'), join(target, 'pdf.worker.min.mjs'))
await cp(join(source, 'web', 'pdf_viewer.css'), join(target, 'pdf_viewer.css'))
for (const directory of ['web/images', 'cmaps', 'standard_fonts', 'wasm']) {
  await cp(join(source, directory), join(target, directory.replace(/^web\//u, '')), { recursive: true })
}
