/**
 * 插件页配置卡（浏览器半）。
 *
 * 把 Host 导出的 volatile `Config` 表单渲染进插件页的 `plugins.row.config`
 * 席位 —— 造型与状态机照抄官方参考实现
 * `@deepseek-ai/dsh-client-ui-settings-shell` 的 `ShellCard`：
 * 控制器持 `SettingsFormModel`，组件经注入的 hook 读快照。
 *
 * 卡片分两组：**API 设置**（本地 API 与面板行为）与 **MCP 设置**（集成 MCP
 * 连接 + 工具清单）。工具清单由 Host 路由 `/dsh-zotero/api/mcp-tools` 现场拉
 * 取，每个工具一个 `Switch`，禁用集写进 `disabledMcpTools` 字段。
 *
 * 席位 key 由 plugin-manager 的 `rowConfigKey(bundle, rowId)` 决定，因此
 * {@link ROW_CONFIG_KEY} 必须与 `cordis.patch.yml` 的行 id 保持同步。
 */

import { useEffect, useState, type ReactElement } from 'react'

import {
  Button,
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  settingsNumberField,
  settingsTextField,
  type SettingsActions,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormState,
  type SnapshotStore,
} from '@deepseek-ai/dsh-client-ui-primitives'

import { tpl, type Translate } from './locales'

/** 插件页的行 id / settings 命名空间（= cordis.patch.yml 的 insert 行 id）。 */
export const ROW_ID = 'dsh-plugin-zotero'

/** `plugins.row.config` 席位的 key（= `<包名>#<行 id>`）。 */
export const ROW_CONFIG_KEY = `${ROW_ID}#${ROW_ID}`

/** 本插件 Host 路由前缀（与 `src/zotero/config.ts` 的 ROUTE_PREFIX 同步）。 */
const API_BASE = '/dsh-zotero/api'

/** 承载「被禁用的工具原始名」的配置字段名。 */
const DISABLED_FIELD = 'disabledMcpTools'

/** 可配置字段名，与 Host `Config` schema 一一对应。 */
type FieldName =
  | 'zoteroBaseUrl'
  | 'mcpUrl'
  | 'requestTimeoutMs'
  | 'mcpProbeTimeoutMs'
  | 'fulltextMaxBytes'
  | 'defaultLimit'

interface FieldMeta {
  name: FieldName
  /** 数值字段走 `settingsNumberField`（`numeric` 只提示数字键盘）。 */
  numeric: boolean
}

/** 「API 设置」组的字段（本地 API 与面板行为）。 */
const API_FIELDS: readonly FieldMeta[] = [
  { name: 'zoteroBaseUrl', numeric: false },
  { name: 'requestTimeoutMs', numeric: true },
  { name: 'fulltextMaxBytes', numeric: true },
  { name: 'defaultLimit', numeric: true },
]

/** 「MCP 设置」组的字段（集成 MCP 连接）。 */
const MCP_FIELDS: readonly FieldMeta[] = [
  { name: 'mcpUrl', numeric: false },
  { name: 'mcpProbeTimeoutMs', numeric: true },
]

const ALL_FIELDS: readonly FieldMeta[] = [...API_FIELDS, ...MCP_FIELDS]

/** 集成 MCP 的一个工具（与 Host `McpToolInfo` 对齐）。 */
interface McpTool {
  name: string
  description: string
}

/** 工具清单的加载状态机。 */
type ToolsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tools: readonly McpTool[] }

/** 卡片快照：表单整体状态 + 逐字段状态。 */
interface CardState extends SettingsFormState {
  zoteroBaseUrl: SettingsFieldState
  mcpUrl: SettingsFieldState
  requestTimeoutMs: SettingsFieldState
  mcpProbeTimeoutMs: SettingsFieldState
  fulltextMaxBytes: SettingsFieldState
  defaultLimit: SettingsFieldState
  disabledMcpTools: SettingsFieldState
}

/** 席位注册时经 `inject()` 下发给组件的面。 */
interface CardInjection extends SettingsActions {
  hooks: { zoteroCard: SnapshotStore<CardState> }
}

