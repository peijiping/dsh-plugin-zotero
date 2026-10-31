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

/**
 * 写工具判定：集成 MCP 里所有会改库的工具名都以这些动词开头
 * （`write_item` / `create_collection` / `add_by_identifier` / `remove_items_from_collection` …）。
 */
const WRITE_TOOL_RE = /^(write|add|create|update|delete|remove)_/i

/** 破坏性写工具：删除/移除类，需要额外的确认提示。 */
const DESTRUCTIVE_TOOL_RE = /^(delete|remove)_/i

/**
 * 注入到写工具描述前面的引导语。
 *
 * 背景：Zotero 的本地 API（23119）写接口必须先用 `POST /api/local/authorize`
 * 换一个 key，而该端点**每次调用都会弹授权框**、且不像应用名复用；模型若绕开
 * MCP 手写 curl，就会每次写都让用户点一次「允许」。集成 MCP 的写工具在 Zotero
 * 进程内直接改库，完全不触发这套授权，因此这里明确把 MCP 标成首选通道。
 *
 * 注意措辞是「优先」而不是「禁止」：集成 MCP 某些场景确实可能失败，必须给模型
 * 留下降级空间，否则它会在报错后继续硬试或改用更糟的方式。
 */
const WRITE_PREFIX =
  '[首选写通道] 本工具在 Zotero 进程内执行，不会触发本地 API 授权弹窗。写 Zotero 优先用它。' +
  '仅当本工具不可用或调用失败时再考虑其他方式；不要直接用 shell/curl 访问 http://127.0.0.1:23119，' +
  '那会每次都弹出「本地 API 授权」框让用户点允许。'

/** 针对「导入本地文件挂到条目下」这一高频场景，直接点明参数组合，省得模型去猜。 */
const WRITE_ITEM_HINT =
  '「导入 PDF/文件并挂到某个条目下」用本工具：action=import、filePath=<文件绝对路径>、parentItemKey=<目标条目 key>，title 可选。'

/** 按标识符入库优先走 Zotero 自带解析器，元数据比模型手填准确。 */
const IDENTIFIER_HINT =
  '「按 DOI/arXiv/ISBN/PMID 入库」优先用本工具，它调用 Zotero 自带的元数据解析器，比手填字段准确。'

const DESTRUCTIVE_HINT =
  '[破坏性写操作] 执行前必须先与用户确认要操作的具体条目/分类，不要凭推断批量删除或移除。'

/** 在不改动上游对象的前提下，给写工具的描述拼上引导语。 */
function descriptionFor(tool: McpToolInfo): string {
  const parts: string[] = []
  if (DESTRUCTIVE_TOOL_RE.test(tool.name)) parts.push(DESTRUCTIVE_HINT)
  if (WRITE_TOOL_RE.test(tool.name)) parts.push(WRITE_PREFIX)
  if (tool.name === 'write_item') parts.push(WRITE_ITEM_HINT)
  if (tool.name === 'add_by_identifier') parts.push(IDENTIFIER_HINT)

  const base = tool.description ?? ''
  if (parts.length === 0) return base
  return `${parts.join('\n\n')}\n\n${base}`
}

/** 由 MCP 工具造一条 dsh 工具定义（参数直接沿用上游 JSON Schema）。 */
function definitionFor(tool: McpToolInfo): unknown {
  return {
    name: publicName(tool.name),
    description: descriptionFor(tool),
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
