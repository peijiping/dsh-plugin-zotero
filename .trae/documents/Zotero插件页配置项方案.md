# Zotero 插件页配置项方案（Host Config schema + 浏览器侧配置表单页）

## 背景

用户在 dsh（DeepSeek Harness）里看不到本插件的任何配置项。排查结论：

- 设置里的「插件列表」标签页（`@deepseek-ai/dsh-client-ui-settings-plugin-inventory`）是**只读**投影，不能编辑配置。
- 可编辑配置只渲染在**插件页**（`@deepseek-ai/dsh-client-ui-plugin-manager`），且必须同时满足两个条件，缺一不可：
  1. **Host 侧**：插件条目导出 Schemastery `Config` schema，**且至少有一个字段标了 `.volatile()`**。证据：`@deepseek-ai/dsh-settings/lib/index.js:413-420` 的 `describe()` 对每个条目调用 `volatileForm(schema)`，返回 `undefined`（无 volatile 字段）的条目**直接被排除**；`:506-507` 写入时也会抛 `Plugin entry "X" has no volatile fields` / `Config field "x" is not volatile`。
  2. **浏览器侧**：插件自己往插件页的 slot 注册一个配置页。当前项目没有这一步，所以界面上什么也没有。
- 因此本方案＝补齐这两半，改动只落在本插件，不动 dsh 本体。

要点（已核实）：插件配置的持久化落在 profile 的 **patch 文件** `~/.dsh/profiles/<profile>/cordis.patch.yml`（`@deepseek-ai/dsh-config-editor/lib/index.js:24-25` `documentPath = profileContext.patchPath`；若该 id 已被更高优先级的 home patch 覆盖，保存会报 "overridden by a home patch or command-line overlay"，`:122`）。

## 配置字段（6 项）

沿用 `src/zotero/config.ts` 现有常量作默认值，schema 默认值直接引用这些常量（单一来源）：

| 字段 | 类型 / 默认 | 对应常量 | 生效点 |
|---|---|---|---|
| `zoteroBaseUrl` | string / `ZOTERO_BASE` | `http://127.0.0.1:23119` | 探活与全部本地 API 请求 |
| `mcpUrl` | string / `MCP_URL` | `http://127.0.0.1:23120/mcp` | MCP 端口探活 |
| `requestTimeoutMs` | number / `REQUEST_TIMEOUT_MS` | 5000 | 本地 API fetch 超时 |
| `mcpProbeTimeoutMs` | number / `MCP_PROBE_TIMEOUT_MS` | 800 | TCP 探活超时 |
| `fulltextMaxBytes` | number / `FULLTEXT_MAX_BYTES` | 204800 | 全文截断阈值 |
| `defaultLimit` | number / `DEFAULT_LIMIT` | 50 | 条目列表默认条数 |

保留为常量（前后端协议，不做配置项）：`LIBRARY_PREFIX`、`ROUTE_PREFIX`、`ROUTE_MATCH`、`router.ts` 的 `MAX_LIMIT`。

## 一、宿主侧改动

**1) `src/zotero/config.ts`** —— 保留现有常量作默认值，追加运行时读取面（不新建文件）：

```ts
export interface ZoteroSettings {
  zoteroBaseUrl: string
  mcpUrl: string
  requestTimeoutMs: number
  mcpProbeTimeoutMs: number
  fulltextMaxBytes: number
  defaultLimit: number
}

let readSettings = (): ZoteroSettings => ({ /* 由常量拼出的默认值 */ })

/** 由插件入口在 apply 时注入（读取 volatile 引用，始终拿到最新值）。 */
export function setSettingsReader(reader: () => ZoteroSettings): void { readSettings = reader }
export function getSettings(): ZoteroSettings { return readSettings() }
/** 派生值：探活 URL、文库前缀基址。 */
export function zoteroProbeUrl(): string { return `${getSettings().zoteroBaseUrl}/api/` }
export function libraryBase(): string { return `${getSettings().zoteroBaseUrl}${LIBRARY_PREFIX}` }
```

**2) `src/zotero/client.ts`** —— 把常量直读改为 `getSettings()` 直读（调用点取值，跨 `await` 后不复用旧值）：
- `LIB`（:101 顶层 const）→ `libraryBase()`；
- `REQUEST_TIMEOUT_MS`（:110、:210）、`ZOTERO_BASE`（:114 报错文案）、`ZOTERO_PROBE_URL`（:210）、`MCP_URL`（:224）、`MCP_PROBE_TIMEOUT_MS`（:232）、`FULLTEXT_MAX_BYTES`（:309、:312）全部改为 `getSettings()` / `zoteroProbeUrl()`。

