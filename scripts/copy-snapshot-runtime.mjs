/**
 * 把快照桥接脚本拷到 `client/snapshot/runtime.js`。
 *
 * `src/snapshot/runtime.js` 是纯 JS（不进 tsconfig、不被 tsdown 打包）：它跑在
 * 快照 iframe 里，必须是 classic script 且纯 ASCII。Host 侧
 * `src/host/snapshot.ts` 在响应时读这个产物并内联注入 HTML。
 *
 * 与 `copy-pdf-assets.mjs` 一样在 tsdown 之后运行 —— tsdown 会清空 `client/`。
 */

import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'client', 'snapshot')

await mkdir(target, { recursive: true })
await cp(join(root, 'src', 'snapshot', 'runtime.js'), join(target, 'runtime.js'))
