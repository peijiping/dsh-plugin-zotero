/**
 * 把 PDF.js 运行时资产从 node_modules 拷到 `client/pdfjs/`。
 *
 * `client/` 是构建产物目录（已 gitignore），Host 的静态路由从这里读取：
 * - `pdf.worker.min.mjs`：Worker 脚本，由客户端设置 `GlobalWorkerOptions.workerSrc`；
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

await cp(join(source, 'build', 'pdf.worker.min.mjs'), join(target, 'pdf.worker.min.mjs'))
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  await cp(join(source, directory), join(target, directory), { recursive: true })
}
