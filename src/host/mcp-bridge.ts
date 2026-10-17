/**
 * 集成 MCP 工具桥接（Host 半）。
 *
 * dsh 自带的 `@deepseek-ai/dsh-mcp-client` **不支持按工具启用/禁用**，所以本插件
 * 改为自持连接：把集成 MCP 的工具按当前 `disabledMcpTools` 过滤后，直接注册进
 * dsh 工具表，公开名沿用官方的 `mcp__<serverName>__<rawName>` 约定。因此
 * `cordis.patch.yml` 里不再插入 `mcp-zotero` 行，避免重名冲突。
 *
 * 每次 {@link McpToolBridge.sync} 都是「先建新代、成功后再拆旧代」，注册失败时
 * 整体回滚，卡片打开/保存时各同步一次。
 */

import type { Context } from '@deepseek-ai/cordis'

import { callMcpTool, listMcpTools, type McpToolInfo } from '../zotero/client.js'
import { getSettings } from '../zotero/config.js'

/** `ctx.tools` 的最小结构接口（真实类型由 dsh 装配，不在本包类型面内）。 */
interface ToolsService {
  register(definition: unknown): () => void
}

/** 服务器命名空间，与历史 `mcp__zotero__*` 工具名保持一致。 */
const SERVER_NAME = 'zotero'

/** 公开工具名：`mcp__zotero__<原始名>`。 */
function publicName(rawName: string): string {
  return `mcp__${SERVER_NAME}__${rawName}`
}

/** 把 MCP 内容块数组压成模型可读文本（非文本块以 JSON 兜底）。 */
function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'object' && block !== null) {
        const record = block as { type?: unknown; text?: unknown }
        if (record.type === 'text' && typeof record.text === 'string') return record.text
      }
      return JSON.stringify(block)
    })
    .join('\n')
}

/** 由 MCP 工具造一条 dsh 工具定义（参数直接沿用上游 JSON Schema）。 */
function definitionFor(tool: McpToolInfo): unknown {
  return {
    name: publicName(tool.name),
    description: tool.description,
    parameters: tool.parameters,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: { content: unknown }) => [
        { type: 'text', text: blocksToText(value.content) },
      ],
    },
    async execute(args: unknown, exec: { signal?: AbortSignal }): Promise<unknown> {
      const result = await callMcpTool(tool.name, args, exec.signal)
      const text = blocksToText(result.content)
      if (result.isError) throw new Error(text === '' ? `${tool.name} 执行失败` : text)
      return { content: result.content }
    },
  }
}

/** 持有本插件当前注册的这一代工具，按需整体换新。 */
export class McpToolBridge {
  private disposers: (() => void)[] = []

  constructor(private readonly ctx: Context) {}

  /**
   * 重新拉取工具清单并整体替换注册，返回清单供配置卡复显。
   *
   * 顺序是「先拉清单 → 拆旧代 → 建新代」：拉清单失败时旧代保持可用；建新代
   * 失败时回滚本次已注册的部分。不能反过来先注册后拆旧 —— 同名工具注册会直接
   * 报「already registered」。
   */
  async sync(): Promise<McpToolInfo[]> {
    const tools = await listMcpTools()
    const disabled = new Set(getSettings().disabledMcpTools)
    const toolsService = (this.ctx as unknown as { tools: ToolsService }).tools

    for (const dispose of this.disposers) dispose()
    this.disposers = []

    const next: (() => void)[] = []
    try {
      for (const tool of tools) {
        if (disabled.has(tool.name)) continue
        next.push(toolsService.register(definitionFor(tool)))
      }
    } catch (error) {
      for (const dispose of next) dispose()
      throw error
    }
    this.disposers = next
    return tools
  }

  /** 注销本插件注册的全部工具。 */
  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }
}