**3) `src/host/router.ts`** —— `clampLimit()`（:77-81）改读 `getSettings().defaultLimit`，`MAX_LIMIT` 不变，`createHandler()` 签名不变。

**4) `src/index.ts`** —— 按官方规范（`docs/DSH插件开发文档/tutorial/05-config.zh.md`）导出同名 `interface Config` 与 `const Config`，`apply` 接第二个参数：

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { /* 与 ZoteroSettings 同构，带默认值说明 */ }
export const Config: Schema<Config> = Schema.object({
  zoteroBaseUrl: Schema.string().default(ZOTERO_BASE).volatile(),
  mcpUrl: Schema.string().default(MCP_URL).volatile(),
  requestTimeoutMs: Schema.number().default(REQUEST_TIMEOUT_MS).volatile(),
  mcpProbeTimeoutMs: Schema.number().default(MCP_PROBE_TIMEOUT_MS).volatile(),
  fulltextMaxBytes: Schema.number().default(FULLTEXT_MAX_BYTES).volatile(),
  defaultLimit: Schema.number().default(DEFAULT_LIMIT).volatile(),
})

export function apply(ctx: Context, config: ReturnType<typeof Config>): void {
  setSettingsReader(() => ({
    zoteroBaseUrl: config.zoteroBaseUrl.get(),
    /* …逐字段 .get()… */
  }))
  // 原有 ctx.inject(['webServer'], …) 逻辑不变
}
```

约定与理由：**逐字段 `.volatile()`**（与教程一致，避免整对象 volatile 的类型摩擦）。字段全部 volatile ⇒ 用户在 UI 保存后**无需重启 dsh**，loader 只提交新值并唤醒引用（`dsh-settings` 直接 resolveConfig）；普通字段变化才会重挂条目。数值读取处做 `Math.floor` 兜底。

## 二、浏览器侧改动

**选 `plugins.row.config` 席位**，key = `<包名>#<行 id>` = `dsh-plugin-zotero#dsh-plugin-zotero`（本包 `cordis.patch.yml` 的 insert 行 id 即此）。理由：该行会多出「配置」控件并可打开专属页；`plugins.bundle.config`（按包名）没有该控件，且已被 `voice-input` 插件占用。回退方案：`plugins.bundle.config`（key=`dsh-plugin-zotero`），页面只传 `{view:'page'}`。

**1) 新增 `src/client/ZoteroCard.tsx`** —— 结构照抄官方参考实现 `@deepseek-ai/dsh-client-ui-settings-shell/lib/client.js:60-190`：

- `class ZoteroCardController`：`new SettingsFormModel(ctx.configForms.get(ROW_ID), [settingsTextField('zoteroBaseUrl'), settingsTextField('mcpUrl'), settingsNumberField('requestTimeoutMs'), settingsNumberField('mcpProbeTimeoutMs'), settingsNumberField('fulltextMaxBytes'), settingsNumberField('defaultLimit')])`；`.bind(projection)` 得 store；`inject()` 返回 `{ hooks: { zoteroCard: store }, ...form.actions() }`（actions 含 `edit/resetField/save/discard`）；`dispose()` 释放订阅。
- 组件 `ZoteroCard(props)`：`view === 'summary'` 返回 `t('card.desc')`（行描述回退用），否则渲染 `SettingsForm`（props: `labels/state/onSave/onDiscard`）+ 每个字段一个 `SettingsValueField`（props: `id/label/hint/overriddenLabel/resetLabel/invalidLabel/numeric/disabled={!state.writable}`，`{...state.<field>}`，`onEdit/onReset` 走 `props.edit/resetField`）。
- 不要混用 `props.form.mutate`（与 model 的 scope 是同一 controller，会撞 revision）。

**2) `src/client/index.ts`**：
- `inject` 数组加 `'configForms'`；`ClientContext` 补最小接口：`configForms: { get(ns: string): unknown; whileServed(ns: string[], cb: (served: Set<string>) => () => void): () => void }`。
- 末端追加注册（`ROW_ID='dsh-plugin-zotero'`、`ROW_CONFIG_KEY='dsh-plugin-zotero#dsh-plugin-zotero'` 用常量并注明与 `cordis.patch.yml` 行 id 同步）：

