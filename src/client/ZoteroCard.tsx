/**
 * 设置页（浏览器半）。
 *
 * 把 Host 导出的 volatile `Config` 表单渲染进「设置」对话框的
 * `settings.section` 席位（左侧导航里独立一页「Zotero文献库」）—— 表单模型照抄官方
 * 参考实现 `@deepseek-ai/dsh-client-ui-settings-shell` 的 `ShellCard`：
 * 控制器持 `SettingsFormModel`，组件经注入的 hook 读快照。
 *
 * **没有保存按钮**：字段改完停手 {@link AUTOSAVE_DELAY_MS} 就自动落盘（今天大家
 * 已经不习惯点保存），失败不自动重试、等下一次编辑；离开页面时把合法草稿立刻冲掉、
 * 非法草稿直接丢弃。因此这里用普通 `<div>` 容器而不是框架的 `SettingsForm`——
 * 后者的页脚写死了一个「保存」按钮，没有关掉的开关。
 *
 * 顺序：**Zotero 写权限**（置顶 —— 写入开关 + 授权/重读按钮，写成显眼的操作卡）、
 * **API 设置**（本地 API 与面板行为）、**MCP 设置**（集成 MCP 连接 + 工具清单）。
 * 写权限放最前是因为「没点授权按钮 → 写操作全失败」是最常见的踩坑点，不能让用户
 * 翻到页面底部才发现有这个按钮。工具清单由 Host 路由 `/dsh-zotero/api/mcp-tools`
 * 现场拉取，每个工具一个 `Switch`，禁用集写进 `disabledMcpTools` 字段。
 *
 * 席位 `id`（{@link ROW_ID}）同时是 Host settings 命名空间，必须与
 * `cordis.patch.yml` 的行 id 保持同步。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import {
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

import type { ZoteroWriteStatus } from '../zotero/types'
import { authorizeWrites, fetchWriteStatus } from './api'
import { tpl, type Translate } from './locales'
import { ACCENT } from './styles'
import { Button, SectionTitle } from './ui'

/** 设置命名空间 id（= cordis.patch.yml 的 insert 行 id）。 */
export const ROW_ID = 'dsh-plugin-zotero'

/** 本插件 Host 路由前缀（与 `src/zotero/config.ts` 的 ROUTE_PREFIX 同步）。 */
const API_BASE = '/dsh-zotero/api'

/** 承载「被禁用的工具原始名」的配置字段名。 */
const DISABLED_FIELD = 'disabledMcpTools'

/** 写入总开关的配置字段名。 */
const WRITE_FIELD = 'writeEnabled'

/** 划词翻译的引擎字段名。 */
const TRANSLATE_PROVIDER_FIELD = 'translateProvider'

/** 划词翻译的目标语言字段名。 */
const TRANSLATE_TARGET_FIELD = 'translateTarget'

/** 允许的引擎取值；与 Host `TranslateProvider`、译文浮层下拉同步。 */
const TRANSLATE_PROVIDERS = ['bing', 'deepseek'] as const

/**
 * 目标语言候选：首项 `auto` = 按原文语种中英互译（与 Zotero 翻译插件一致），
 * 其余是手动锁定；够覆盖常见文献语言，再多的用「自定义」不划算。
 */
const TRANSLATE_TARGETS = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'ru'] as const

/** 可配置字段名，与 Host `Config` schema 一一对应。 */
type FieldName =
  | 'zoteroBaseUrl'
  | 'mcpUrl'
  | 'requestTimeoutMs'
  | 'mcpProbeTimeoutMs'
  | 'fulltextMaxBytes'
  | 'defaultLimit'
  | 'easyScholarKey'

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

/**
 * 「期刊指标」组的字段。
 *
 * 只有一个密钥：填了就能在文献信息里直接看到影响因子与分区，留空则只显示
 * 跳转入口。密钥由用户自己在 easyScholar 注册后取得，免登录、不绑会员。
 */
const JOURNAL_FIELDS: readonly FieldMeta[] = [
  { name: 'easyScholarKey', numeric: false },
]

const ALL_FIELDS: readonly FieldMeta[] = [...API_FIELDS, ...MCP_FIELDS, ...JOURNAL_FIELDS]

