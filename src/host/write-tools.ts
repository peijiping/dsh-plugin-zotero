/**
 * 模型侧的写工具（Host 半）。
 *
 * 为什么只有这五个：
 *
 * 1. 集成 MCP 的写工具覆盖条目 / 分类 / 标签 / 标识符，**唯独没有标注与笔记**
 *    （`get_annotations` / `search_annotations` 都是只读）。这两类要写，只有本地
 *    API 这一条通道。
 * 2. 「新建高亮」需要 PDF 用户空间的 `rects`，那组数只有阅读器里的文本层算得准。
 *    让模型自己编坐标，等于在用户库里画莫名其妙的矩形，还删不干净 —— 所以创建
 *    标注只留给面板里的划选，模型侧开放「改既有标注 + 笔记全套」。
 *
 * 版本号来源与面板不同：面板带着自己读到的那份版本去写，模型没有缓存，因此这里
 * 写之前现读一次状态。窗口只有一两个往返，真撞上并发改动就是 412，原样报回让模型
 * 重来，绝不静默覆盖。
 */

import type { Context } from '@deepseek-ai/cordis'

import { deleteAnnotation, patchAnnotation } from '../zotero/annotation-writes.js'
import { getAnnotationState, getNoteRaw, ZoteroError } from '../zotero/client.js'
import { createNote, deleteNote, updateNote } from '../zotero/notes.js'
import { getSettings } from '../zotero/config.js'
import { blocksToText, type ToolsService } from './mcp-bridge.js'
import { requireKey } from './router.js'

/** 每条写工具描述前面都挂的引导语：授权是一次点击，不是重试能解决的事。 */
const AUTH_HINT =
  '[写入 Zotero] 本工具经 Zotero 本地 API 改动用户文库，需要先在该插件「配置」页点「授权 Zotero 写权限」，' +
  '并在 Zotero 弹窗里选「始终允许」。若报「尚未取得 Zotero 写权限」，请把这句话转告用户后停下：' +
  '**不要重试**，也不要改用 shell/curl 直打 http://127.0.0.1:23119 —— 那个端点每次申请都弹框，' +
  '而且每分钟只允许 5 次，硬试只会把用户堵在弹窗里。'

const DESTRUCTIVE_HINT =
  '[破坏性写操作] 删除是**硬删**，不进 Zotero 回收站、撤销不了。执行前必须向用户点明要删的具体对象并得到确认。'

/** Zotero 标注色板，直接写进描述，省得模型猜 hex。 */
const COLOR_HINT =
  '颜色只能取 Zotero 色板：`#ffd400` 黄 / `#ff6666` 红 / `#5fb236` 绿 / `#2ea8e5` 蓝 / `#a28ae5` 紫 / `#e56eee` 粉 / `#f19837` 橙。'

/** dsh 侧的工具定义形状（与集成 MCP 桥接同构，便于共用注册与渲染）。 */
interface WriteToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown) => Promise<string>
}

/** 结果统一压成 MCP 那种内容块，渲染与序列化只有一份实现。 */
function resultFor(text: string): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text }] }
}

function readArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZoteroError('bad_request', '工具参数必须是对象。')
  }
  return value as Record<string, unknown>
}

/** 未声明的键一律报错：静默忽略会让模型以为参数生效了。 */
function assertKnown(record: Record<string, unknown>, allowed: string[], tool: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ZoteroError('bad_request', `${tool} 不认识参数「${key}」，可用参数只有 ${allowed.join(' / ')}。`)
    }
  }
}

function requireText(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new ZoteroError('bad_request', `参数「${field}」必须是字符串。`)
  }
  return value
}

/** 可选字符串：缺失给 undefined，显式空串留给下游当「清除」语义。 */
function optionalText(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ZoteroError('bad_request', `参数「${field}」必须是字符串。`)
  }
  return value
}

const stringSchema = (description: string): Record<string, unknown> => ({ type: 'string', description })