/** 组件收到的 props：席位标准 props + 注入面（hook 与表单动作）+ 本卡字典。 */
interface CardProps {
  view: 'summary' | 'page'
  t: Translate
  useZoteroCard: <T>(selector: (state: CardState) => T) => T
  save(): void
  discard(): void
  edit(field: string, text: string): void
  resetField(field: string): void
}

/**
 * 禁用集的字段规格：表单只认文本/数字，因此把字符串数组序列化成 JSON 文本。
 * 非 JSON 数组的输入视为非法，阻止保存。
 */
function disabledToolsField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (Array.isArray(value) ? JSON.stringify(value) : '[]'),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      try {
        const parsed: unknown = JSON.parse(trimmed) as unknown
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return undefined
        return { kind: 'set', value: parsed }
      } catch {
        return undefined
      }
    },
  }
}

/** 从表单文本解出当前禁用集合（容错：非法文本回落到空集）。 */
function readDisabled(text: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(text.trim() === '' ? '[]' : text) as unknown
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? new Set(parsed)
      : new Set()
  } catch {
    return new Set()
  }
}

/**
 * 一张卡片的暂存表单模型：只在保存时写入，离开页面时丢弃草稿。
 * `scope` 由 `configForms.get(ROW_ID)` 提供（本条的共享配置表单）。
 */
export class ZoteroCardController {
  private readonly form: SettingsFormModel

  private readonly store: SnapshotStore<CardState>