/**
 * 自动保存的静默窗口（毫秒）：最后一次改动后停手这么久才落盘。
 *
 * 太短会把「边打字边写盘」变成一串写请求（每个字符都要 patch 一次配置），
 * 太长又让关窗前的改动容易丢。600ms 大致等于「打完一个词、手指离开键盘」。
 */
const AUTOSAVE_DELAY_MS = 600

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
  writeEnabled: SettingsFieldState
  translateProvider: SettingsFieldState
  translateTarget: SettingsFieldState
  easyScholarKey: SettingsFieldState
}

/** 席位注册时经 `inject()` 下发给组件的面。 */
interface CardInjection extends SettingsActions {
  hooks: { zoteroCard: SnapshotStore<CardState> }
}

/** 组件收到的 props：席位标准 props + 注入面（hook 与表单动作）+ 本页字典。 */
interface CardProps {
  t: Translate
  useZoteroCard: <T>(selector: (state: CardState) => T) => T
  /**
   * 把暂存值落盘（异步，内部自己翻 `saving`）。
   *
   * 本页没有保存按钮：由 {@link AUTOSAVE_DELAY_MS} 的防抖与卸载时的冲盘调用。
   */
  save(): void
  /** 丢弃暂存值（只用于卸载时清掉解析不出来的草稿）。 */
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
 * 布尔字段的规格：表单只认文本，因此开关以 `'true' / 'false'` 字符串暂存。
 * 其他文本视为非法，阻止保存（避免误把「1」「on」写进配置）。
 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (value === true ? 'true' : 'false'),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true' || trimmed === 'false') return { kind: 'set', value: trimmed === 'true' }
      return undefined
    },
  }
}

/**
 * 枚举字段的规格：值本身就是字符串，但要挡住手改 patch 文件写进来的野值。
 *
 * 界面上不出现文本框（引擎与目标语言都是下拉），所以非法值的唯一来源就是
 * 配置文件；`format` 把野值显示成默认值，用户不动它就不会把野值再存一遍。
 */
function enumField(field: string, allowed: readonly string[], fallback: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'string' && allowed.includes(value) ? value : fallback),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return allowed.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/**
 * 一张卡片的暂存表单模型：改动先进暂存，由组件的防抖自动保存落盘（没有保存按钮）。
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
      booleanField(WRITE_FIELD),
      enumField(TRANSLATE_PROVIDER_FIELD, TRANSLATE_PROVIDERS, 'bing'),
      enumField(TRANSLATE_TARGET_FIELD, TRANSLATE_TARGETS, 'auto'),
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
      writeEnabled: this.form.field(WRITE_FIELD),
      translateProvider: this.form.field(TRANSLATE_PROVIDER_FIELD),
      translateTarget: this.form.field(TRANSLATE_TARGET_FIELD),
      easyScholarKey: this.form.field('easyScholarKey'),
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

/** 拉取集成 MCP 工具清单。返回 `[状态, 重新读取]`。 */
function useMcpTools(): readonly [ToolsState, () => void] {
  const [state, setState] = useState<ToolsState>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
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
  }, [nonce])

  return [state, () => { setNonce((value) => value + 1) }]
}

/** 写通道状态的加载结果。 */
type WriteState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: ZoteroWriteStatus }

/**
 * 读取写通道状态（已保存的开关 + Host 内存里有没有 key）。
 *
 * 授权成功或失败后都要重读，否则徽标会停在旧事实上。
 */