const TOOL_DEFINITIONS: WriteToolDefinition[] = [
  {
    name: 'zotero_create_note',
    description: `${AUTH_HINT}\n\n在某个条目下新建一条 Zotero 笔记。正文是 HTML 字符串，与 Zotero 桌面端写的笔记同构。`,
    parameters: {
      type: 'object',
      properties: {
        itemKey: stringSchema('父条目 key（8 位），笔记挂在这个条目下。'),
        note: stringSchema('笔记正文 HTML。纯文本请包成 `<p>…</p>`；不要含 script / iframe / `on…=` 事件属性。'),
      },
      required: ['itemKey', 'note'],
      additionalProperties: false,
    },
    async execute(args) {
      const record = readArgs(args)
      assertKnown(record, ['itemKey', 'note'], 'zotero_create_note')
      const created = await createNote({ parentItem: requireKey(record, 'itemKey'), note: requireText(record, 'note') })
      return `已新建笔记 ${created.key}。`
    },
  },
  {
    name: 'zotero_update_note',
    description: `${AUTH_HINT}\n\n整篇替换一条 Zotero 笔记的正文。含引文或标注锚点的笔记也能改，但必须把 \`data-citation\` / \`data-annotation\` 这些属性原样带回去，删了指针就失联。`,
    parameters: {
      type: 'object',
      properties: {
        key: stringSchema('笔记条目的 key（8 位）。'),
        note: stringSchema('替换后的完整正文 HTML，不是追加，也不是 diff。'),
      },
      required: ['key', 'note'],
      additionalProperties: false,
    },
    async execute(args) {
      const record = readArgs(args)
      assertKnown(record, ['key', 'note'], 'zotero_update_note')
      const key = requireKey(record, 'key')
      const current = await getNoteRaw(key)
      await updateNote({ key, version: current.version, note: requireText(record, 'note') })
      return `已更新笔记 ${key} 的正文。`
    },
  },
  {
    name: 'zotero_delete_note',
    description: `${AUTH_HINT}\n\n${DESTRUCTIVE_HINT}`,
    parameters: {
      type: 'object',
      properties: {
        key: stringSchema('要删除的笔记条目 key（8 位）。'),
      },
      required: ['key'],
      additionalProperties: false,
    },
    async execute(args) {
      const record = readArgs(args)
      assertKnown(record, ['key'], 'zotero_delete_note')
      const key = requireKey(record, 'key')
      const current = await getNoteRaw(key)
      await deleteNote({ key, version: current.version })
      return `已删除笔记 ${key}。`
    },
  },
  {
    name: 'zotero_update_annotation',
    description:
      `${AUTH_HINT}\n\n改一条 PDF 标注：颜色、评论、高亮↔下划线、页码标签、标签。` +
      `只有高亮与下划线可改，截图 / 墨迹 / 文本框这几类请让用户在 Zotero 里动。\n\n${COLOR_HINT}\n\n` +
      '新建标注不在本工具范围内：PDF 坐标只能由插件的阅读器算出来，请让用户在右侧阅读面板里划选后点色块。',
    parameters: {
      type: 'object',
      properties: {
        key: stringSchema('标注条目的 key（8 位），可从 `mcp__zotero__get_annotations` 的返回里拿。'),
        color: stringSchema('改成哪个色板色值。'),
        comment: stringSchema('评论正文（字面量文本，`<b>` 等标签按字符串存）；传空串表示清除。'),
        type: stringSchema('标注类型，只能在 `highlight` 与 `underline` 之间互转。'),
        pageLabel: stringSchema('印刷页码标签，如 `12` 或 `iii`；传空串表示清除。'),
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '标签**整表替换**（不是追加）；最多 20 个，空数组即清空。',
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async execute(args) {
      const record = readArgs(args)
      assertKnown(record, ['key', 'color', 'comment', 'type', 'pageLabel', 'tags'], 'zotero_update_annotation')
      const key = requireKey(record, 'key')
      const patch: Record<string, unknown> = {}
      const color = optionalText(record, 'color')
      const comment = optionalText(record, 'comment')
      const type = optionalText(record, 'type')
      const pageLabel = optionalText(record, 'pageLabel')
      if (color !== undefined) patch.color = color
      if (comment !== undefined) patch.comment = comment
      if (type !== undefined) patch.type = type
      if (pageLabel !== undefined) patch.pageLabel = pageLabel
      if (record.tags !== undefined) {
        if (!Array.isArray(record.tags)) {
          throw new ZoteroError('bad_request', '参数「tags」必须是字符串数组。')
        }
        patch.tags = record.tags.map((item) => ({ tag: typeof item === 'string' ? item : String(item), type: 1 }))
      }
      const changed = Object.keys(patch)
      const current = await getAnnotationState(key)
      await patchAnnotation({ key, version: current.version, patch })
      return `已更新标注 ${key}：${changed.join(' / ')}。`
    },
  },
  {
    name: 'zotero_delete_annotation',
    description: `${AUTH_HINT}\n\n${DESTRUCTIVE_HINT}`,
    parameters: {
      type: 'object',
      properties: {
        key: stringSchema('要删除的标注条目 key（8 位）。'),
      },
      required: ['key'],
      additionalProperties: false,
    },
    async execute(args) {
      const record = readArgs(args)
      assertKnown(record, ['key'], 'zotero_delete_annotation')
      const key = requireKey(record, 'key')
      const current = await getAnnotationState(key)
      await deleteAnnotation({ key, version: current.version })
      return `已删除标注 ${key}。`
    },
  },
]

/**
 * 本插件自有的写工具注册表。
 *
 * 只在 `writeEnabled` 为真时注册：关掉开关，模型侧就完全看不到这些名字，比让它
 * 调用后吃一句「未开启」更省事。开关是 volatile 配置，改完不重启 dsh，因此靠
 * {@link sync} 在配置卡读状态时对齐一次。
 */
export class ZoteroWriteToolBridge {
  private disposers: (() => void)[] = []
  private enabled: boolean | null = null

  constructor(private readonly ctx: Context) {}

  /** 按当前开关对齐注册；开关没变时什么都不做，配置卡每次展开都会调它。 */
  sync(): void {
    const enabled = getSettings().writeEnabled
    if (enabled === this.enabled) return

    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.enabled = enabled
    if (!enabled) return

    const toolsService = (this.ctx as unknown as { tools: ToolsService }).tools
    const next: (() => void)[] = []
    try {
      for (const tool of TOOL_DEFINITIONS) {
        next.push(
          toolsService.register({
            name: tool.name,
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
            async execute(args: unknown): Promise<unknown> {
              return resultFor(await tool.execute(args))
            },
          }),
        )
      }
    } catch (error) {
      for (const dispose of next) dispose()
      this.enabled = null
      throw error
    }
    this.disposers = next
  }

  /** 注销本插件注册的全部写工具。 */
  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.enabled = null
  }
}