  constructor(scope: unknown) {
    this.form = new SettingsFormModel(scope, [
      ...ALL_FIELDS.map((field): SettingsFieldSpec =>
        field.numeric ? settingsNumberField(field.name) : settingsTextField(field.name)),
      disabledToolsField(DISABLED_FIELD),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CardState {
    return {
      ...this.form.shell(),
      zoteroBaseUrl: this.form.field('zoteroBaseUrl'),
      mcpUrl: this.form.field('mcpUrl'),
      requestTimeoutMs: this.form.field('requestTimeoutMs'),
      mcpProbeTimeoutMs: this.form.field('mcpProbeTimeoutMs'),
      fulltextMaxBytes: this.form.field('fulltextMaxBytes'),
      defaultLimit: this.form.field('defaultLimit'),
      disabledMcpTools: this.form.field(DISABLED_FIELD),
    }
  }

  /** 席位注册的注入面：hook + 表单动作。 */
  inject(): CardInjection {
    return { hooks: { zoteroCard: this.store }, ...this.form.actions() }
  }

  /** 释放表单订阅。 */
  dispose(): void {
    this.form.dispose()
  }
}

/**
 * 拉取集成 MCP 工具清单。`active` 为 false（行摘要态）时不动手。
 * 返回 `[状态, 重新读取]`。
 */
function useMcpTools(active: boolean): readonly [ToolsState, () => void] {
  const [state, setState] = useState<ToolsState>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/mcp-tools`)
        const payload = (await res.json()) as {
          ok: boolean
          data?: { tools?: readonly McpTool[] }
          error?: { message?: string }
        }
        if (!payload.ok) throw new Error(payload.error?.message ?? `HTTP ${res.status}`)
        if (!cancelled) setState({ kind: 'ready', tools: payload.data?.tools ?? [] })
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [active, nonce])

  return [state, () => { setNonce((value) => value + 1) }]
}

const GROUP_STYLE = { marginTop: 4 }
const GROUP_HEAD_STYLE = { fontSize: 12, fontWeight: 600, opacity: 0.72, margin: '0 0 6px' }
const HINT_STYLE = { fontSize: 12, opacity: 0.72, display: 'flex', alignItems: 'center', gap: 8 }
const TOOL_LIST_STYLE = { listStyle: 'none', margin: '6px 0 0', padding: 0 }
const TOOL_ROW_STYLE = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  padding: '6px 0',
}
const TOOL_INFO_STYLE = { minWidth: 0 }
const TOOL_NAME_STYLE = { fontSize: 12, display: 'block' }
const TOOL_DESC_STYLE = { fontSize: 11, opacity: 0.66, display: 'block', marginTop: 2 }

/** 行摘要返回一句话；行「配置」页返回完整表单（两大组 + MCP 工具开关）。 */
export function ZoteroCard(props: CardProps): ReactElement | string {
  const { t } = props
  const state = props.useZoteroCard((snapshot) => snapshot)
  const [tools, reloadTools] = useMcpTools(props.view === 'page')

  if (props.view === 'summary') return t('card.desc')

  const locked = !state.writable
  const disabledSet = readDisabled(state.disabledMcpTools.text)

  const toggle = (name: string, enabled: boolean): void => {
    const next = new Set(disabledSet)
    if (enabled) next.delete(name)
    else next.add(name)
    props.edit(DISABLED_FIELD, JSON.stringify([...next].sort()))
  }

  const renderField = (field: FieldMeta): ReactElement => (
    <SettingsValueField
      key={field.name}
      id={`plugin-config-zotero-${field.name}`}
      label={t(`field.${field.name}`)}
      hint={t(`field.${field.name}Hint`)}
      overriddenLabel={t('form.overridden')}
      resetLabel={t('form.reset')}
      invalidLabel={t(field.numeric ? 'form.invalidNumber' : 'form.invalidText')}
      numeric={field.numeric}
      disabled={locked}
      {...state[field.name]}
      onEdit={(text) => props.edit(field.name, text)}
      onReset={() => props.resetField(field.name)}
    />
  )

  const renderTools = (): ReactElement => {
    if (tools.kind === 'loading') return <div style={HINT_STYLE}>{t('tools.loading')}</div>
    if (tools.kind === 'error') {
      return (
        <div style={HINT_STYLE}>
          <span>{tpl(t('tools.error'), { message: tools.message })}</span>
          <Button variant="ghost" size="sm" onClick={() => reloadTools()}>{t('tools.reload')}</Button>
        </div>
      )
    }
    if (tools.tools.length === 0) return <div style={HINT_STYLE}>{t('tools.empty')}</div>
    return (
      <>
        <div style={HINT_STYLE}>
          <span>
            {tpl(t('tools.summary'), {
              total: tools.tools.length,
              off: tools.tools.filter((tool) => disabledSet.has(tool.name)).length,
            })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => reloadTools()}>{t('tools.reload')}</Button>
        </div>
        <ul style={TOOL_LIST_STYLE}>
          {tools.tools.map((tool) => {
            const enabled = !disabledSet.has(tool.name)
            return (
              <li key={tool.name} style={TOOL_ROW_STYLE}>
                <div style={TOOL_INFO_STYLE}>
                  <code style={TOOL_NAME_STYLE}>{`mcp__zotero__${tool.name}`}</code>
                  <span style={TOOL_DESC_STYLE}>{tool.description}</span>
                </div>
                <Switch
                  checked={enabled}
                  disabled={locked}
                  label={tpl(t('tools.toggleLabel'), { name: tool.name })}
                  title={enabled ? t('tools.on') : t('tools.off')}
                  onChange={(next) => toggle(tool.name, next)}
                />
              </li>
            )
          })}
        </ul>
      </>
    )
  }

  return (
    <SettingsForm
      labels={{
        unavailable: t('form.unavailable'),
        readOnly: t('form.readOnly'),
        saveFailed: t('form.saveFailed'),
        save: t('form.save'),
        saving: t('form.saving'),
      }}
      state={state}
      onSave={() => {
        props.save()
        // 保存是异步落盘：稍后重读清单，Host 会顺带按新开关重建工具注册。
        setTimeout(() => reloadTools(), 400)
      }}
      onDiscard={() => props.discard()}
    >
      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.api')}</h4>
        {API_FIELDS.map(renderField)}
      </section>
      <section style={GROUP_STYLE}>
        <h4 style={GROUP_HEAD_STYLE}>{t('group.mcp')}</h4>
        {MCP_FIELDS.map(renderField)}
        <div style={{ marginTop: 8 }}>
          <h4 style={GROUP_HEAD_STYLE}>{t('tools.title')}</h4>
          {renderTools()}
        </div>
      </section>
    </SettingsForm>
  )
}
