# Zotero × DSH 插件：开发与设计方案

> 目标：把「文献管理留在 Zotero、研究发生在 DSH」这件事，做成一个 DSH 插件。它由三块组成：
>
> 1. **人侧**：DSH 右侧面板里浏览 Zotero 文献库（左侧层级目录 + 右侧文档详情）；
> 2. **引用**：把条目、选中文本、整个目录**插入当前会话的输入框草稿**；
> 3. **模型侧**：插件随包集成 **Zotero 集成 MCP**，模型对 Zotero 的所有操作都基于 `mcp__zotero__*` 工具。
>
> 首版范围（已与用户确认）：人侧**只读浏览 + 引用到会话**，不做界面触发的写操作。
>
> 数据源：人侧用 **Zotero 本地 API（`http://127.0.0.1:23119/api/`）**（[参考](../../docs/Zotero文档/Zotero本地API参考.md)）；模型侧用 **Zotero 集成 MCP（`http://127.0.0.1:23120/mcp`）**（[参考](../../docs/Zotero文档/Zotero集成MCP服务参考.md)）。

---

## 1. 摘要

插件 `dsh-plugin-zotero` 的形态：

| 部分 | 运行位置 | 职责 |
|---|---|---|
| Host 半（Node） | DSH 宿主进程 | 把 Zotero 本地 API 包装成只读 HTTP 端点，挂在 DSH 自己的 web server 上：`/dsh-zotero/api/*` |
| Client 半（浏览器） | DSH Web UI 页面 | 在**右侧栏**注册 tab 类型与面板：左侧分类树、右侧条目详情与全文，右键/选区「添加到会话」 |
| MCP 集成行（配置） | DSH 组合树的补丁层 | 在 `cordis.patch.yml` 里插入 `@deepseek-ai/dsh-mcp-client`，指向 `127.0.0.1:23120/mcp`，把 20 个 Zotero 工具以 `mcp__zotero__*` 暴露给模型 |

前两块通过同源 HTTP 通信（Host 注册路由、Client `fetch`），不引入新的 RPC 层。第三块不写代码，只是一条配置——但它是「装了这个插件，模型就会用 Zotero」的关键。

---

## 2. 现状分析

### 2.1 本仓库状态

- [src/index.ts](../../src/index.ts) 与 [src/client/index.ts](../../src/client/index.ts) 仍是注释掉的脚手架；[src/zotero/client.ts](../../src/zotero/client.ts) 为空文件。
- [package.json](../../package.json) 已声明 `dsh.bundle.patch`、`dsh.client`（inject locale/settings/theme，platform web）、`exports["./client"] = ./client/client.js`。
- [cordis.patch.yml](../../cordis.patch.yml) 已是合法补丁层：`insert: [{ id: dsh-plugin-zotero, name: dsh-plugin-zotero }]`。
- [tsconfig.json](../../tsconfig.json) 为 Host 侧（NodeNext/ESM/strict，`include: ["src"]`）；[tsconfig.client.json](../../tsconfig.client.json) 与 [tsdown.config.ts](../../tsdown.config.ts) 为空文件。
- 主包 devDependencies 已含 `@deepseek-ai/dsh@0.2.0-rc.2`、`@deepseek-ai/dsh-tools@0.2.0-rc.2`、`react@18`、`@types/react`、`tsdown@0.22.0`、`@deepseek-ai/schemastery`。
- `client/client.js` 为 0 字节占位（构建产物，勿手改）。

### 2.2 DSH 平台事实（从本机 `DeepSeek Harness.app` 内 `app.asar` 的包文档核实，版本线 0.2.0-rc.2）

1. **右侧栏是一等公民**：`@deepseek-ai/dsh-client-ui-sidebar-right`（0.2.0-rc.2）提供
   - 导航控制器 `ctx.sidebarRight`：`openTab(kind, options?)`、`openResource(address, options?)`、`close/focus/isExpanded/toggleExpanded/toggleFullscreen`；
   - tab 类型注册表 `ctx.sidebarRightTabs`：`register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`。