function useWriteStatus(): readonly [WriteState, () => void] {
  const [state, setState] = useState<WriteState>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    void (async () => {
      try {
        const status = await fetchWriteStatus()
        if (!cancelled) setState({ kind: 'ready', status })
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
  }, [nonce])

  return [state, () => { setNonce((value) => value + 1) }]
}

const SECTION_HINT_STYLE = { fontSize: 12, opacity: 0.72, marginBottom: 10 }
/**
 * 表单容器：等价于框架 `SettingsForm` 的 `._form_*`（`display:flex;
 * flex-direction:column`），只是不带那个写死的「保存」页脚。
 * 底部留白由每张卡片自己的 `marginBottom` 提供，这里不再补。
 */
const FORM_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', paddingBottom: 0 }
/** 不可用 / 只读提示，对齐框架 `._readOnly_*` 的字号与颜色。 */
const NOTICE_STYLE: CSSProperties = {
  margin: '0 0 12px',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary, rgba(128, 128, 128, 0.9))',
}
/** 自动保存的状态行（保存中 / 保存失败）。 */
const SAVE_STATUS_STYLE: CSSProperties = { margin: '0 0 8px', fontSize: 12, lineHeight: 1.5, opacity: 0.72 }
const SAVE_FAILED_STYLE: CSSProperties = {
  ...SAVE_STATUS_STYLE,
  opacity: 1,
  color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error, #b3261e))',
}
/**
 * 四块配置共用的分组卡片：1px 中性描边 + 10px 圆角 + 浅底。
 *
 * 之前只有「写权限」内部有框，其余三组只有一个 12px、72% 透明度的小标题，
 * 视觉上连成一篇长文；现在每组都自成一块，标题升为带蓝紫竖条的一级标题。
 * 颜色走宿主主题变量，light/dark 都成立。
 */
const SETTINGS_CARD_STYLE: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35))',
  borderRadius: 10,
  padding: '14px 16px',
  marginBottom: 12,
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
}
/** 卡片内的一级标题：复用右栏分区标题的蓝紫竖条 + 加粗蓝字，字号比字段大一档。 */
const CARD_TITLE_STYLE: CSSProperties = { fontSize: 14, marginBottom: 10 }
/** 卡片内的二级标题（MCP 工具区）：比一级淡一档，避免和组标题抢层级。 */
const SUBHEAD_STYLE: CSSProperties = { fontSize: 12, fontWeight: 600, opacity: 0.72, margin: '4px 0 6px' }
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
/** 翻译组里的字段名，与写开关那一行同一视觉层级。 */
const TRANSLATE_LABEL_STYLE = { fontSize: 13, fontWeight: 600, display: 'block' }

/** 密钥字段：标题行（label + 已覆盖 / 恢复默认）+ 输入行 + 说明。 */
const SECRET_FIELD_STYLE = { padding: '6px 0' }
const SECRET_HEADER_STYLE = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }
const OVERRIDDEN_BADGE_STYLE = { fontSize: 11, opacity: 0.62 }
const SECRET_RESET_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'none',
  fontSize: 11,
  color: ACCENT,
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
}
const SECRET_INPUT_ROW_STYLE = { display: 'flex', alignItems: 'center', gap: 6 }

/** 与 `SELECT_STYLE` 同一套边框与圆角，看起来像同一张卡里的控件。 */
const SECRET_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 30,
  padding: '0 8px',
  fontSize: 13,
  fontFamily: 'inherit',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'transparent',
  color: 'inherit',
  outline: 'none',
}

/** 眼睛按钮：纯图标，不给文字，宽高与输入框对齐。 */
const EYE_BUTTON_STYLE: CSSProperties = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  padding: 0,
  border: '1px solid rgba(127,127,127,0.35)',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  opacity: 0.72,
}
/** 目标语言下拉：原生 select，主题色靠 CSS 变量跟随明暗。 */
const SELECT_STYLE: CSSProperties = {
  flexShrink: 0,
  height: 26,
  padding: '0 4px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'CanvasText',
}
/** 引擎选项比语言名长，限宽免得把左侧的说明文字挤没。 */
const PROVIDER_SELECT_STYLE: CSSProperties = { ...SELECT_STYLE, maxWidth: '52%' }

/**
 * 写权限卡内部布局：纵向排列，**不再描边**——外层 `SETTINGS_CARD_STYLE`
 * 已经是卡片了，框中框只会让这一组比其它组更臃肿。
 */
