/**
 * dsh-plugin-zotero —— 插件入口（Host 半）。
 *
 * 只做一件事：把 Zotero 本地 API 包装成只读 HTTP 端点，挂在 DSH 自己的
 * web server 上（`/dsh-zotero/api/*`）。模型侧能力不在代码里，而由
 * `cordis.patch.yml` 插入的 `@deepseek-ai/dsh-mcp-client` 提供。
 *
 * `webServer` 的类型不在已安装的 dsh 包里，因此自定义最小结构接口并强转
 * （与社区插件 dshmarket 同法）。
 */

import type { Context } from '@deepseek-ai/cordis'

import { createHandler, type WebServerLike } from './host/router.js'
import { ROUTE_MATCH } from './zotero/config.js'

export const name = 'dsh-plugin-zotero'

export function apply(ctx: Context): void {
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const webServer = (hostCtx as unknown as { webServer: WebServerLike }).webServer
    const handler = createHandler()
    hostCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_MATCH, handler }),
      'dsh-plugin-zotero: http routes',
    )
  })
}