2. **tab 正文的注册席位**：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <definition.id> }, Body)`；Body 通过框架注入的 props 读取 `useTabInfo()` → `{ sidebar, panel, tab }`。
3. **右侧栏是「每会话一个停靠面」**：布局按 `dsh.sidebar-right.v1.<sessionId>` 存 localStorage；`rightbar.session` 子树渲染当前选中会话，**occurrence 继承其渲染位置的 scope**（`dsh-client-ui-slots`），因此面板组件应能拿到会话级标准 props。
4. **入口**：右侧栏隐藏时，会话 header 角落席位里有「回到面板」的按钮；展开后面板默认页（引导页）会列出各类型贡献的入口框，选中即以「页」打开该类型——**这就是我们 tab 的自然入口**（`guide` 字段）。
5. **往输入框塞文本的公开 API**：`ui-conversation` 通过 `ctx.uiSession.provide()` 把 `inputActions` 作为**稳定标准 prop** 提供，其中 `InputActions.captureInsertion()` 捕获草稿选区与版本、`insertText(text, span)` 在版本未变且编辑器可编辑时插入一次可撤销的纯文本编辑。
6. **Host 侧注册 HTTP 路由的 API**（社区插件 dshmarket 实证）：`ctx.inject(['webServer'], host => host.webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })) → disposer`。浏览器侧同源 `fetch` 即可。
7. **客户端 bundle 的加载协议**：`dsh-client-modules` 扫描已启用 loader 条目 → 读取包 manifest → 通过 `/plugins` 提供每个 `client.js`；浏览器执行 bundle 时只 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => {...} })` 注册 factory。**必须先产出 `client.js`，否则激活失败。**
8. **共享模块基座**已含 React/Cordis/静态 UI 库，`@deepseek-ai/dsh-client-ui-primitives` 由宿主冻结模块表在运行时提供；基座之外的请求才需写进 `dsh.client.external`。
9. **UI primitives 可用**：`Button / Pill / Input / Modal / Menu(open,anchor,items,onSelect,onClose) / Tooltip / DisclosureRow / 图标集 / StateDot`，足够做树行、右键菜单、选区气泡。
10. **MCP 桥接包现成**：宿主自带 `@deepseek-ai/dsh-mcp-client`（工具命名 `mcp__<serverName>__<rawName>`，服务器名 `[A-Za-z0-9_-]{1,32}` 且作用域内唯一）与 `@deepseek-ai/dsh-mcp-resources`。**默认不启用任何服务器**，每台服务器加一条配置项即可，harness 启动后工具就出现在模型工具列表中。初始连接失败**不会**中止 harness（除非 `failOnStartupError: true`），只是该服务器的工具不出现并记一条错误。

### 2.3 Zotero 本地 API 关键点（人侧只读所需）

- `GET /api/` 探活（响应头带 `Zotero-API-Version: 3`、`Zotero-Server-ID`、`Zotero-Schema-Version`）。
- 前缀 `<p>` = `/api/users/0`（当前用户）。
- 分类：`<p>/collections`（全量扁平，含 `parentCollection`）、`<p>/collections/top`、`<p>/collections/<key>/items`、`<p>/collections/<key>/items/top`。
- 条目：`<p>/items/top`、`<p>/items/<key>`、`<p>/items/<key>/children`（子条目=附件/笔记）、`<p>/items?itemKey=a,b`（多取，≤50）。
- 全文：`<p>/items/<attachmentKey>/fulltext` → `{ content, indexedPages, totalPages }`。**必须在附件条目上取，父条目不行**。
- 引用导出：`<p>/items/<key>?include=bib&style=apa`、`<p>/collections/<key>/items?format=bib&style=apa`。
- 读请求**无需鉴权**；未启用「Allow other applications…」时一律 `403`。

---

## 3. 总体架构