const WRITE_BODY_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
/** 卡片内的步骤标题（「步骤 ①」那种小标签）。 */
const WRITE_STEP_STYLE: CSSProperties = { fontSize: 11, fontWeight: 600, opacity: 0.6, margin: 0 }
/** 状态徽标行：加粗显示「未授权 / 已授权」。 */
const WRITE_STATUS_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  fontWeight: 600,
}
/** 按钮行：主按钮在前，紧挨次要按钮。 */
const WRITE_ACTIONS_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
/** 警示行（未授权 / 需先保存），用 warn 色，但不抢按钮的视觉重心。 */
const WRITE_WARN_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-state-warn-primary, #b26a00)',
}
/** 常规说明行。 */
const WRITE_NOTE_STYLE: CSSProperties = { fontSize: 12, lineHeight: 1.5, opacity: 0.72 }

/** 设置页正文：三大组 + MCP 工具开关。 */
export function ZoteroSettingsSection(props: CardProps): ReactElement {
  const { t } = props
  const state = props.useZoteroCard((snapshot) => snapshot)
  const [tools, reloadTools] = useMcpTools()
  const [write, reloadWrite] = useWriteStatus()
  const [authorizing, setAuthorizing] = useState(false)
  const [authNotice, setAuthNotice] = useState<string | null>(null)
  /** 密钥默认遮着，点眼睛才看明文（截屏、共享屏幕时不至于直接漏出去）。 */
  const [keyRevealed, setKeyRevealed] = useState(false)

  const locked = !state.writable
  const disabledSet = readDisabled(state.disabledMcpTools.text)

  /**
   * 草稿指纹：任何字段改动都会换一个字符串。
   *
   * `dirty` 只是布尔，连着改两次仍是 `true`，靠它做 effect 依赖会让防抖计时器
   * 不重启（第二次改动落在第一次的旧计时器上）。指纹进依赖才能真正「最后一次改完
   * 再等 600ms」。
   */
  const draftKey = [
    state.zoteroBaseUrl.text,
    state.mcpUrl.text,
    state.requestTimeoutMs.text,
    state.mcpProbeTimeoutMs.text,
    state.fulltextMaxBytes.text,
    state.defaultLimit.text,
    state.disabledMcpTools.text,
    state.writeEnabled.text,
    state.translateProvider.text,
    state.translateTarget.text,
    // 漏一个字段就会「填完不保存」：这个指纹才是防抖自动保存的依赖。
    state.easyScholarKey.text,
  ].join('\u0000')

  /**
   * 自动保存：改完停手 {@link AUTOSAVE_DELAY_MS} 落盘。
   *
   * 三种情况明确不排队：
   * - `invalid`：有字段填得解析不出来（比如数字框里打了字母），存下去会写坏配置，
   *   字段自己会亮红提示，用户改对了自然会重新排队；
   * - `saving`：上一次写还在飞。等它落地后 `saving` 变 false，这条 effect 会重跑，
   *   仍在 dirty 就继续排 —— 所以连续快速改动不会被 `save()` 的 `saving` 早退吞掉；
   * - `failed`：写盘失败（被更高优先级 patch 层覆盖、网络断等）。**不自动重试**，
   *   否则每 600ms 打一次后端；`stage()` 会把 `failed` 清掉，用户再改一次即可重来。
   */
  useEffect(() => {
    if (!state.dirty || state.invalid || state.saving || state.failed) return
    const timer = setTimeout(() => { props.save() }, AUTOSAVE_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [draftKey, state.dirty, state.invalid, state.saving, state.failed])

  /**
   * 一次写入落地后，重取工具清单与写权限状态。
   *
   * 这两处的「事实」在 Host 侧：保存会按新开关重建工具注册，写通道状态也要重读
   * 才会从「未开启」翻成「待授权」（原来靠 `onSave` 里那个 400ms 定时器猜落盘时间，
   * 现在 `saving` 由模型自己翻转，时机是准的）。
   */
  const wasSaving = useRef(false)
  useEffect(() => {
    if (state.saving) {
      wasSaving.current = true
      return
    }
    if (!wasSaving.current) return
    wasSaving.current = false
    reloadTools()
    reloadWrite()
  }, [state.saving])

  /**
   * 离开页面时处理残留草稿：合法的立刻冲掉（不然这 600ms 内的改动会悄悄丢），
   * 非法的直接丢弃（旧 `SettingsForm` 的 unmount 语义，避免下次打开还挂着一片红）。
   *
   * 用 ref 而不是把 effect 依赖铺开：这个 effect 只该在卸载时跑一次。
   */
  const pendingRef = useRef({ dirty: false, invalid: false, save: () => {}, discard: () => {} })
  useEffect(() => {
    pendingRef.current = {
      dirty: state.dirty,
      invalid: state.invalid,
      save: () => { props.save() },
      discard: () => { props.discard() },
    }
  }, [draftKey, state.dirty, state.invalid])
  useEffect(() => () => {
    const pending = pendingRef.current
    if (!pending.dirty) return
    if (pending.invalid) pending.discard()
    else pending.save()
  }, [])

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

  /**
   * 密钥字段：默认显示圆点，点右侧眼睛才看明文。
   *
   * 不走 `SettingsValueField` —— 那个组件的 props 里没有 `type`，只能渲染普通
   * 文本框，密钥会明晃晃摊在屏幕上（截屏、录屏、当着别人开设置页都会漏）。
   * 「已覆盖 / 恢复默认」两枚标记自己补上，与其它字段保持一致的交互。
   */
  const renderSecretField = (field: FieldMeta): ReactElement => {
    const fieldState = state[field.name]
    const inputId = `plugin-config-zotero-${field.name}`
    return (
      <div key={field.name} style={SECRET_FIELD_STYLE}>
        <div style={SECRET_HEADER_STYLE}>
          <label htmlFor={inputId} style={TRANSLATE_LABEL_STYLE}>
            {t(`field.${field.name}`)}
          </label>
          {fieldState.overridden && (
            <>
              <span style={OVERRIDDEN_BADGE_STYLE}>{t('form.overridden')}</span>
              <button
                type="button"
                disabled={locked}
                onClick={() => props.resetField(field.name)}
                style={SECRET_RESET_STYLE}
              >
                {t('form.reset')}
              </button>
            </>
          )}
        </div>
        <div style={SECRET_INPUT_ROW_STYLE}>
          <input
            id={inputId}
            type={keyRevealed ? 'text' : 'password'}
            value={fieldState.text}
            disabled={locked}
            placeholder={t('field.easyScholarKeyPlaceholder')}
            // 密钥不该进浏览器的密码管理器，也不该被拼写检查盯上。
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => props.edit(field.name, event.target.value)}
            style={SECRET_INPUT_STYLE}
          />
          <button
            type="button"
            onClick={() => { setKeyRevealed((prev) => !prev) }}
            aria-label={keyRevealed ? t('field.secretHide') : t('field.secretShow')}
            title={keyRevealed ? t('field.secretHide') : t('field.secretShow')}
            aria-pressed={keyRevealed}
            disabled={locked}
            style={EYE_BUTTON_STYLE}
          >
            <EyeIcon open={keyRevealed} />
          </button>
        </div>
        <span style={TOOL_DESC_STYLE}>{t(`field.${field.name}Hint`)}</span>
      </div>
    )
  }

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

  /**
   * 发起授权。
   *
   * Zotero 的弹窗会挂住这条请求直到用户点按钮，所以等待期间禁用按钮：再点一次
   * 只是多弹一个框，还可能撞上 Zotero 每分钟 5 次的授权限流。
   */
  const runAuthorize = async (): Promise<void> => {
    setAuthorizing(true)
    setAuthNotice(null)
    try {
      const result = await authorizeWrites()
      setAuthNotice(result.remembered ? t('write.granted') : t('write.grantedOnce'))
    } catch (error) {
      setAuthNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setAuthorizing(false)
      reloadWrite()
    }
  }

  /** 卡片正文：状态 + 两个按钮 + 说明。开关行在 {@link renderWrite} 里，常驻。 */
  const renderWriteBody = (): ReactElement => {
    if (write.kind === 'loading') return <div style={HINT_STYLE}>{t('write.loading')}</div>
    if (write.kind === 'error') {
      return (
        <div style={HINT_STYLE}>
          <span>{tpl(t('write.error'), { message: write.message })}</span>
          <Button variant="outline" size="sm" onClick={() => reloadWrite()}>{t('write.reload')}</Button>
        </div>
      )
    }
    const { enabled, hasKey, remembered } = write.status
    const badge = !enabled
      ? t('write.off')
      : !hasKey
        ? t('write.unauthorized')
        : remembered
          ? t('write.remembered')
          : t('write.singleUse')
    const blocked = locked || authorizing || !enabled
    // 拿到可复用的授权后，主按钮降级为「重新授权」：正常路径下用户不需要再点它。
    const ready = hasKey && remembered
    return (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={WRITE_STEP_STYLE}>{t('write.steps')}</p>
          <div style={WRITE_STATUS_STYLE}>
            <span>{badge}</span>
          </div>
          {/* 按钮必须自己站出来说话：未授权时主按钮实心，已授权后降级为描边。 */}
          <div style={WRITE_ACTIONS_STYLE}>
            <Button
              variant={ready ? 'outline' : 'primary'}
              size="md"
              disabled={blocked}
              title={enabled ? t('write.authorizeHint') : t('write.needSave')}
              onClick={() => {
                void runAuthorize()
              }}
            >
              {authorizing ? t('write.pending') : ready ? t('write.reauthorize') : t('write.authorize')}
            </Button>
            <Button
              variant="outline"
              size="md"
              title={t('write.reloadHint')}
              onClick={() => {
                setAuthNotice(null)
                reloadWrite()
              }}
            >
              {t('write.reload')}
            </Button>
          </div>
        </div>

        {/* 未开启开关时，按钮是禁用的 —— 这条说清为什么、该先做什么。 */}
        {!enabled && <div style={WRITE_WARN_STYLE}>{t('write.needSave')}</div>}
        {enabled && (
          <div style={WRITE_WARN_STYLE}>
            {hasKey && remembered ? t('write.calloutReady') : t('write.callout')}
          </div>
        )}
        {authNotice !== null && <div style={WRITE_NOTE_STYLE}>{authNotice}</div>}
        {/* 已经拿到长期授权就不再念叨「始终允许」，改成说清它存在哪、怎么撤销。 */}
        <div style={WRITE_NOTE_STYLE}>
          {hasKey && remembered ? t('write.persistedNote') : t('write.alwaysAllow')}
        </div>
      </>
    )
  }

  const renderWrite = (): ReactElement => (
    <div style={WRITE_BODY_STYLE}>
      <div style={TOOL_ROW_STYLE}>
        <div style={TOOL_INFO_STYLE}>
          <span style={{ ...TOOL_NAME_STYLE, fontSize: 13, fontWeight: 600 }}>{t('write.toggle')}</span>
          <span style={TOOL_DESC_STYLE}>{t('write.toggleHint')}</span>
        </div>
        <Switch
          checked={state.writeEnabled.text === 'true'}
          disabled={locked}
          label={t('write.toggle')}
          title={state.writeEnabled.text === 'true' ? t('write.on') : t('write.off')}
          onChange={(next) => {
            props.edit(WRITE_FIELD, next ? 'true' : 'false')
            setAuthNotice(null)
          }}
        />
      </div>
      {renderWriteBody()}
    </div>
  )

  /**
   * 「划词翻译」：引擎与目标语言都用原生下拉。
   *
   * 引擎早先是两枚分段按钮，光看「Bing 免费 / DeepSeek 精翻」不知道在选什么，
   * 改成下拉后选项能带一句人话说明；这里选的是**默认**引擎，译文浮层里还能临时换。
   * 两项都不走 `SettingsValueField`（那是文本框），但值仍是字符串，因此字段规格用
   * {@link enumField} —— 表单模型只负责「值合法 + 脏了要存」，控件长什么样由这里定。
   */
  const renderTranslate = (): ReactElement => {
    return (
      <>
        <div style={TOOL_ROW_STYLE}>
          <div style={TOOL_INFO_STYLE}>
            <span style={TRANSLATE_LABEL_STYLE}>{t('field.translateProvider')}</span>
            <span style={TOOL_DESC_STYLE}>{t('field.translateProviderHint')}</span>
          </div>
          <select
            value={state.translateProvider.text === 'deepseek' ? 'deepseek' : 'bing'}
            disabled={locked}
            onChange={(event) => props.edit(TRANSLATE_PROVIDER_FIELD, event.target.value)}
            style={PROVIDER_SELECT_STYLE}
            aria-label={t('field.translateProvider')}
          >
            {TRANSLATE_PROVIDERS.map((value) => (
              <option key={value} value={value}>{t(`translate.provider.${value}`)}</option>
            ))}
          </select>
        </div>
        <div style={TOOL_ROW_STYLE}>
          <div style={TOOL_INFO_STYLE}>
            <span style={TRANSLATE_LABEL_STYLE}>{t('field.translateTarget')}</span>
            <span style={TOOL_DESC_STYLE}>{t('field.translateTargetHint')}</span>
          </div>
          <select
            value={state.translateTarget.text === '' ? 'auto' : state.translateTarget.text}
            disabled={locked}
            onChange={(event) => props.edit(TRANSLATE_TARGET_FIELD, event.target.value)}
            style={SELECT_STYLE}
            aria-label={t('field.translateTarget')}
          >
            {TRANSLATE_TARGETS.map((tag) => (
              <option key={tag} value={tag}>{t(`translate.target.${tag}`)}</option>
            ))}
          </select>
        </div>
      </>
    )
  }

  const renderStatus = (): ReactElement | null => {
    if (state.failed) return <p style={SAVE_FAILED_STYLE} role="status">{t('form.autosaveFailed')}</p>
    if (state.saving) return <p style={SAVE_STATUS_STYLE} role="status">{t('form.autosaving')}</p>
    return null
  }

  // 命名空间没被 Host 服务时，整张表单都没有意义（旧 `SettingsForm` 同样只留一句提示）。
  if (!state.available) return <p style={NOTICE_STYLE} role="status">{t('form.unavailable')}</p>

  return (
    <div style={FORM_STYLE}>
      {state.writable ? null : <p style={NOTICE_STYLE} role="status">{t('form.readOnly')}</p>}
      <div style={SECTION_HINT_STYLE}>{t('settings.hint')}</div>
      {renderStatus()}
      <section style={SETTINGS_CARD_STYLE}>
        <SectionTitle style={CARD_TITLE_STYLE}>{t('group.write')}</SectionTitle>
        {renderWrite()}
      </section>
      <section style={SETTINGS_CARD_STYLE}>
        <SectionTitle style={CARD_TITLE_STYLE}>{t('group.api')}</SectionTitle>
        {API_FIELDS.map(renderField)}
      </section>
      <section style={SETTINGS_CARD_STYLE}>
        <SectionTitle style={CARD_TITLE_STYLE}>{t('group.mcp')}</SectionTitle>
        {MCP_FIELDS.map(renderField)}
        <div style={{ marginTop: 8 }}>
          <h4 style={SUBHEAD_STYLE}>{t('tools.title')}</h4>
          {renderTools()}
        </div>
      </section>
      <section style={SETTINGS_CARD_STYLE}>
        <SectionTitle style={CARD_TITLE_STYLE}>{t('group.translate')}</SectionTitle>
        {renderTranslate()}
      </section>
      <section style={SETTINGS_CARD_STYLE}>
        <SectionTitle style={CARD_TITLE_STYLE}>{t('group.journal')}</SectionTitle>
        {JOURNAL_FIELDS.map(renderSecretField)}
      </section>
    </div>
  )
}

/**
 * 眼睛图标：睁眼 = 当前显示明文，闭眼 = 当前遮着。
 *
 * 纯 `currentColor` 描边，颜色跟着按钮文字走，深浅主题不用另配一份。
 * 不用「锁」的隐喻 —— 这里的动作是「看一眼」，不是「加密」。
 */
function EyeIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      {open ? (
        <>
          <path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z" />
          <circle cx="8" cy="8" r="1.8" />
        </>
      ) : (
        <>
          <path d="M2.2 8S4.4 4.2 8 4.2c1.1 0 2.1.3 3 .8" />
          <path d="M13.8 8s-2.2 3.8-5.8 3.8c-1.1 0-2.1-.3-3-.8" />
          <path d="M2.8 13.2 13.2 2.8" />
        </>
      )}
    </svg>
  )
}
