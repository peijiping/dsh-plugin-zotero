/**
 * 客户端 bundle 构建：产出 `client/client.js`（CJS + `__ModuleLoader__` 外壳）。
 *
 * 浏览器侧只认 `client/client.js` 这个文件名与 `<id>` 包名，因此外壳由
 * tsdown 的 banner/footer 直接拼出（与 dshmarket 的 normalize 脚本等效，
 * 但无需额外脚本），并用 outExtensions 强制 `.js` 后缀。
 */

import { defineConfig } from 'tsdown'

/** 宿主冻结模块表在运行期提供的模块；一律 external，不打进 bundle。 */
const CLIENT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** 外壳 id 必须与 package.json 的 name 一致。 */
const LOADER_ID = 'dsh-plugin-zotero'

const LOADER_OPEN =
  `window.__ModuleLoader__.load({ id: "${LOADER_ID}", factory: (require) => {\n` +
  'var module = { exports: {} };\n' +
  'var exports = module.exports;'

const LOADER_CLOSE = 'return module.exports;\n} });'

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  tsconfig: 'tsconfig.client.json',
  deps: { neverBundle: CLIENT_EXTERNALS },
  outExtensions: () => ({ js: '.js' }),
  banner: LOADER_OPEN,
  footer: LOADER_CLOSE,
})