```
┌──────────────────────── DSH 宿主进程 (Node) ────────────────────────┐
│ 人侧数据通道                                                         │
│ src/index.ts          插件入口：ctx.inject(['webServer'], mount)    │
│ src/host/router.ts    /dsh-zotero/api/* 前缀路由 + 信任栅栏          │
│ src/zotero/client.ts  Local API 客户端（fetch, 无鉴权, 只读）        │
│                                                                     │
│ 模型侧工具通道（无自研代码，一条组合树配置）                          │
│ cordis.patch.yml ──► @deepseek-ai/dsh-mcp-client                    │
│                       serverName: zotero                            │
│                       transport : streamable-http                   │
│                       url       : http://127.0.0.1:23120/mcp        │
│                     ⇒ ctx.tools 中出现 mcp__zotero__*（20 个工具）   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ 同源 HTTP（JSON）
┌───────────────────────────┴──── DSH Web UI (浏览器) ───────────────┐
│ src/client/index.ts  inject['slots','locale','sidebarRight',       │
│                      'sidebarRightTabs']                            │
│   ├ sidebarRightTabs.register({id,kind:'zotero',title,guide})       │
│   ├ slots.register({name:'sidebar.right.pane.tab',key:id})          │
│   └ locale.register(ns,{zh,en})                                     │
│ ZoteroPane.tsx / CollectionTree.tsx / ItemDetail.tsx               │
│ api.ts / compose.ts / inline.ts                                     │
└────────────────────────────────────────────────────────────────────┘
```

**两条通道各司其职，不互相替代**：

- 人去浏览 → 本地 API。理由是 UI 需要**完整、原始、可翻页**的数据（整棵分类树、原文全文、按需分页），而 MCP 的封装带有为 token 优化的裁剪、相关性评分与分页档位，不适合直接渲染。
- 模型去操作 → MCP。检索/评分/取全文/分类增删，全部由 Zotero MCP 的 20 个工具承担，我们不重复造 `zotero_*` 工具。

---

## 4. 关键技术决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 人侧数据源 | Zotero 本地 API（23119），只读 | 浏览器直接跨端口调 23119 会撞 CORS；Host 代理后同源、无鉴权、无速率限制 |
| 模型侧能力 | **桥接 Zotero 集成 MCP，不自建工具** | 用户要求；MCP 已内置相关性评分、内容裁剪档位、全文缓存库，自建只会更差且更难维护 |
| MCP 挂载方式 | bundle patch 里插入 `@deepseek-ai/dsh-mcp-client` 一行 | 「自然集成」：装了本插件即有；卸载即随之消失；无需用户手动配置 |
| 面板位置 | 右侧栏 `sidebar.right.pane.tab` | 用户明确要求；平台原生席位，不侵入对话区 |
| tab 类型 | 页类型（不给 `patterns`），走 `guide` 入口 | 面板是「浏览整个文库」的页，不为每个条目开 tab |
| Host↔Client | `webServer` 前缀路由 + 同源 `fetch` | dshmarket 已验证；Typert RPC 需代码生成，过重 |
| 「添加到会话」 | `inputActions.captureInsertion()` + `insertText(text, span)` | 平台公开 API；插入草稿不自动发送，符合用户选择 |
| 客户端构建 | tsdown 打 CJS + 小脚本包 `__ModuleLoader__.load` 外壳 | 与宿主模块协议一致，不依赖未安装的 `dsh-client-runtime` |
| 类型声明 | 自写 `src/client/dsh-client.d.ts` | 与 dshmarket 的 `primitives.d.ts` 同法，不引入内部包依赖 |
| 插件配置 | v1 不引入 Schemastery 配置 | 遵循「避免过度工程化」；等有真实需求再加 |

---

## 5. MCP 集成（模型侧）

### 5.1 配置形态

`cordis.patch.yml` 增补一行（补丁层是**有序的 patch 条目数组**，可一次 insert 多行）：

```yaml
- insert:
    - id: dsh-plugin-zotero
      name: dsh-plugin-zotero
    - id: mcp-zotero
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: zotero
        transport: streamable-http
        url: http://127.0.0.1:23120/mcp
        toolCallTimeoutMs: 120000
```

字段取舍：

| 字段 | 取值 | 说明 |
|---|---|---|
| `serverName` | `zotero` | 决定工具前缀，最终呈 `mcp__zotero__search_library` |
| `transport` | `streamable-http` | MCP 文档实测该服务即 Streamable HTTP 单端点模式 |
| `url` | `http://127.0.0.1:23120/mcp` | 仅回环，安全边界与限制同源 |
| `toolCallTimeoutMs` | `120000` | 默认 60 s 偏紧：`search_fulltext` + 大 `contextLength`、`get_content` 大文档可能超时 |
| `failOnStartupError` | 不设（默认 `false`） | 服务没跑时 harness 照常启动，人侧面板不受影响；若设为 `true` 会让整个 harness 拒绝激活 |
| `reconnect` | 用默认 | 默认开、500 ms 起翻倍至 30 s、连续 10 次失败后移除该服务器工具 |

