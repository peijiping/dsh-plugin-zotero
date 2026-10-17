# Zotero 插件页配置项 —— 实施计划

设计背景与理由见同目录 [Zotero插件页配置项方案.md](./Zotero插件页配置项方案.md)。本文件是**执行版**：只列落地步骤、精确改动点与已核实的 API 事实。

## 一、摘要

让 dsh 的「插件」页里 `dsh-plugin-zotero` 这一行出现**「配置」入口**，可编辑 6 个字段（Zotero 地址 / MCP 地址 / 三个超时与阈值 / 默认条数），保存后写入 profile 的 `cordis.patch.yml`，且**无需重启即时生效**。

做法是补齐两个必要条件（都只改本插件，不动 dsh 本体）：

1. **Host 半**：插件条目导出 Schemastery `Config` schema，**每个字段逐字段标 `.volatile()`**。
2. **浏览器半**：插件往插件页的 `plugins.row.config` 席位注册一个 keyed 配置页。

## 二、现状分析（已核实，含证据）

| 事实 | 证据 |
|---|---|
| 无 volatile 字段的条目在 `settings.describe` 里被**直接排除**；写入时抛 `has no volatile fields` / `is not volatile` | `@deepseek-ai/dsh-settings/lib/index.js:122`（`volatileForm`）、`:418`、`:505-507` |
| 行配置页的席位 key = `` `${bundle}#${rowId}` `` | `dsh-client-ui-plugin-manager/lib/client.js:27-29`（`rowConfigKey`） |
| 页面只渲染**已注册** key 的行控件：`configure.has(row) = ledger.rows.has(rowConfigKey(...))`；`ledger.rows = slots.entries("plugins.row.config")` 中的 `options.key` | 同上 `:48`、`:3357` |
| 行「配置」页渲染 `plugins.row.config`，props = `{view:'page', form}` + 第二参 `{entryKey: key}`；行摘要渲染 `{view:'summary'}` | 同上 `:2390`、`:2401-2404` |
| 浏览器侧表单服务 `configForms`：`get(entryId)` 取某条目的共享表单；`whileServed(namespaces, register)` 在 Host 服务该命名空间时才注册 | `dsh-client-ui-settings/lib/client.js:1309-1316`、`:1330-1349` |
| 官方参考实现形态：`inject = ['slots','locale','configForms']`；`new SettingsFormModel(ctx.configForms.get(NS), [settingsNumberField(...)])`；`.bind(projection)`；`inject()` 返回 `{hooks:{x:store}, ...form.actions()}`；`whileServed` + `slots.inject` + `slots.register` | `dsh-client-ui-settings-shell/lib/client.js:119-190` |
| primitives：`SettingsForm` props `{labels,state,onSave,onDiscard,children}`；`SettingsValueField` props `{id,label,hint,overriddenLabel,resetLabel,invalidLabel,numeric,disabled,text,overridden,invalid,onEdit,onReset}`；`SettingsFormModel(scope,specs,secrets?)` 方法 `bind/shell/field/actions/dispose`；`actions()` = `{edit,resetField,save,discard}` | `dsh-client-ui-primitives/lib/index.js:6918`、`:6973`、`:7151`、`:7231-7256` |
| `.volatile()` 解析结果是 `Volatile<T>`（稳定引用，读 `.get()`）；**即使只用默认值也返回引用**（`Schema.resolve` 对 volatile 字段返回 `createVolatile(value)`）；volatile **必须逐字段、不可嵌套** | `schemastery/src/index.ts:480-483`、`:521-530`、`:493-494`；README:393 |
| 可用的类型工具：`Schemastery.TypeT<X> = ReturnType<From<X>>`，能从 schema 推出「含 volatile 引用」的输出类型（`Schemastery` 是 schemastery 在 `declare global` 暴露的命名空间） | `schemastery/lib/types/index.d.ts:14`、`:5-6`、`:78` |

> ⚠️ **对旧方案的一处必要修正**：不要写 `export const Config: Schema<Config>`。该注解把 mode 固化为 `plain`，会**擦掉 volatile 模式**（`config.x.get()` 编译不过，且用 volatile 子 schema 赋值给它会类型不兼容）。改为**不注解 const** + `apply` 参数用 `Schemastery.TypeT<typeof Config>`。

## 三、配置字段（6 项，默认值引用现有常量）

| 字段 | 类型 | 默认（常量） | 生效点 |
|---|---|---|---|
| `zoteroBaseUrl` | string | `ZOTERO_BASE` = `http://127.0.0.1:23119` | 探活与全部本地 API 请求 |
| `mcpUrl` | string | `MCP_URL` = `http://127.0.0.1:23120/mcp` | MCP 端口探活 |
| `requestTimeoutMs` | number | `REQUEST_TIMEOUT_MS` = 5000 | 本地 API fetch 超时 |
| `mcpProbeTimeoutMs` | number | `MCP_PROBE_TIMEOUT_MS` = 800 | TCP 探活超时 |
| `fulltextMaxBytes` | number | `FULLTEXT_MAX_BYTES` = 204800 | 全文截断阈值 |
| `defaultLimit` | number | `DEFAULT_LIMIT` = 50 | 条目列表默认条数 |