```ts
const controller = new ZoteroCardController(ctx.configForms.get(ROW_ID))
ctx.effect(() => () => controller.dispose(), 'dsh-plugin-zotero: card form')
ctx.effect(() => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject('plugins.row.config',
  () => ctx.slots.register(
    { name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS, inject: () => controller.inject() },
    ZoteroCard as ComponentType<never>,
  ))), 'dsh-plugin-zotero: row config card')
```

**3) `src/client/locales.ts`**：新增 `card.title`、`card.desc`、6 个字段的 `field.*` 与 `field.*Hint`，以及表单框架文案 `save/saving/saveFailed/unavailable/readOnly/overridden/reset/invalidNumber`。

**4) `src/client/dsh-client.d.ts`**：补 `@deepseek-ai/dsh-client-ui-primitives` 的环境声明（只声明用到的符号：`SettingsForm`、`SettingsValueField`、`SettingsFormModel`、`settingsNumberField`、`settingsTextField`）。该包只发布 `lib/index.js`（无 `.d.ts`），props 最小面按 `primitives/lib/index.js` 实际实现写。

**5) `package.json`**：`dsh.client.inject` 追加 `"@deepseek-ai/dsh-client-ui-settings"`（`configForms` 提供方）与 `"@deepseek-ai/dsh-client-ui-plugin-manager"`（席位所有者），与官方配置页包 `ui-settings-shell` 的声明同形。**`tsdown.config.ts` 不需要改**（primitives 已在 neverBundle，其余走注入服务，不打进 bundle）。

## 三、风险

1. keyed 席位是否把注册时的 `inject()` 作为 props 下发，官方示例只演示了 `{t, view}` + `props.form`。若实测表单为空 ⇒ 退路：改为读 `props.form.state`、用 `props.form.mutate` 自建最小草稿（会多出一版实现）。
2. **行 id 被改写**（用户 home patch 换 id）⇒ key 不匹配，静默无控件（不报错，排查时容易误判"没生效"）。先确认 `settings.describe` 里有没有 `dsh-plugin-zotero` 命名空间。
3. `.volatile()` 漏标任何字段 ⇒ 该字段不可编辑、`describe` 可能整体不出现；写非法路径会抛 "is not volatile"。
4. 非回环页面（非 localhost）Host 持久化为 `unavailable`，表单只读；本项目本地 API 也拒绝非回环 Host 头。
5. 新增 Host schema 后需重载条目：`link:` 安装下要 `pnpm build` 并重启 dsh（configEditor 会 reconcile，但运行中的旧进程不吃新 schema）。
6. primitives 手工声明可能与真实实现漂移——只声明用到的 5 个符号。

## 四、验证

1. `pnpm build && pnpm build:client && pnpm typecheck:client` 全绿；确认 `client/client.js` 外壳仍为 `id: "dsh-plugin-zotero"`。
2. `dsh --profile demo --dump-config`：应能看到 `dsh-plugin-zotero` 行（此前无 `config` 块）。
3. Web（demo profile，`http://localhost:8123`）：插件页 → 打开 `dsh-plugin-zotero` 包 → 行上出现「配置」→ 改 `defaultLimit=10` → 保存 → 字段显示「已覆盖」，`~/.dsh/profiles/demo/cordis.patch.yml` 出现该行的 `config:` 块。
4. 生效性：保存后**不重启** dsh，`curl 'http://localhost:8123/dsh-zotero/api/items'` 返回条数 ≤10（证明 volatile 即时生效）；点「恢复默认」再保存，patch 中 config 块消失。
5. 回归：设置→插件列表（只读页）正常；右侧栏 Zotero tab 与面板功能不受影响。

## 五、文档同步

- `README.md`：新增「插件页配置项」小节（字段表、入口路径、落点、生效方式）。
- `docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md`：配置入口与字段表（名/默认/含义/影响端点）、重置与覆盖语义、patch 落点、被 home patch 覆盖时的报错现象。
- `.trae/documents/Zotero-DSH插件开发与设计方案.md`：补「配置形态」章节（原写 v1 不引入 Schemastery 配置，改为已引入 + volatile 约定）。