### 5.2 模型实际拿到什么

20 个工具全部以 `mcp__zotero__<原名>` 出现，覆盖四组能力：

- **文库与检索**：`get_libraries`、`search_libraries`、`search_library`（布尔/相关性/分页）、`search_fulltext`（带上下文命中片段）、`fulltext_database`（缓存全文库）
- **条目与内容**：`get_item_details`、`get_item_abstract`、`get_content`（PDF/附注/笔记全文）
- **标注与笔记**：`search_annotations`、`get_annotations`
- **分类目录（读写）**：`get_collections`、`search_collections`、`get_collection_details`、`get_collection_items`、`get_subcollections`、`create_collection`、`update_collection`、`delete_collection`、`add_items_to_collection`、`remove_items_from_collection`

### 5.3 与人侧面板的协同

人侧与模型侧共享同一个文库但走不同通道，二者是互补而非冗余：

- 人在面板里**看到**某条目/目录，右键「添加到会话」把它的元数据或摘录插入草稿；
- 接着在对话里说「把这个目录里 2020 年后的综述整理成表」——模型用 `mcp__zotero__get_collection_items` + `search_library` 自己去取，不必依赖人手工搬运。

因此面板的引用文本**应带上稳定标识**（`itemKey` / `collectionKey` / 条目标题），方便模型接着用 MCP 工具跟进。

### 5.4 必须正视的三件事

1. **写工具真实生效**：`create_collection` / `update_collection` / `delete_collection` / `add_items_to_collection` / `remove_items_from_collection` 会真的改动本地 Zotero 库。首版**不**给面板加任何写入口，但模型侧这些工具是暴露的——需要在文档里写清权限边界，并建议用户为写工具配置审批/权限规则。
2. **`delete_collection` 的语义**：默认只把条目移出分类、不删条目；只有显式 `deleteItems: true` 才入回收站。文档需提醒，避免「本想删条目却只删了分类」。
3. **服务未运行时的表现**：MCP 服务不在（或 23120 端口未监听）时，harness 仍启动、人侧面板照常可用，但模型工具列表里没有 `mcp__zotero__*`。文档需给出「面板可用但模型无工具」这一状态的自检步骤。

### 5.5 v2 备选（本次不实现）

- **面板兜底数据源**：本地 API 被禁用（403）时，Host 改为通过 MCP 的 `get_content` / `search_library` 取数据。代价是 MCP 返回的是被裁剪过的文本，渲染体验差于原始 API，所以只作兜底。
- **面板内写操作**：把「新建分类 / 归类条目」做成右键菜单项，Host 转手调 MCP 写工具，并在 UI 上二次确认。

---

## 6. 接口契约（Host → Client）

前缀路由 `GET /dsh-zotero/api/<action>`，统一返回 `{ok:true,data}` 或 `{ok:false,error:{code,message}}`。

| action | 参数 | 返回 data |
|---|---|---|
| `health` | — | `{ zotero: { running, apiVersion, serverId, schemaVersion }, library: { id, name } }` |
| `tree` | — | `{ collections: [{ key, name, parentKey, itemCount }], libraryName }`（扁平，Client 建树） |
| `items` | `collectionKey?` `q?` `limit?` `offset?` | `{ total, items: [{ key, title, creators, year, itemType, hasAttachment }] }` |
| `item` | `key`（必填） | `{ key, meta, abstract, tags, collections, attachments: [{key,title,contentType,size}], fulltext: { attachmentKey, content, truncated } | null, bib: string | null }` |
| `collection-bib` | `key`（必填） | `{ bib: string, count }` |

**错误码**：`zotero_unreachable`（连接失败）、`zotero_disabled`（403）、`zotero_not_found`（404）、`bad_request`。

**信任栅栏**：拒绝 `sec-fetch-site: cross-site`；Host 头必须 loopback（防御 DNS rebinding）。只读端点无需会话 cookie。

---

## 7. 分阶段实施

### Phase 0 · 打通四条链路（先验证再铺 UI）