保留为常量（前后端协议，不做配置项）：`LIBRARY_PREFIX`、`ROUTE_PREFIX`、`ROUTE_MATCH`、`router.ts` 的 `MAX_LIMIT`。

## 四、实施步骤

### A. 宿主侧

**A1. [src/zotero/config.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/zotero/config.ts)** —— 保留现有常量作默认值，追加运行时读取面（不新建文件）：

```ts
export interface ZoteroSettings {
  zoteroBaseUrl: string
  mcpUrl: string
  requestTimeoutMs: number
  mcpProbeTimeoutMs: number
  fulltextMaxBytes: number
  defaultLimit: number
}

/** 默认读取器：未注入时回落到常量。 */
let readSettings = (): ZoteroSettings => ({
  zoteroBaseUrl: ZOTERO_BASE,
  mcpUrl: MCP_URL,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  mcpProbeTimeoutMs: MCP_PROBE_TIMEOUT_MS,
  fulltextMaxBytes: FULLTEXT_MAX_BYTES,
  defaultLimit: DEFAULT_LIMIT,
})

/** 由插件入口在 apply 时注入（每次读取 volatile 引用，始终拿最新值）。 */
export function setSettingsReader(reader: () => ZoteroSettings): void { readSettings = reader }
export function getSettings(): ZoteroSettings { return readSettings() }
/** 派生值。 */
export function zoteroProbeUrl(): string { return `${getSettings().zoteroBaseUrl}/api/` }
export function libraryBase(): string { return `${getSettings().zoteroBaseUrl}${LIBRARY_PREFIX}` }
```

**A2. [src/zotero/client.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/zotero/client.ts)** —— 常量直读改运行时读：

- 删除顶层的 `const LIB = ...`（:101），全部 `${LIB}` 出现处（:243/:249/:276-277/:291/:300/:321/:331/:402/:414）改为 `${libraryBase()}`。
- `REQUEST_TIMEOUT_MS`（:110、:210）→ `getSettings().requestTimeoutMs`。
- `ZOTERO_BASE`（:114 报错文案）→ `getSettings().zoteroBaseUrl`。
- `ZOTERO_PROBE_URL`（:210）→ `zoteroProbeUrl()`。
- `MCP_URL`（:224）→ `getSettings().mcpUrl`。
- `MCP_PROBE_TIMEOUT_MS`（:232）→ `getSettings().mcpProbeTimeoutMs`。
- `FULLTEXT_MAX_BYTES`（:309、:312）→ `getSettings().fulltextMaxBytes`。
- import 从 `./config.js` 改为引入 `getSettings / zoteroProbeUrl / libraryBase`（不再引入被替换的常量）。

**A3. [src/host/router.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/host/router.ts)** —— `clampLimit()`（:77-81）默认值改读 `getSettings().defaultLimit`：

```ts
function clampLimit(raw: string | null): number {
  const fallback = Math.floor(getSettings().defaultLimit) || DEFAULT_LIMIT
  const parsed = raw === null ? fallback : Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, MAX_LIMIT)
}
```

`MAX_LIMIT` 与 `createHandler()` 签名不变；import 增加 `getSettings`。

**A4. [src/index.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/index.ts)** —— 导出 Config schema 并注入读取器：

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { createHandler, type WebServerLike } from './host/router.js'
import {
  DEFAULT_LIMIT, FULLTEXT_MAX_BYTES, MCP_PROBE_TIMEOUT_MS, MCP_URL,
  REQUEST_TIMEOUT_MS, ROUTE_MATCH, ZOTERO_BASE, setSettingsReader,
} from './zotero/config.js'

export const name = 'dsh-plugin-zotero'

/**
 * 配置 schema（逐字段 volatile）：dsh 据此在「插件」页渲染配置表单，
 * 且无需重启即可让新值生效（loader 只提交新值并唤醒引用）。
 */
export const Config = Schema.object({
  zoteroBaseUrl: Schema.string().default(ZOTERO_BASE).volatile(),
  mcpUrl: Schema.string().default(MCP_URL).volatile(),
  requestTimeoutMs: Schema.number().default(REQUEST_TIMEOUT_MS).volatile(),
  mcpProbeTimeoutMs: Schema.number().default(MCP_PROBE_TIMEOUT_MS).volatile(),
  fulltextMaxBytes: Schema.number().default(FULLTEXT_MAX_BYTES).volatile(),
  defaultLimit: Schema.number().default(DEFAULT_LIMIT).volatile(),
})

