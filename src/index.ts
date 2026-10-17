/**
 * dsh-plugin-zotero —— 插件入口（Host 半）。
 *
 * 做三件事：
 * 1. 把 Zotero 本地 API 包装成只读 HTTP 端点，挂在 DSH 自己的 web server 上
 *    （`/dsh-zotero/api/*`）。
 * 2. 自持集成 MCP 连接，把它的工具按配置过滤后注册进 dsh 工具表（公开名
 *    `mcp__zotero__*`）。dsh 自带的 `dsh-mcp-client` 不支持按工具开关，故
 *    `cordis.patch.yml` 里不再插入 `mcp-zotero` 行，模型侧由本插件负责。
 * 3. 导出 Schemastery `Config`（逐字段 `.volatile()`），让 dsh「插件」页能
 *    渲染本插件的配置表单；保存后无需重启即生效。
 *
 * `webServer` / `tools` 的类型不在已安装的 dsh 包里，因此自定义最小结构接口并
 * 强转（与社区插件 dshmarket 同法）。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { McpToolBridge } from './host/mcp-bridge.js'
import { createHandler, type WebServerLike } from './host/router.js'
import { listMcpTools } from './zotero/client.js'
import {
  DEFAULT_LIMIT,
  FULLTEXT_MAX_BYTES,
  MCP_PROBE_TIMEOUT_MS,
  MCP_URL,
  REQUEST_TIMEOUT_MS,
  ROUTE_MATCH,
  setSettingsReader,
  ZOTERO_BASE,
} from './zotero/config.js'

export const name = 'dsh-plugin-zotero'

/**
 * 插件配置 schema（逐字段 volatile）。
 *
 * volatile 是 dsh 配置表单的硬前提：无 volatile 字段的条目不会出现在
 * `settings.describe` 里，也无法写入。字段用 `.volatile()` 后，保存只提交
 * 新值并唤醒引用，条目本身不重挂 —— 因此改配置无需重启 dsh。
 *
 * 注意：不要写成 `Schema<Config>` 显式注解，那会把模式固化成 `plain`，
 * 擦掉 volatile 的 `.get()` 读取面。这里交给 TS 推导，`apply` 用
 * `Schemastery.TypeT<typeof Config>` 取「含 volatile 引用」的输出类型。
 */
export const Config = Schema.object({
  zoteroBaseUrl: Schema.string().default(ZOTERO_BASE).volatile(),
  mcpUrl: Schema.string().default(MCP_URL).volatile(),
  requestTimeoutMs: Schema.number().default(REQUEST_TIMEOUT_MS).volatile(),
  mcpProbeTimeoutMs: Schema.number().default(MCP_PROBE_TIMEOUT_MS).volatile(),
  fulltextMaxBytes: Schema.number().default(FULLTEXT_MAX_BYTES).volatile(),
  defaultLimit: Schema.number().default(DEFAULT_LIMIT).volatile(),
  /** 被关掉的集成 MCP 工具原始名；模型侧据此过滤注册。 */
  disabledMcpTools: Schema.array(Schema.string()).default([]).volatile(),
})

export function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>): void {
  // 每次读取都走 volatile 引用，始终拿到最新值。
  setSettingsReader(() => ({
    zoteroBaseUrl: config.zoteroBaseUrl.get(),
    mcpUrl: config.mcpUrl.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(),
    mcpProbeTimeoutMs: config.mcpProbeTimeoutMs.get(),
    fulltextMaxBytes: config.fulltextMaxBytes.get(),
    defaultLimit: config.defaultLimit.get(),
    disabledMcpTools: [...config.disabledMcpTools.get()],
  }))

  // 模型侧：自持集成 MCP 连接，按 disabledMcpTools 过滤后注册工具。
  let bridge: McpToolBridge | undefined
  ctx.inject(['tools'], (toolCtx: Context) => {
    const instance = new McpToolBridge(toolCtx)
    bridge = instance
    toolCtx.effect(
      () => () => {
        instance.dispose()
        if (bridge === instance) bridge = undefined
      },
      'dsh-plugin-zotero: mcp tool bridge',
    )
    instance.sync().catch((error: unknown) => {
      console.warn('[dsh-plugin-zotero] 集成 MCP 工具注册失败：', error)
    })
  })

  ctx.inject(['webServer'], (hostCtx: Context) => {
    const webServer = (hostCtx as unknown as { webServer: WebServerLike }).webServer
    // 面板打开「配置」页时会 GET 该路由：顺带按最新开关重建一次注册。
    const handler = createHandler({
      syncTools: async () => (bridge ? bridge.sync() : listMcpTools()),
    })
    hostCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_MATCH, handler }),
      'dsh-plugin-zotero: http routes',
    )
  })
}