目标：用最小产物证明四件事——宿主路由可访问、客户端 bundle 能加载、右侧栏能注册 tab、能插入草稿；**外加** MCP 集成行能被组合树接受。

1. **MCP 集成行**：改 [cordis.patch.yml](../../cordis.patch.yml)（按 §5.1 增补 `mcp-zotero` 行）。此项零成本，先做，越早知道组合树是否接受越省事。
2. `src/zotero/client.ts`：`probe()`、`listCollections()`、`getCollectionItems()`、`getItem()`、`getItemFulltext()`（Node 全局 `fetch`，`AbortSignal.timeout(5000)`）。
3. `src/host/router.ts`：`health` / `tree` / `items` / `item` 四个 action 的最小版本（`item` 先只回元数据 + 摘要）。
4. `src/index.ts`：`export const name = 'dsh-plugin-zotero'`，`ctx.inject(['webServer'], host => host.webServer.register({ kind:'prefix', path:'/dsh-zotero/', handler }))`。
5. `tsconfig.json` 加 `"exclude": ["src/client"]`；`tsconfig.client.json` 填 `{ jsx:"react-jsx", module:"ESNext", moduleResolution:"Bundler", strict, noEmit, include:["src/client"] }`。
6. `tsdown.config.ts`：`entry { client: 'src/client/index.ts' } → outDir client`、`format 'cjs'`、`platform 'browser'`、`dts false`、`external ['react','react-dom','react/jsx-runtime','@deepseek-ai/cordis','@deepseek-ai/dsh-client-ui-primitives']`。
7. `scripts/wrap-client.mjs`：把 tsdown 产物包成
   `window.__ModuleLoader__.load({ id: "dsh-plugin-zotero", factory: (require) => { var module = { exports: {} }; var exports = module.exports; <body> return module.exports; } });`
   `package.json` 的 `build:client` 改为 `tsdown && node scripts/wrap-client.mjs`。
8. `src/client/index.ts`：注册最小 `sidebar.right.pane.tab` 面板，显示 health 结果 + 一个按钮调用 `inputActions.insertText('ping\n')`。
9. `src/client/dsh-client.d.ts`：为 `ctx.slots` / `ctx.sidebarRight` / `ctx.sidebarRightTabs` / `ctx.locale` 与 `@deepseek-ai/dsh-client-ui-primitives` 写最小环境声明。

**Phase 0 出口条件**（逐条验证，见 §9）：引导页出现 Zotero 入口 → 打开面板 → 显示 Zotero 版本号 → 点按钮后输入框出现 `ping`；且 `--dump-config` 里能看到 `mcp-zotero` 行、模型工具列表里能看到 `mcp__zotero__*`。

> 若第 8 步发现面板 props 上拿不到 `inputActions`，改用 props 上同源的 `useInput()` 取 input source；两者都不行时，退路是在对话输入区注册一个最小控件承载「插入」动作——先按前两条验证，不要提前实现退路。

### Phase 1 · Host 半边做完整

1. `src/zotero/types.ts`：`ZoteroCollection`、`ZoteroItemSummary`、`ZoteroItemDetail`、`ZoteroAttachment`、`ApiResult<T>`。
2. `src/zotero/client.ts` 补齐 `getItemChildren()`、`getItemBib()`、`getCollectionBib()`、`listTopItems()`、`getItemsByKeys()`；条目→子附件→`/fulltext` 的解析（**全文只在附件条目上取**）；全文单条截断 200 KB。
3. `src/host/router.ts` 补齐 5 个 action；Host 只回原始数据，文案拼接留给 Client。
4. `src/zotero/config.ts`：`ZOTERO_BASE = 'http://127.0.0.1:23119'`、`LIBRARY_PREFIX = '/api/users/0'`。
5. 错误归一化：`fetch` 抛错 → `zotero_unreachable`；`403` → `zotero_disabled`（附启用步骤文案）。

### Phase 2 · 右侧面板骨架