export function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>): void {
  setSettingsReader(() => ({
    zoteroBaseUrl: config.zoteroBaseUrl.get(),
    mcpUrl: config.mcpUrl.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(),
    mcpProbeTimeoutMs: config.mcpProbeTimeoutMs.get(),
    fulltextMaxBytes: config.fulltextMaxBytes.get(),
    defaultLimit: config.defaultLimit.get(),
  }))

  ctx.inject(['webServer'], (hostCtx: Context) => {
    const webServer = (hostCtx as unknown as { webServer: WebServerLike }).webServer
    hostCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_MATCH, handler: createHandler() }),
      'dsh-plugin-zotero: http routes',
    )
  })
}
```

### B. 浏览器侧

**B1. [src/client/dsh-client.d.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/client/dsh-client.d.ts)** —— 在现有 `declare module '@deepseek-ai/dsh-client-ui-primitives'` 内追加（按实际实现写最小面，别多写）：

- `interface SettingsFormLabels { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string }`
- `interface SettingsFormState { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }`
- `function SettingsForm(props: { labels: SettingsFormLabels; state: SettingsFormState; onSave: () => void; onDiscard: () => void; children?: ReactNode }): ReactElement`
- `function SettingsValueField(props: { id: string; label: string; hint?: string | undefined; overriddenLabel?: string; resetLabel?: string; invalidLabel?: string; numeric?: boolean; disabled?: boolean; text: string; overridden: boolean; invalid: boolean; onEdit: (text: string) => void; onReset: () => void }): ReactElement`
- `interface SettingsFieldSpec { field: string; format: (value: unknown) => string; parse: (text: string) => { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined }`
- `function settingsNumberField(field: string): SettingsFieldSpec`；`function settingsTextField(field: string): SettingsFieldSpec`
- `interface SettingsFieldState { text: string; overridden: boolean; invalid: boolean }`；`interface SettingsActions { edit(field: string, text: string): void; resetField(field: string): void; save(): void; discard(): void }`
- `class SettingsFormModel { constructor(scope: unknown, specs: SettingsFieldSpec[], secrets?: SettingsFieldSpec[]) ; bind<T>(project: () => T): { getSnapshot(): T; subscribe(listener: () => void): () => void }; shell(): SettingsFormState; field(field: string): SettingsFieldState; actions(): SettingsActions; dispose(): void }`

**B2. [src/client/locales.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/client/locales.ts)** —— zh/en 各补：

`card.title`、`card.desc`、`field.zoteroBaseUrl`+`Hint`、`field.mcpUrl`+`Hint`、`field.requestTimeoutMs`+`Hint`、`field.mcpProbeTimeoutMs`+`Hint`、`field.fulltextMaxBytes`+`Hint`、`field.defaultLimit`+`Hint`、`form.unavailable`、`form.readOnly`、`form.saveFailed`、`form.save`、`form.saving`、`form.overridden`、`form.reset`、`form.invalidNumber`、`form.invalidText`。

字段文案示例（zh）：`Zotero 地址` / `默认 http://127.0.0.1:23119；Zotero 需在「设置 → 高级 → 其他」中允许本机通信` 等。

**B3. 新建 [src/client/ZoteroCard.tsx](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/client/ZoteroCard.tsx)** —— 形状照抄 `ui-settings-shell`：控制器 + 组件。

```tsx
const ROW_ID = 'dsh-plugin-zotero'               // = cordis.patch.yml 的行 id，也是 settings 命名空间
const ROW_CONFIG_KEY = `${ROW_ID}#${ROW_ID}`     // = plugin-manager 的 rowConfigKey(bundle,rowId)

const FIELDS = [
  settingsTextField('zoteroBaseUrl'),
  settingsTextField('mcpUrl'),
  settingsNumberField('requestTimeoutMs'),
  settingsNumberField('mcpProbeTimeoutMs'),
  settingsNumberField('fulltextMaxBytes'),
  settingsNumberField('defaultLimit'),
] as const

export class ZoteroCardController {
  private form = new SettingsFormModel(scope, [...FIELDS])
  private store = this.form.bind(() => ({
    ...this.form.shell(),
    zoteroBaseUrl: this.form.field('zoteroBaseUrl'),
    /* …其余 5 个字段… */
  }))
  constructor(scope: unknown) { this.form = new SettingsFormModel(scope, [...FIELDS]); this.store = this.form.bind(...) }
  inject() { return { hooks: { zoteroCard: this.store }, ...this.form.actions() } }
  dispose() { this.form.dispose() }
}

export function ZoteroCard(props) {
  const { t } = props
  const state = props.useZoteroCard((s) => s)
  if (props.view === 'summary') return t('card.desc')
  const disabled = !state.writable
  return createElement(SettingsForm, {
    labels: { unavailable: t('form.unavailable'), readOnly: t('form.readOnly'), saveFailed: t('form.saveFailed'), save: t('form.save'), saving: t('form.saving') },
    state, onSave: props.save, onDiscard: props.discard,
    children: [ /* 6 个 SettingsValueField，字段→文案/数值标志/onEdit=props.edit / onReset=props.resetField */ ],
  })
}
```

要点：`settingsTextField` 用于两个 URL（空串=清除覆盖），`settingsNumberField` 用于四个数值（`numeric: true`）；**不要**混用 `props.form.mutate`（与 model 同 scope 会撞 revision）。

**B4. [src/client/index.ts](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/src/client/index.ts)** —— 加 `configForms` 注入并注册席位：

- `export const inject = ['slots', 'locale', 'sidebarRightTabs', 'configForms']`
- `ClientContext` 补：`configForms: { get(entryId: string): unknown; whileServed(namespaces: string[], register: (served: Set<string>) => () => void): () => void }`
- 文件末尾追加（`ROW_ID`/`ROW_CONFIG_KEY` 由 ZoteroCard 导出并注明与 `cordis.patch.yml` 行 id 同步）：

```ts
const controller = new ZoteroCardController(ctx.configForms.get(ROW_ID))
ctx.effect(() => () => controller.dispose(), 'dsh-plugin-zotero: card form')
ctx.effect(() => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject('plugins.row.config',
  () => ctx.slots.register(
    { name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS, inject: () => controller.inject() },
    ZoteroCard as ComponentType<never>,
  ))), 'dsh-plugin-zotero: row config card')
