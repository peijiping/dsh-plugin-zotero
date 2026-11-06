# dsh-plugin-zotero

**把 Zotero 文献库映射进 DSH：在同一个界面里精读文献，与 AI 同步作业。**

本插件把 Zotero 的文库结构、元数据、PDF 全文、笔记与标注接入 DSH，将「检索文献 — 精读全文 — 摘录标注 — 与模型讨论 — 形成稿子」收进同一条工作流：右侧栏按分类与标签浏览文库，按标题 / 摘要筛选当前范围，双击条目即在 DSH 内打开独立阅读页，PDF 整页渲染、高亮原位叠加，同一篇文献的原文与译本附件可在页内切换；读到关键段落时可直接划词摘录，或引用该条标注、笔记乃至整篇文献，以引用胶囊写进当前会话草稿，模型随即基于原文接续完成综述、方法对比、数据提取与引文核对。

模型侧同样具备完整的检索与整理能力：检索文库、精读 PDF、汇总高亮与笔记、按主题新建分类并归类，也可以把本地下载的论文导入 Zotero，读完外文文献后把译文作为附件回挂到对应条目。凡 Zotero 本地接口与集成 MCP 能提供的操作，均可由模型代劳。

不用写代码，也不用记命令。第一次使用前，只需在 Zotero 里完成两项一次性设置（装一个桥接小插件、打开通信开关），步骤见[使用前提](#使用前提)。

## 截图

[![DSH 右侧栏中的 Zotero 文献库面板](docs/images/zotero-pane.png)](docs/images/zotero-pane.png)

<sub>上图为 DSH 会话与右侧「Zotero 文献库」面板：左侧分类树与标签面板，右侧是当前范围的条目列表；双击条目会在右侧栏顶层单开一个标签页，整页展示 PDF（可缩放、叠加高亮标注），元数据、摘要、笔记、标注与附件收进左上角的信息按钮。点击图片可查看原图。</sub>

[![在 DSH 内边读 PDF 边与 AI 交互](docs/images/zotero-reading-with-ai.png)](docs/images/zotero-reading-with-ai.png)

<sub>上图为 DSH 内的文献阅读现场：右侧标签页整页渲染 PDF（图为译文附件，原文与译本可在信息面板切换），点正文里的高亮标注即弹出标注卡片，原文、类型与「引用 / Zotero」入口都在手边；左侧会话里该段原文已作为引用写入草稿，模型据此继续作答。点击图片可查看原图。</sub>

它能替你做的事，举几个常见例子：

- **找文献**：按标题、年份、全文关键词检索，也能跨库搜高亮和批注，快速回答「我收过哪些讲 XX 的文章」；右侧栏里还能按分类、标签和标题 / 摘要逐层缩小范围。
- **读文献**：双击条目就在 DSH 内开独立阅读页，PDF 整页渲染、高亮原位叠加，原文与译本附件随时切换；摘要、全文、笔记与标注都能在这里读完，写综述、做对比、提取数据都行，需要精确引用时会保留原文措辞。
- **整理文库**：新建、重命名、移动、删除分类，批量把条目加入或移出分类。你说一句「把这几篇归到『待读』里」，它就照做。
- **帮你入库**：把本地下载好的论文、PDF 交给 DSH 导入 Zotero；也可以让它读完外文文献后，把译文作为附件挂回条目。
- **带进对话**：右侧面板单条目引用、列表多选批量引用、阅读页划词摘录与点高亮引用、单标签或多标签引用、整分类引用，一键写进当前会话草稿（不自动发送），你再接着说要求。条目、标签和整分类以「引用胶囊」的形式出现，草稿里一眼看清引了哪几篇，单独删掉某一条也不影响其他内容。
- **安全可控**：浏览面板严格只读；模型能用的每一项工具都能单独开关，想彻底只读就把写操作关掉；写操作优先走集成 MCP，它在 Zotero 进程内直接执行，不触发本地 API 的授权弹窗。

面板布局与 Zotero 本体一致：顶部状态栏显示连接状态并提供刷新；左侧是分类树，树下是可拖高、可折叠的标签面板；右侧列表显示当前范围（分类 / 全库 / 标签筛选后）的条目。分类树与条目列表之间的分隔条可拖动，宽度按本机记住。列表里单击条目选中、`Ctrl` / `Cmd` 点选多选，双击才在右侧栏顶层单开一个标签页看详情。阅读页就开在会话旁边的标签里，边读边摘、边问边改，不必在 Zotero 与 AI 两个窗口之间来回切换。

> 面向使用者的完整说明（入口、交互、toast 与错误对照表）见 [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)。

## 安装

要求 dsh ≥ 0.2.1-rc.3（`package.json` 的 `engines.dsh` 为 `>=0.2.1-rc.3 <0.3.0-0`）。

```sh
# 从 npm（推荐）
dsh plugin --profile <profile> add dsh-plugin-zotero

# 或从插件市场安装：dsh 插件页 → 发现 → 添加索引源
#   https://awesome-dsh-plugin.com/index.json
```

包内是预构建产物（`lib/` + `client/client.js`），安装时**不运行构建脚本**，无需 `allowBuilds` 授权。本地源码开发见[方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)。

## 使用前提

使用本插件前，本机 Zotero 需备好两件事：**集成 MCP 插件**与**本地 API**。

### 1. 安装 Zotero MCP 插件

在 Zotero 的插件市场搜索 `mcp`，安装列表第一行、标签为 `ai` / `integration` 的 **Zotero MCP Plugin**（即 `zotero-integrated-mcp`）。装好后无需额外配置，默认监听 `http://127.0.0.1:23120/mcp`。

[![Zotero 插件市场中安装 Zotero MCP Plugin](docs/images/zotero-mcp-plugin-market.png)](docs/images/zotero-mcp-plugin-market.png)

<sub>上图为 Zotero 插件市场，第一行「Zotero MCP Plugin」已安装。</sub>

如果装的是**其他** MCP 插件，或它的监听地址 / 端口不是 23120，到 dsh「插件」面板展开 `dsh-plugin-zotero` → 「配置 dsh-plugin-zotero」，把 **MCP 设置 → `mcpUrl`** 改成实际端点（如 `http://127.0.0.1:<端口>/mcp`）并保存，即时生效，无需重启。字段说明见[插件页配置项](#插件页配置项)。

> 没装 MCP 插件不影响右侧面板使用，只是模型侧 `mcp__zotero__*` 工具不可用。

### 2. 开启 Zotero 本地 API

Zotero → 设置 → 高级 → 勾选 **「允许此计算机上的其他应用程序与 Zotero 通信」**（默认端口 23119，仅监听回环）。

[![在 Zotero 高级设置中允许其他应用与 Zotero 通信](docs/images/zotero-allow-communication.png)](docs/images/zotero-allow-communication.png)

<sub>上图为 Zotero「设置 → 高级」中开启本地 API 的开关。</sub>

验证：

```sh
curl http://127.0.0.1:23119/api/   # 期望输出：Zotero is running
```

未勾选时读端点返回 403，面板显示「Zotero 未连接」并提示启用步骤。

## 特性

- **右侧栏面板「Zotero 文献库」**：与 Zotero 本体同构——顶部状态栏（Zotero / 模型工具探活 + 刷新），左侧分类树与标签面板，右侧是当前范围的条目列表；条目独立成列。分类树与条目列表之间的分隔条可拖动，宽度按本机记住。
- **分类筛选**：分类树顶部可按名称筛选目录（同 Zotero 左栏：只筛目录名，命中项与祖先保留、自动展开，不影响右侧条目搜索）。
- **条目列表**：每行显示文献类型图标与作者 / 年份；读过的文献类型图标转为粉色、标题略淡，悬停补上类型名与最后阅读时间。单击选中、`Ctrl` / `Cmd` 点选多选，双击在右侧栏顶层开独立详情页，右键单行可直接插引用；头部搜索框针对当前范围（分类 / 全库 / 标签筛选后）按标题与摘要过滤，列表可分页「加载更多」，选中多条时右上角一次「引用 N」。
- **标签面板**：树下方独立面板，可拖高 / 折叠；标签按 Zotero 的换行胶囊排布并跟随当前目录：选中分类时只列该分类自身条目里出现过的标签（不含子目录，自动标签弱化显示），选中文库根时列出全库标签；可按名称筛选、多选，并切换「全部（AND）/ 任一（OR）」。筛选作用于当前选择的范围，列表头部会显示已选标签胶囊与「清除筛选」；切换目录会自动清除已选标签，避免旧筛选作用到新范围。已选标签可从摘要行合并成一枚「标签组」胶囊引用。
- **条目详情独立成页**：双击条目在右侧栏顶层新开一个标签页，同一条目再次双击只回到已有页；详情页可同时开多个，切换标签页时各自的展开状态与滚动位置都保留（正文常驻挂载）。
- **文档优先版面**：详情页整页显示文献本体——PDF 走 PDF.js 渲染（顶部工具栏缩放、页码、当前页在 Zotero 中打开），没有 PDF 时回退到 API 全文文本。左侧固定的 30px 工具栏不遮挡正文。选中正文即浮出「摘录」按钮，点正文里的高亮则弹出标注卡片（类型、原文、「引用」与「在 Zotero 中打开」）。
- **左上角信息面板**：点左上角 `i` 按钮弹出浮层，把文献信息 / 摘要 / 标注 / 笔记 / 附件 / 参考文献分块竖排，每块可单独折叠；点浮层外或按 `Esc` 关闭，点标注定位时自动关闭把焦点还给文档。
- **笔记可读**：独立笔记（文库里的全局笔记）打开后正文直接占据文档区，跟普通条目一样阅读；子笔记在信息面板的「笔记」块里折叠呈现，正文保留 Zotero 的引用块、标注高亮、表格与外链图片。Host 侧已清洗脚本与事件属性，避免注入。「引用」把该条笔记转成纯文本写进会话草稿。
- **标注可读**：PDF 上的高亮与划线原位叠加在页面上，点页内标注弹出卡片，可当场「引用」或跳回 Zotero 对应页；「标注」块按类型 / 颜色筛选，点条目可跨附件定位、滚动并闪烁，「引用」把该条标注写进会话草稿。
- **多种插入方式**：单条目、列表多选批量、单标签、多标签（合并成一枚「标签组」胶囊，AND/OR 在插入那一刻定格）与整目录引用都以「引用胶囊」写进草稿——胶囊只显示标题，发送那一刻才展开成完整引用文本，模型拿到的内容与以前一致；全文划词摘录、单条标注、单条笔记仍按纯文本插入。所有方式都只写进会话草稿（不自动发送、不抢焦点），文本携带 `itemKey` / `collectionKey` / 标签名供模型接续操作。标签类引用始终按全库范围展开，不受你当时选中哪个分类影响。
- **胶囊依赖本插件展开**：草稿里留着引用胶囊时禁用或卸载本插件，发送会失败并提示找不到引用来源，把胶囊删掉即可继续正常发送。
- **面板严格只读**：不提供任何新建 / 改名 / 删除分类的按钮。
- **模型侧工具可逐个开关**：插件自持连接集成 MCP，把工具以 `mcp__zotero__*` 注册进 dsh，可在插件页按工具启用 / 禁用。

## 插件页配置项

在 dsh 顶部的「插件」面板里展开 `dsh-plugin-zotero`，点组件行上的「配置 dsh-plugin-zotero」，即可调整连接参数。表单分两组。

**API 设置**（本地 API 与面板行为）

| 字段 | 默认 | 生效点 |
|---|---|---|
| `zoteroBaseUrl` | `http://127.0.0.1:23119` | Zotero 本地 API 探活与全部请求 |
| `requestTimeoutMs` | `5000` | 单次本地 API 请求超时 |
| `fulltextMaxBytes` | `204800` | 附件全文返回上限（超出截断） |
| `defaultLimit` | `50` | 面板条目列表默认拉取条数 |

**MCP 设置**（集成 MCP 连接与工具清单）

| 字段 | 默认 | 生效点 |
|---|---|---|
| `mcpUrl` | `http://127.0.0.1:23120/mcp` | 集成 MCP 探活、工具列表与工具调用 |
| `mcpProbeTimeoutMs` | `800` | TCP 探活集成 MCP 端口超时 |
| `disabledMcpTools` | `[]` | 被停用的 MCP 工具**原始名**；模型侧据此过滤注册 |

MCP 组下方是 **「MCP 工具」** 区：现场列出集成 MCP 的全部工具（`mcp__zotero__<原始名>` + 描述），每行右侧一个开关。关掉某个工具并保存后，模型侧不再注册它（等价于从模型的工具表里摘掉）；「重新读取」可重拉清单。开启配置卡或保存后各同步一次工具注册。

保存与重置：

- 保存写入 profile 的 patch 层 `~/.dsh/profiles/<profile>/cordis.patch.yml`。
- 所有字段走 Schemastery `.volatile()`，只提交新值并唤醒引用，**无需重启**即时生效；工具开关同理（写进 `disabledMcpTools` 字段）。
- 字段旁的「已覆盖」表示该值来自 patch 层而非默认值；点「恢复默认」清掉覆盖。若该值被更高优先级的 patch 层覆盖，保存会报「被覆盖」错误。
- 「设置 → 内置插件」是只读清单，不提供编辑入口；配置入口只在「插件」面板。

实现：Host 半在 [src/index.ts](src/index.ts) 导出 `Config` schema、注入读取器（[src/zotero/config.ts](src/zotero/config.ts) 的 `setSettingsReader`）并驱动 [src/host/mcp-bridge.ts](src/host/mcp-bridge.ts)；Client 半在 [src/client/ZoteroCard.tsx](src/client/ZoteroCard.tsx) 渲染配置卡（席位 key `dsh-plugin-zotero#dsh-plugin-zotero`）。

## 架构

从使用者视角看，插件分两半，职责不重叠、互不依赖：

| 半边 | 能力 | 通道 |
|---|---|---|
| **人侧面板** | 在 DSH 右侧栏只读浏览 Zotero 文库（分类树 / 标签面板 / 条目列表 / 搜索 / 条目详情 / 笔记 / 标注 / PDF 阅读），把条目（含多选批量）、摘录、标注、笔记、标签或整目录引用写进会话草稿 | 插件在宿主 web server 自注册的 `/dsh-zotero/api/*` 路由 |
| **模型侧** | 检索、精读、按需操作文库 | 插件**自持**连接本机 Zotero 集成 MCP，工具以 `mcp__zotero__*` 注册给模型 |

MCP 没起，面板照常可用；Zotero 没开，模型工具自然也不可用。

代码分布：

| 半边 | 代码位置 | 通道 |
|---|---|---|
| Host | `src/index.ts`、`src/host/`、`src/zotero/` | 把 Zotero 本地 API 包装成只读 HTTP 端点，挂在 DSH 宿主 web server 上 |
| Client | `src/client/` | 在右侧栏注册 tab、面板正文与插件页配置卡，数据与选择状态放在模块级单例 |

两条数据流：

```
人侧    浏览器面板 ──同源 fetch──▶ /dsh-zotero/api/*（Host 路由）──HTTP──▶ Zotero 本地 API（127.0.0.1:23119）
模型侧  启动 / 配置卡打开 ──sync──▶ 集成 MCP（127.0.0.1:23120）──注册──▶ dsh 工具表（mcp__zotero__*）
```

- Host 路由为 `GET /dsh-zotero/api/<action>`，action 有 `health` / `tree` / `items` / `tags` / `item` / `collection-bib` / `mcp-tools`。`items` 支持 `tag`（重复出现为 AND，`A || B` 为 OR）与 `q` 组合过滤。
- Host 侧带信任栅栏：仅接受 GET，拒绝 `sec-fetch-site: cross-site`，且 `Host` 必须是回环地址（防 DNS rebinding）。
- 响应统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`，错误码见 [src/zotero/types.ts](src/zotero/types.ts)。
- 条目详情里的笔记由 Host 侧从 `itemType: "note"` 子条目提取并清洗 HTML（剥离脚本、事件属性与冗余 `data-*`，图片限宽），Client 只负责折叠展示。
- 面板正文会被每个会话各挂一份，因此分类树 / 条目列表 / 标签选中 / 搜索词等状态放在 [src/client/paneStore.ts](src/client/paneStore.ts) 的模块级单例里，各会话看到的是同一块面板；右侧栏的展开状态与 tab 则**按会话**持久。条目详情的取数状态在各自 tab 组件内，互不干扰。
- 无会话时面板仍可通过右侧栏的 guide 入口（「Zotero 文献库」）打开。

## 目录结构

```
src/                      # 插件源码（主包，ESM / NodeNext / strict）
├── index.ts              # Host 半入口：Config schema、HTTP 路由、MCP 桥接装配
├── host/
│   ├── router.ts         # 只读 HTTP 路由 GET /dsh-zotero/api/<action>
│   └── mcp-bridge.ts     # 自持集成 MCP 连接 + 按开关过滤注册模型工具
├── zotero/
│   ├── client.ts         # Zotero 本地 API 客户端（只读）+ 笔记提取清洗 + 集成 MCP JSON-RPC
│   ├── config.ts         # 端点 / 超时 / 截断阈值 + 运行时设置读取器
│   └── types.ts          # Host ↔ Client 数据契约
└── client/               # Client 半（浏览器）
    ├── index.ts          # 注册右侧栏 tab（面板 + 条目详情）、面板正文与插件页配置卡
    ├── ZoteroCard.tsx    # 插件页配置卡（API 设置 / MCP 设置 / 工具开关）
    ├── ZoteroPane.tsx    # 面板容器：状态栏 + 分类树 / 标签面板 + 条目列表
    ├── CollectionTree.tsx / TagPanel.tsx / ItemList.tsx
    ├── SearchField.tsx   # 目录筛选 / 条目搜索 / 标签筛选共用的紧凑搜索框
    ├── itemType.tsx / readState.tsx       # 文献类型图标与已读标记
    ├── ZoteroItemPane.tsx  # 条目详情 tab 的正文与标题
    ├── ItemDetail.tsx    # 文档优先详情：选附件 / 跨附件定位 / 打开 Zotero
    ├── InfoPanel.tsx     # 左上角悬浮信息面板（可分块折叠）
    ├── viewer/           # 渲染器注册表 + PDF.js 渲染 / 文本回退 / 标注叠加与几何换算
    ├── AnnotationList.tsx / NoteList.tsx    # 标注与笔记列表
    ├── Toast.tsx         # 插入结果等轻提示
    ├── reference.ts / cite.ts  # 引用胶囊的 ref 编码与提交时的文本展开
    ├── useInsertion.ts / inline.ts        # 往会话草稿插入胶囊或纯文本
    ├── styles.ts         # 强调色等共用样式常量
    ├── paneStore.ts      # 跨会话共享的面板状态
    ├── compose.ts        # 插入文本模板
    ├── api.ts            # 调 Host 端点
    └── locales.ts        # zh / en 文案

client/client.js          # tsdown 产物（勿手改）
lib/                      # tsc 产物（勿手改）
cordis.patch.yml          # bundle patch 层：把本插件插入 profile 层栈
docs/                     # 使用说明、Zotero API / MCP 参考、发布与 node 学习笔记
tstest/                   # 独立测试沙盒（commonjs + tsx，与主包隔离）
plugin_helloword/         # 官方插件示例（学习用，勿放正式代码）
.trae/documents/          # 设计与实施方案（本地，未纳入版本控制）
```

主包与子项目分别有各自的 `package.json`；测试沙盒 `tstest/` 环境独立，其依赖不得引入主包。

## 环境要求

- Node + **pnpm**（主包与 `tstest/` 统一用 pnpm，勿与 npm / yarn 混用）。
- **TypeScript ^5.9**：`tsdown@0.22.0` 的 peer 依赖不支持 TypeScript 7.x。
- Zotero 桌面版已运行，且已开启本地 API（见[使用前提](#使用前提)）。
- **模型侧必需**：Zotero 已安装集成 MCP 插件（插件市场中的 **Zotero MCP Plugin** / `zotero-integrated-mcp`），监听 23120——若用其他 MCP 插件或端口不同，需在插件配置卡改 `mcpUrl`；并在 MCP 插件设置中**开启「允许写操作」**。只装插件不开写操作时，模型侧读类工具照常，但让模型新建 / 修改分类会直接报错（插件返回「写操作已禁用」）。详见[模型侧 MCP 与权限边界](#模型侧-mcp-与权限边界)。
- `dsh` CLI 可用。

## 构建

```sh
pnpm install
pnpm build            # tsc：src/ -> lib/（Host 半边）
pnpm build:client     # tsdown：src/client/ -> client/client.js（Client 半边）
pnpm typecheck:client # tsc --noEmit 校验客户端源码
```

## 本地测试启动

本地路径 link 的完整操作见 [方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)，核心三步：

```sh
dsh plugin --profile demo add ./
dsh --profile demo --dump-config   # 应能看到 dsh-plugin-zotero 一行
dsh --profile demo                 # 启动
```

- **访问地址**：启动后终端会打印 URL（web server 配置 `printUrl: true`），浏览器打开 **http://127.0.0.1:3080**。该地址来自 profile 组合配置里的 web server（`host` 默认 `127.0.0.1`、`port` 默认 `3080`），不是固定端口之外另开的服务。
- **命令来源**：`dsh` 是桌面 App 自带的 CLI（如 `/usr/local/bin/dsh`）；仓库里也装了同一 CLI 的 devDependency，等价写法是 `pnpm dsh --profile demo`，两者读同一个 `~/.dsh/profiles/demo`。
- **启动前**：Host 半边与 Client 半边加载的都是构建产物（`lib/`、`client/client.js`），改完 `src/` 要先按上一节构建，再重启 dsh（见「日常迭代」）。

## 日常迭代

| 改了什么 | 要做什么 |
|---|---|
| `src/`（Host 半边） | `pnpm build` → 重启 dsh |
| `src/client/`（Client 半边） | `pnpm build:client` → 重启 dsh → 浏览器重新打开页面 |
| `cordis.patch.yml` | 重启 dsh |

客户端 bundle **没有热更新**：改完必须重启 dsh 并重新加载页面。

## 配置

### 开启 Zotero 本地 API

见[使用前提 → 开启 Zotero 本地 API](#2-开启-zotero-本地-api)。未勾选时读端点返回 403，面板显示「Zotero 未连接」并提示启用步骤。

### 模型侧 MCP 与权限边界

模型侧工具由**插件自己**桥接：[src/host/mcp-bridge.ts](src/host/mcp-bridge.ts) 直连本机 Zotero 集成 MCP（本机实测暴露 25 个工具），按配置里的 `disabledMcpTools` 过滤后以 `mcp__zotero__*` 注册给模型。[cordis.patch.yml](cordis.patch.yml) **不再**插入 `@deepseek-ai/dsh-mcp-client` —— 它不支持按工具开关，且同 `serverName` 会与自注册工具重名冲突。

⚠️ 前提是 [Zotero 里已装好集成 MCP 插件](#1-安装-zotero-mcp-插件)（或改用其他 MCP 插件并在配置卡填对 `mcpUrl`），并且开启了「允许写操作」。插件未安装或服务未起时，模型侧工具全部不可用；插件装了但没开写操作时，读类工具正常，`create_collection` 等写工具会被插件拒绝（返回「写操作已禁用」），表现为让模型帮忙新建分类直接报错——此时到 MCP 插件设置里打开写操作并重试即可，无需重启 dsh。

⚠️ 面板只读，**但模型侧工具不是**：25 个工具中含 10 个写工具（`write_item` / `write_note` / `write_tag` / `write_metadata` / `add_by_identifier` / `create_collection` / `update_collection` / `delete_collection` / `add_items_to_collection` / `remove_items_from_collection`）。想收紧为纯只读，直接在插件页配置卡的「MCP 工具」里关掉它们并保存即可；面板功能不受影响。

**写操作为什么优先走 MCP**：这些工具在 Zotero 进程内直接改库，不经过本地 API，因此**不会触发 Zotero 的「本地 API 授权」弹窗**。反过来，若让模型用 shell/curl 直接打 `127.0.0.1:23119` 的写接口，就必须先用 `POST /api/local/authorize` 换 key —— 该端点每次调用都会弹一次授权框，用户点「允许」拿到的 key 还是一次性的（首个写请求即被 Zotero 删除），这就是「每写一次就要点一次允许」的根源。为此插件在 [mcp-bridge.ts](src/host/mcp-bridge.ts) 里给所有写工具的描述统一注入了「首选写通道」引导语；「导入本地文件并挂到某条目下」用 `write_item` 的 `action: "import"` + `filePath` + `parentItemKey`，一条工具调用即可。

## 相关文档

- [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md) — 入口、交互、toast 与错误对照表
- [Zotero 本地 API 参考](docs/Zotero文档/Zotero本地API参考.md)
- [Zotero 集成 MCP 服务参考](docs/Zotero文档/Zotero集成MCP服务参考.md)
- [方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)
- [DSH 插件开发文档](docs/DSH插件开发文档/README.zh.md)
- [开发与设计方案](.trae/documents/Zotero-DSH插件开发与设计方案.md)（本地）

## License

[MIT](LICENSE)