1. `src/client/ZoteroPane.tsx`：左右两栏（左栏默认 260px、可由中间分隔条拖动调宽并记住 / 右自适应详情），各自滚动；顶部一行含文库名与刷新按钮。右栏条目详情的「正文 / 参考文献」上下分区同样可拖动（`ItemDetail.tsx`，默认 80% / 20%，占比存 localStorage）。
2. `src/client/api.ts`：`getHealth/getTree/getItems/getItem/getCollectionBib`，统一把 `{ok:false}` 转成可展示错误。
3. 组件内状态机：`selectedCollectionKey | selectedItemKey`、`loading`、`error`；列表与详情各缓存最近一次结果。
4. 空态/错误态文案：未运行 Zotero、本地 API 未开放、文库为空。

### Phase 3 · 目录树与详情

1. `src/client/CollectionTree.tsx`：根节点「我的文库」→ 顶层条目；其下按 `parentKey` 建嵌套分类；展开时按需拉条目（`limit=200`），不预取全库；行是自绘的树行（常显三角箭头 + 文件夹/文档图标 + 右侧条目数，缩进按 `depth * 14px` 一次算好），选中态用行底色；`onContextMenu` 用 primitives `Menu` 弹「添加到会话」。
2. `src/client/ItemDetail.tsx`：元数据块（标题、作者、年份、`publicationTitle`、DOI/URL、标签）→ 摘要 → 附件列表（点击加载全文）→ 全文块；全文容器 `onMouseUp` 检测非折叠选区，浮出「添加到会话」小按钮。
3. `compose.ts` 三种文本模板（被三处调用）：
   - 单条目：`【Zotero 条目｜<itemKey>】标题 / 作者 / 年份 / DOI / 摘要`（可选 BibTeX）；
   - 选中文本：`【Zotero 摘录｜<条目标题>｜<itemKey>】\n"<原文>"`（**保留原始措辞**，不改写）；
   - 整个目录：`【Zotero 目录｜<分类名>｜<collectionKey>】共 N 条` + 每行 `- 标题（作者, 年）`；超过 50 条截断并注明。

   带 `itemKey` / `collectionKey` 是刻意设计：插入后用户可以让模型直接用 `mcp__zotero__*` 工具接着操作同一批文献。

### Phase 4 · 引用到会话

1. `src/client/inline.ts`：`insertIntoDraft(text)` = `inputActions.captureInsertion()` → `inputActions.insertText(text, span)`；插入后不改焦点、不发送。
2. 三处接线：树右键（整目录/单条目）、详情头部按钮（整条目）、选区气泡（选中文本）。
3. 兜底：`insertText` 被拒（草稿版本变了/编辑器不可编辑）时用 `Modal` 展示可复制文本 + 「复制到剪贴板」，不静默失败。
4. `ctx.locale` 字典（命名空间 `dsh-plugin-zotero`，zh + en）。

### Phase 5 · 打包与文档

1. `package.json`：`dsh.client.inject` 改为 `["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-conversation"]`；确认 `files` 含 `client`。
2. 在 `docs/` 下新增插件使用说明，至少覆盖：安装、开启 Zotero 本地 API、面板入口、三种引用方式、**MCP 集成的权限边界与写操作提醒**、常见错误。

---

## 8. 假设与风险

**假设**

- A1：Zotero 为 10.x 且已勾选「Allow other applications on this computer to communicate with Zotero」；否则面板显示引导文案（`403`）。
- A2：文库规模在数万条以内；树按需加载 + 每层 `limit=200` 足够。
- A3：右侧栏面板 occurrence 继承会话 scope，因此 props 上有 `inputActions` 或 `useInput`（Phase 0 首要验证项）。
- A4：组合补丁层允许一个 bundle 插入**不属于自己**的插件行（MCP 桥接行）。文档只明确「patch 是 patch 条目的数组」，未列举此限制；Phase 0 第 1 步用 `--dump-config` 立即证伪或证实。
- A5：`sidebar.right.pane.tab` 的 `title`/`guide` 契约在 0.2.0-rc.2 稳定；若有出入，以 `app.asar` 内 `dsh-client-ui-sidebar-right` 的 `lib/types/**` 为准（可用同样的 asar 读取方式核对）。

**风险与对策**

- R1（高）**客户端 bundle 的开发期加载**：bundle 的浏览器身份来自「Loader 条目解析出的包 manifest」。以绝对源码路径挂载的条目没有 manifest，客户端半边不会加载。
  → 对策：开发期用 `dsh plugin --profile desktop add /Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero` 安装，改客户端代码后先 `pnpm build:client`。Phase 0 一并验证。