```

**B5. [package.json](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/package.json)** —— `dsh.client.inject` 追加 `"@deepseek-ai/dsh-client-ui-settings"`（`configForms` 提供方）与 `"@deepseek-ai/dsh-client-ui-plugin-manager"`（`plugins.row.config` 席位所有者）。**tsdown.config.ts 不改**。

## 五、假设与决策

1. 6 个可配置字段（见第三节）；前后端协议常量不做配置项。
2. 选 `plugins.row.config`（行级专属页，行上会多出「配置」控件）。回退：`plugins.bundle.config`（key=`dsh-plugin-zotero`，页面只传 `{view:'page'}`）。
3. 逐字段 `.volatile()`；全 volatile ⇒ 保存即时生效、不重挂条目。
4. `apply` 参数用 `Schemastery.TypeT<typeof Config>`（不写 `Schema<Config>` 注解）。
5. 数值读取处 `Math.floor` 兜底，非法回落默认。

## 六、验证

1. `pnpm build && pnpm build:client && pnpm typecheck:client` 全绿；`client/client.js` 外壳仍为 `id: "dsh-plugin-zotero"`。
2. `dsh --profile demo --dump-config`：`dsh-plugin-zotero` 行出现 `config:` 块。
3. Web（demo profile，`http://localhost:8123`）：插件页 → `dsh-plugin-zotero` 包 → 行上出现「配置」→ 改 `defaultLimit=10` → 保存 → 字段显示「已覆盖」，`~/.dsh/profiles/demo/cordis.patch.yml` 出现该行 `config:`。
4. 生效性：保存后**不重启**，`curl 'http://localhost:8123/dsh-zotero/api/items'` 返回条数 ≤10；点「恢复默认」再保存，patch 中 `config:` 消失。
5. 回归：设置 → 内置插件（只读页）正常；右侧栏 Zotero tab 与面板功能不受影响。

## 七、风险

1. keyed 席位若不把 `inject()` 作为 props 下发：退路是改读 `props.form.state` 并用 `props.form.mutate` 自建最小草稿（多一版实现）。
2. 行 id 若被用户 home patch 改写 ⇒ key 静默不匹配（不报错，表现为「没有配置控件」）；先确认 `settings.describe` 里存在 `dsh-plugin-zotero` 命名空间。
3. 任何字段漏标 `.volatile()` ⇒ 该字段不可编辑/整体条目可能不出现。
4. 非回环页面导入 Host 侧为 `unavailable`，表单只读。
5. 新增 Host schema 后需重载条目：`link:` 安装下要 `pnpm build` 并重启 dsh。
6. 手写 primitives 声明可能与真实实现漂移——只声明用到的符号。

## 八、文档同步

- [README.md](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/README.md)：新增「插件页配置项」小节（字段表、入口、落点、生效方式）。
- [docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)：配置入口与字段表、重置/覆盖语义、patch 落点、被 home patch 覆盖时的报错现象。
- [.trae/documents/Zotero-DSH插件开发与设计方案.md](file:///Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero/.trae/documents/Zotero-DSH插件开发与设计方案.md)：补「配置形态」章节（原「v1 不引入 Schemastery 配置」改为已引入 + volatile 约定）。