- R2（中）**`__ModuleLoader__` 外壳格式**：靠小脚本包装，需实测。
  → 对策：客户端代码只用 ESM 静态 import，不碰 Node 内建；必要时改用 rolldown 原生 `banner/footer` 输出选项。
- R3（中）**`insertText` 时机**：卡在草稿版本变化上。
  → 对策：点击瞬间先 `captureInsertion()`，异步取文本再插入；被拒走 Modal 兜底。
- R4（低）**全文 OCR 噪声**：`/fulltext` 可能含识别错误。
  → 对策：摘录时原文照抄，并在模板里注明来源条目与页码信息（`indexedPages/totalPages`）。
- R5（低）**key 混淆**：本地 API 的 `/fulltext` 只认附件条目。
  → 对策：父条目→子附件的解析统一在 Host 侧做，Client 不感知。
- R6（高）**模型侧写工具会真实改动 Zotero 库**（`create_collection` 等 5 个）。
  → 对策：文档明确权限边界；建议向导用户配置审批规则；R6 与「模型可能误解 `delete_collection` 默认语义」合并为同一段提醒。
- R7（中）**MCP 服务未运行时的静默缺失**：harness 照常启动，只是没有工具，用户易误以为插件失效。
  → 对策：面板 health 里同时探测 23120（一次轻量 `initialize` 握手或 TCP 探活），在面板顶部显示「模型工具：可用/不可用」，文档给自检步骤。
- R8（低）**端口均为回环绑定**：`23119`/`23120` 都只在 `127.0.0.1`，这既是安全边界也是硬限制——异机/容器内不可用。

---

## 9. 验证步骤

Host 侧：

1. `curl -s -i http://127.0.0.1:23119/api/` → `200` + `Zotero-API-Version: 3`（不通过先开 Zotero 设置）。
2. `curl -s -i -X POST http://127.0.0.1:23120/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'` → 返回 `serverInfo.name = zotero-integrated-mcp`。
3. `pnpm build` 无报错；`pnpm build:client` 产物以 `window.__ModuleLoader__.load({ id: "dsh-plugin-zotero"` 开头；`pnpm typecheck:client` 无报错。
4. `dsh --profile desktop --dump-config` → 同时出现 `# dsh-plugin-zotero` 与 `# @deepseek-ai/dsh-mcp-client`（`mcp-zotero`）两行。
5. 启动后 `curl -s http://127.0.0.1:<port>/dsh-zotero/api/health|tree|items|item` → 结构符合 §6。
6. 模型侧：在会话中问「我 Zotero 里有哪些文库」→ 模型调用 `mcp__zotero__get_libraries` 并答对（证明工具真的接上了）。

Client 侧（桌面 App）：

7. 展开右侧栏 → 引导页出现 Zotero 入口 → 点击打开面板 → 分类树加载。
8. 展开分类 → 条目列表出现；点条目 → 右侧详情出元数据/摘要；点附件 → 全文加载。
9. 树节点右键「添加到会话」→ 草稿出现目录清单文本，且**未自动发送**。
10. 全文里选中一段 → 浮出「添加到会话」→ 草稿出现带条目标题与 `itemKey` 的原文摘录。
11. 接上第 10 步：对模型说「用工具把刚才这个条目的完整摘要取出来」→ 模型用 `mcp__zotero__get_item_abstract` 或 `get_content` 成功执行（证明人侧引用与模型侧工具能协同）。
12. 关掉 Zotero（或关掉 MCP 服务）分别验证：本地 API 断开时面板显示可读错误；MCP 断开时模型无工具但面板仍可用。

---

## 10. 明确不做（v1）

- 面板触发的写操作（新建/删除分类、条目归类、写回 Zotero）——模型侧写工具由 MCP 提供，面板不参与；v2 再考虑把部分写操作做成右键菜单。
- 自研 `zotero_*` 工具——模型能力**全部**来自 Zotero 集成 MCP，不重复实现。
- 群组文库切换（固定 `/api/users/0`）、已保存搜索、标签视图、附件二进制下载。
- 面板内的分栏/浮窗自定义（沿用右侧栏默认 `push` 呈现）。
