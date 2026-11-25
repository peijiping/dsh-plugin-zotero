# dsh-plugin-zotero

**把 Zotero 文献库搬进 DSH：用 AI 检索、精读、整理文献，让原文与模型直接对话。**

插件把 Zotero 的个人文库与群组文库、分类、已保存搜索、标签、条目元数据、期刊指标、PDF 全文、笔记与标注接进 DSH，让「检索 — 精读 — 摘录 — 讨论 — 成稿」在同一条工作流里完成：右侧栏浏览文库，双击条目打开独立阅读页，划词摘录 / 翻译 / 框图，一键写成引用胶囊送进会话草稿，模型随即基于原文接续作答。条目右键还能复制 APA / GB/T 7714 参考文献，或把多篇文献排成综述对比。模型侧还能检索、精读、新建分类、导入论文、回挂译文——凡 Zotero 本地接口与集成 MCP 能做的，都能交给它。

不用写代码、不用记命令。第一次使用照着[安装与设置](#安装与设置)点 5 步即可，都是一次性的，以后打开 Zotero 和 DSH 直接用。完整交互与错误对照见 [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)。

## 截图

[![DSH 右侧栏中的 Zotero 文献库面板与条目右键菜单](docs/images/zotero-pane.png)](docs/images/zotero-pane.png)

<sub>右侧栏「Zotero 文献库」面板：分类树 + 标签面板 + 条目列表；多选条目后右键即可加入对话、复制参考文献或发起综述对比。</sub>

[![综述对比结果与原文证据定位](docs/images/zotero-reading-with-ai.png)](docs/images/zotero-reading-with-ai.png)

<sub>综述对比现场：左侧会话给出结论与原文证据，右侧 PDF 自动定位到对应段落；对比前可逐篇选择全文、章节或仅书目。</sub>

## 它能替你做的事

- **找文献**：三档搜索（标题 / 创建者 / 年份、所有字段和标签、含附件全文），叠加分类、标签与摘要筛选。
- **群组与搜索**：左栏固定「群组文库」（按组浏览共享文献，只读）与「已保存搜索」（直接看 Zotero 求值结果）。
- **最近阅读**：按最后打开时间排序；读过的条目图标与标题淡化，悬停可看最后阅读时间。
- **独立阅读页**：双击开 tab，PDF 用 pdf.js 连续滚动、高亮原位叠加；网页快照与文本附件也能读，原文 / 译本随时切换。
- **目录与续读**：左上角目录收拢 PDF 书签、快照标题、笔记标题并随页高亮；PDF 自动记住页码，下次打开接着读。
- **划选即用**：摘录、翻译、高亮 / 下划线；跨页自动拆条，评论、改色、改页码、加标签、互转、删除都在一处。
- **笔记**：就地新建 / 编辑 / 删除，正文原样保存；独立笔记可直接引用正文进对话。
- **期刊指标**：读 `extra` 与标签里的 IF、JCR / 中科院分区、知网 CIF / AIF、核心收录与被引；配 easyScholar 密钥可补查，另给 WoS MJL / LetPub / Scimago 入口。
- **参考文献**：右键按 APA 7 或 GB/T 7714-2025 批量复制，单次最多 50 条。
- **综述对比**：多选右键进入，逐篇选全文 / 章节 / 字符区间 / 仅书目，预览用量后一次进草稿。
- **带进对话**：条目、多选、标签、整目录、摘录、标注、笔记、翻译、全文片段都写成胶囊；发送时才展开，历史可回溯原文。
- **截图**：框选 PDF / 网页正文，图片 + 出处说明（文献、页码、章节、区域文字）同条发出。
- **让 AI 整理**：新建 / 重命名 / 移动 / 删除分类，批量归类，导入本地论文，回挂译文；群组文库只读，写操作到 Zotero 里做。
- **安全可控**：默认纯只读；开启写权限并授权后才能改库，标注 / 笔记走本地 API，其余写操作优先走集成 MCP，模型工具可逐个开关。

面板布局与 Zotero 本体一致：顶部状态栏显示连接状态、提供刷新与跳回 Zotero 的入口，左侧分类树（「我的文库」+「群组文库」「已保存搜索」两个固定区块）与可拖高、可折叠的标签面板，右侧条目列表（附件数统一显示在副标题最右，读过的条目图标与标题淡化）。条目动作收进右键菜单（加入对话 / 复制参考文献 / 多选综述对比），列表头不再堆按钮。分隔条宽度、选中范围与展开状态按本机记住（含当前文库与已保存搜索，刷新后回到原位）；列表带「最近阅读」入口，单击选中、`Ctrl` / `Cmd` 多选、双击开详情标签页，边读边摘、边问边改。

> 面向使用者的完整说明（入口、交互、toast 与错误对照表）见 [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)。

## 安装与设置

一次配置，之后打开 Zotero 和 DSH 即可用。前提：**Zotero 桌面版已运行**（读本机库，不是云端）；**DSH ≥ 0.2.1-rc.3**。

| 步骤 | 在哪做 | 做什么 | 必须吗 |
|---|---|---|---|
| [1](#第-1-步在-dsh-里安装本插件) | DSH | 安装插件 | 必须 |
| [2](#第-2-步给-zotero-装一个桥接小插件) | Zotero | 装桥接插件 Zotero MCP Plugin | 要让 AI 动手 |
| [3](#第-3-步打开-zotero-的本机通信开关) | Zotero | 允许本机程序通信 | 必须 |
| [4](#第-4-步回到-dsh-确认已经连上) | DSH | 确认能读到分类 | 必须 |
| [5](#第-5-步可选想让-ai-帮你改文献库) | DSH + Zotero | 开启写权限并授权 | 要改库 / 划高亮 |

### 第 1 步：在 DSH 里安装本插件

1. 「设置 → 插件市场」；提示「还没有插件索引」时，添加 `https://awesome-dsh-plugin.com/index.json`。
2. 「发现」搜索 `zotero` → 打开 **dsh-plugin-zotero** → 安装 → **重启 DSH**。

装好标志：右侧栏出现「**Zotero 文献库**」，「设置」里出现「**Zotero文献库**」。

<details>
<summary>命令行安装（可选）</summary>

```sh
dsh plugin --profile <profile> add dsh-plugin-zotero
```

包内为预构建产物，无需 `allowBuilds`；要求 dsh ≥ 0.2.1-rc.3。本地源码开发见[方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)。

</details>

### 第 2 步：给 Zotero 装一个桥接小插件

AI 改库靠 Zotero 端的 **Zotero MCP Plugin**（包名 `zotero-integrated-mcp`）。

1. Zotero「**工具 → 插件**」→ 搜 `mcp` → 安装列表第一行、标签 `ai` / `integration` 的那个。
2. 默认地址 `http://127.0.0.1:23120/mcp`；在插件设置里勾选「**允许写操作**」，否则 AI 只能读。

[![Zotero 插件市场中安装 Zotero MCP Plugin](docs/images/zotero-mcp-plugin-market.png)](docs/images/zotero-mcp-plugin-market.png)

不装也能用右侧面板浏览文献，只是 AI 的 Zotero 工具不可用；换插件或端口不同见[第 4 步](#第-4-步回到-dsh-确认已经连上)。

### 第 3 步：打开 Zotero 的本机通信开关

Zotero「**设置 → 高级**」→ 勾选「**允许此计算机上的其他应用程序与 Zotero 通信**」。数据不出本机，端口只对本机开放。

[![在 Zotero 高级设置中允许其他应用与 Zotero 通信](docs/images/zotero-allow-communication.png)](docs/images/zotero-allow-communication.png)

自检：浏览器打开 `http://127.0.0.1:23119/api/`，看到 `Zotero is running` 即通。

### 第 4 步：回到 DSH 确认已经连上

DSH「设置 → **Zotero文献库**」默认值即可，一般不用改。回会话打开右侧栏，能看到你的分类树就说明整条链路通了。

MCP 插件不是第 2 步那个、或端口不是 23120 时，改「**MCP 设置 → 集成 MCP 地址**」即可，自动保存生效。

### 第 5 步（可选）：想让 AI 帮你改文献库

默认只读。要划高亮 / 笔记，或让 AI 整理分类、导入论文时：

1. 打开「**允许写入 Zotero**」。
2. 点「**授权 Zotero 写权限**」，弹窗选「**始终允许**」（选「允许」只生效一次）。
3. 状态显示「**已授权（永久有效）**」即完成，重启后仍有效。

[![DSH 设置里的 Zotero 写权限开关与授权按钮](docs/images/zotero-settings-write.png)](docs/images/zotero-settings-write.png)

<sub>写权限区块：开关已开、状态「已授权（永久有效）」；「重新读取」只在写入报错时用。</sub>

- 凭据存本机 `~/.dsh/storages/dsh-plugin-zotero/local-api-key.json`（0600）。
- 写入**直接改本机 Zotero 库**，不另存副本；删除需二次确认，不进回收站、无法撤销。
- 收回权限：在 Zotero 里清除本地 API 授权；临时只读则关掉「允许写入 Zotero」。

## 设置项说明（设置 → Zotero文献库）

入口：DSH「设置 → **Zotero文献库**」。**没有保存按钮**，改完约 1 秒自动生效；带「已覆盖」的是改过的项，点「恢复默认」还原。

### Zotero 写权限

见[第 5 步](#第-5-步可选想让-ai-帮你改文献库)：开关管入口，授权管 Zotero 放行，两者都开才能写。

### API 设置

一般不用改。

| 界面上的名字 | 默认值 | 说明 | 什么时候才需要改 |
|---|---|---|---|
| **Zotero 地址** | `http://127.0.0.1:23119` | 本机 Zotero 地址，面板数据都从这里取 | 改过本地 API 端口 |
| **请求超时（毫秒）** | `5000` | 等 Zotero 响应的上限 | 大库常超时，可调到 10000 |
| **全文上限（字节）** | `204800` | 单篇附件给 AI 的纯文本上限（约 200 KB） | 想一次读更长全文（更费 token） |
| **每批条目数** | `50` | 列表每批拉取的条目数，上限 200 | 大库想更快出首屏就调小 |

<sub>配置字段：`zoteroBaseUrl`、`requestTimeoutMs`、`fulltextMaxBytes`、`defaultLimit`。</sub>

### MCP 设置

| 界面上的名字 | 默认值 | 说明 | 什么时候才需要改 |
|---|---|---|---|
| **集成 MCP 地址** | `http://127.0.0.1:23120/mcp` | 桥接插件地址 | 换了插件或端口不同 |
| **MCP 探活超时（毫秒）** | `800` | 判断 AI 工具是否可用的等待上限 | 状态栏常误报工具不可用 |

<sub>配置字段：`mcpUrl`、`mcpProbeTimeoutMs`。</sub>

### MCP 工具（AI 能力逐项开关）

清单现场读取，每行开关单独控制 AI 能否使用。名字含 `write_` / `create_` / `update_` / `delete_` / `add_` / `remove_` 的会改库；「重新读取」重新拉清单，失败通常是 Zotero 未开或桥接插件未装。

### 划词翻译

| 界面上的名字 | 默认值 | 说明 | 什么时候才需要改 |
|---|---|---|---|
| **默认翻译引擎** | `Bing 免费翻译（快）` | 免密钥、约 1 秒；可换 `DeepSeek 模型精翻（占额度）`，失败自动回落 Bing | 想要更顺的学术译文 |
| **目标语言** | `自动（中→英 / 英→中）` | 按选区语种自动判向 | 想固定译入某语言 |

浮层标题栏可临时换引擎（只影响本次）；单次上限 4000 字；选中文字会发给翻译服务，涉密勿用。

<sub>配置字段：`translateProvider`、`translateTarget`。</sub>

### 期刊指标

| 界面上的名字 | 默认值 | 说明 | 什么时候才需要改 |
|---|---|---|---|
| **easyScholar 密钥** | 空 | 填了才能联网补查期刊等级 | 想直接看 IF / 分区 / 核心收录 |

- 不填时只读条目 `extra` 与标签，读不到就不显示，也不联网。
- 填了以后自动补查缺失项，同一刊名 24 小时缓存，结果不写回 Zotero。
- 第三方数据仅供参考；投稿前用 WoS MJL、LetPub、Scimago 核验。

<sub>配置字段：`easyScholarKey`。</sub>

## 常见问题

| 你看到的 | 大概率原因 | 怎么办 |
|---|---|---|
| 面板显示「Zotero 未连接」 | Zotero 没开，或第 3 步的通信开关没勾 | 打开 Zotero，勾上「允许此计算机上的其他应用程序与 Zotero 通信」，回面板点刷新 |
| 状态栏「模型工具不可用」，或工具清单读取失败 | 第 2 步的小插件没装 / 端口不是 23120 | 装 Zotero MCP Plugin；端口不同就改「集成 MCP 地址」，再点「重新读取」 |
| 「设置」里没有「Zotero文献库」这一页 | 插件没装成功或没重启 | 回「插件市场」确认已安装，然后重启 DSH |
| 划高亮 / 写笔记失败，提示未授权 | 第 5 步只开了开关、没点授权按钮 | 点「授权 Zotero 写权限」，弹窗里选「**始终允许**」 |
| 每写一次就弹一次授权框 | 上次选的是「允许」，拿到的是一次性凭据 | 重新点授权，这次选「始终允许」 |
| 授权按钮灰着点不动 | 上面的开关还没打开，或改动还没自动保存 | 先打开「允许写入 Zotero」，等「正在自动保存…」消失 |
| 让 AI 新建分类，报「写操作已禁用」 | Zotero 里那个 MCP 小插件没开写操作 | 到 Zotero 的 MCP 插件设置里勾选「允许写操作」，重试即可，不用重启 DSH |
| 提示「Zotero 里这条已经变了」 | 你（或 AI）在 Zotero 里同时改了同一条 | 刷新后重试；插件宁可报错也不覆盖你的新改动 |
| 群组文库里的分类、条目改不了 | 群组按只读浏览，面板不提供群组写入口，也不给「整目录引用」 | 到 Zotero 里由有权限的成员操作；阅读、摘录、引用单条不受影响 |
| 「期刊指标」整块不显示，或提示未配置密钥 | 条目 `extra` 与标签里没有指标，且没填 easyScholar 密钥 | 在「设置 → Zotero文献库 → 期刊指标」填密钥；或点卡片里的外部入口自己核验 |
| 右键菜单里没有「复制参考文献」 | 选中的是笔记 / 附件等非书目条目，或所选超过 50 项 | 复制参考文献只对书目条目生效、一次最多 50 项；综述对比需要多选 |
| 已保存搜索里是空的 | Zotero 里这个搜索条件当前没有命中，或搜索保存在别的文库 | 回 Zotero 左栏确认搜索结果；群组文库的搜索需要在对应群组里保存 |
| 草稿里的引用胶囊发送失败，说找不到来源 | 插件被禁用或卸载了，胶囊没人展开 | 重新启用插件，或把胶囊删掉再发 |
| 改了设置好像没生效 | 自动保存失败（顶部有红字） | 按红字提示再改一次任意字段触发重试；仍失败就看是不是被更高优先级配置覆盖 |
| 译文浮层提示「翻译服务还没启动：请重启一次 DSH」 | 升级后宿主 `lib/` 还是旧进程，路由表里没有翻译端点 | 完全退出并重开 DSH（**刷新页面没用**）；重启前面板其余功能不受影响 |
| 设置里选了 DeepSeek，浮层徽标却显示 Bing | 模型通道不可用或调用失败，已自动回落 | 属正常降级；检查「设置 → 模型」里有没有可用通道，或直接在浮层标题栏换引擎重试 |
| 译文浮层提示「选区过长」 | 单次翻译上限 4000 字（与摘录同口径） | 缩小选区分段翻；整篇交给模型可改用条目引用 |
| 截图发送被拒，提示「当前模型不支持图片」 | 当前模型没有读图能力（如 `deepseek-v4-pro`） | 换成支持图片的模型（如 `deepseek-flash`）后重发 |
| 截图提示「会话正忙，图片未挂上」 | 草稿区正在发送 / 上传，暂时不接受新附件 | 等上一次发送结束再截一次 |
| 网页快照的「截图加入对话」一直灰着 | 正文还没渲染完、桥接脚本没加载，或组件版本过旧 | 等正文出来；提示补构建产物就重新 `pnpm build:client` 后**刷新页面**；只有提示「组件版本过旧」才需要重启 DSH |
| PDF 页面全白只剩彩色标注块，或网页快照没有高亮 | `client/` 里的运行期资产（PDF 字体 / 快照桥接脚本）丢了 | 重新执行 `pnpm build:client` 后刷新页面即可，**不用重启 DSH** |

---

以下面向开发者与想折腾配置的人，普通使用可以不看。

## 架构

从使用者视角看，插件分两半，职责不重叠、互不依赖：

| 半边 | 能力 | 通道 |
|---|---|---|
| **人侧面板** | 在 DSH 右侧栏浏览 Zotero 个人文库 / 群组文库 / 已保存搜索（分类树 / 标签面板 / 条目列表 / 三档搜索 / 条目详情 / 期刊指标 / 笔记 / 标注 / PDF 阅读），把条目（含多选批量）、参考文献、摘录、标注、笔记、标签、整目录或综述对比写进会话草稿；开启写权限后还能就地新建 / 修改 / 删除高亮、划线与笔记 | 插件在宿主 web server 自注册的 `/dsh-zotero/api/*` 路由（写 action 另需自定义写头） |
| **模型侧** | 检索、精读、按需操作文库；条目 / 分类 / 标签 / 标识符的写走集成 MCP，标注与笔记的写走插件自带的 `zotero_*` 工具 | 插件**自持**连接本机 Zotero 集成 MCP，工具以 `mcp__zotero__*` 注册给模型 |

MCP 没起，面板照常可用；Zotero 没开，模型工具自然也不可用。

代码分布：

| 半边 | 代码位置 | 通道 |
|---|---|---|
| Host | `src/index.ts`、`src/host/`、`src/zotero/` | 把 Zotero 本地 API 包装成 HTTP 端点（读 + 受开关约束的写），挂在 DSH 宿主 web server 上 |
| Client | `src/client/` | 在右侧栏注册 tab、面板正文，并在「设置」对话框注册独立一页；数据与选择状态放在模块级单例 |

两条数据流：

```
人侧    浏览器面板 ──同源 fetch──▶ /dsh-zotero/api/*（Host 路由）──HTTP──▶ Zotero 本地 API（127.0.0.1:23119）
模型侧  启动 / 设置页打开 ──sync──▶ 集成 MCP（127.0.0.1:23120）──注册──▶ dsh 工具表（mcp__zotero__*）
```

- Host 路由为 `GET /dsh-zotero/api/<action>`（写 action 走 `POST`），读侧主要 action 有 `health` / `tree` / `groups` / `items` / `tags` / `tag-usage` / `item` / `bibliography` / `fulltext` / `file` / `attachment-info` / `journal-rank` / `mcp-tools`。`items` 支持 `library`（`group:<id>` 切群组文库）、`searchKey`（已保存搜索）、`q` / `qmode`（三档搜索口径）与 `tag`（重复出现为 AND，`A || B` 为 OR）组合过滤。
- 请求级文库上下文用 `AsyncLocalStorage` 承载：路由解析一次 `library` 参数，后续 Zotero 读取自动落到 `/api/users/0` 或 `/api/groups/<id>`；群组分类树在展开时才拉取，详情 / PDF / 笔记 / 快照按条目所属文库取数。
- Host 侧带信任栅栏：读请求仅接受 `GET`，拒绝 `sec-fetch-site: cross-site`，且 `Host` 必须是回环地址（防 DNS rebinding）。
- 响应统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`，错误码见 [src/zotero/types.ts](src/zotero/types.ts)。
- 条目详情里的笔记由 Host 侧从 `itemType: "note"` 子条目提取并清洗 HTML（剥离脚本、事件属性与冗余 `data-*`，图片限宽），Client 只负责折叠展示。
- 面板正文会被每个会话各挂一份，因此分类树 / 条目列表 / 标签选中 / 搜索词等状态放在 [src/client/paneStore.ts](src/client/paneStore.ts) 的模块级单例里，各会话看到的是同一块面板；右侧栏的展开状态与 tab 则**按会话**持久。条目详情的取数状态在各自 tab 组件内，互不干扰。
- 无会话时面板仍可通过右侧栏的 guide 入口（「Zotero 文献库」）打开。

## 目录结构

```
src/                      # 插件源码（主包，ESM / NodeNext / strict）
├── index.ts              # Host 半入口：Config schema、HTTP 路由、MCP 桥接与写工具注册
├── host/
│   ├── router.ts         # HTTP 路由 /dsh-zotero/api/<action>，含回环 + 写头栅栏 + 文库上下文
│   ├── mcp-bridge.ts     # 自持集成 MCP 连接 + 按开关过滤注册模型工具
│   ├── write-tools.ts    # 模型侧标注 / 笔记写工具（writeEnabled 关时不注册）
│   ├── easyscholar.ts    # easyScholar 期刊等级查询 + 24 小时缓存
│   ├── snapshot.ts       # 网页快照注入与 CSP
│   └── static.ts         # pdf.js 资源
├── zotero/
│   ├── client.ts         # Zotero 本地 API 读取 + 笔记提取清洗 + 集成 MCP JSON-RPC
│   ├── write.ts          # 本地 API 写通道：授权复用、版本前置条件
│   ├── key-store.ts      # 写权限凭证落盘（0600）+ 从 Zotero 密钥库导入「始终允许」
│   ├── annotation-writes.ts / notes.ts   # 标注与笔记的增改删语义校验
│   ├── bibliography.ts   # APA 7 / GB/T 7714-2025 参考文献导出
│   ├── review-evidence.ts # 综述证据索引的落盘与清理
│   ├── palette.ts        # 从真实库里枚举出的 Zotero 标注色板
│   ├── config.ts         # 端点 / 超时 / 截断阈值 + 文库上下文 + 运行时设置读取器
│   └── types.ts          # Host ↔ Client 数据契约
└── client/               # Client 半（浏览器）
    ├── index.ts          # 注册右侧栏 tab（面板 + 条目详情）、面板正文与「设置」独立页
    ├── ZoteroCard.tsx    # 设置页正文（写权限 / API / MCP / 翻译 / 期刊指标，防抖自动保存）
    ├── ZoteroPane.tsx    # 面板容器：状态栏 + 分类树 / 标签面板 + 条目列表
    ├── CollectionTree.tsx  # 我的文库 / 群组文库 / 已保存搜索三段式分类树
    ├── TagPanel.tsx / ItemList.tsx / itemContextMenu.ts  # 标签面板、条目列表与右键菜单
    ├── library.ts        # 当前文库与条目所属文库
    ├── SearchField.tsx   # 目录筛选 / 条目搜索 / 标签筛选共用的紧凑搜索框
    ├── itemType.tsx / readState.tsx       # 文献类型图标与已读标记
    ├── ZoteroItemPane.tsx  # 条目详情 tab 的正文与标题
    ├── ItemDetail.tsx    # 文档优先详情：选附件 / 跨附件定位 / 打开 Zotero
    ├── InfoPanel.tsx     # 左上角悬浮信息面板（文献信息 / 期刊指标 / 标注 / 笔记 / 附件 / 参考文献）
    ├── journalMetrics.ts / journalLinks.ts  # 从 extra / 标签读指标、外部核验入口
    ├── ReviewDialog.tsx  # 多篇文献综述对比：逐篇选范围、预览与用量估算
    ├── fulltextScope.tsx / fulltextPlan.ts / fulltextRange.ts  # 全文按章节 / 字符区间截取
    ├── OutlinePanel.tsx  # 左上角目录浮层，随页面高亮当前章节
    ├── NoteEditor.tsx    # 笔记阅读 / 编辑共用的 contenteditable 编辑器
    ├── viewer/           # 渲染器注册表 + pdf.js 官方 Viewer / 文本回退 / 标注叠加与几何换算
    ├── viewer/shot/      # 截图加入对话：状态机 / 定格遮罩 / 裁切水印 / PDF、DOM、iframe 三种采集适配器
    ├── AnnotationList.tsx / NoteList.tsx    # 标注与笔记列表
    ├── bibliography.ts   # 参考文献样式下拉与剪贴板格式化
    ├── Toast.tsx         # 插入结果等轻提示
    ├── reference.ts / cite.ts  # 引用胶囊的 ref 编码与提交时的文本展开
    ├── evidence.ts / reviewEvidence.ts  # 原文证据链接的编解码与回溯
    ├── useInsertion.ts / inline.ts        # 往会话草稿插入引用胶囊
    ├── styles.ts         # 强调色等共用样式常量
    ├── paneStore.ts      # 跨会话共享的面板状态（含群组树与搜索选中）
    ├── compose.ts        # 插入文本模板
    ├── api.ts            # 调 Host 端点
    └── locales.ts        # zh / en 文案

client/client.js          # tsdown 产物（勿手改）
lib/                      # tsc 产物（勿手改）
cordis.patch.yml          # bundle patch 层：把本插件插入 profile 层栈
docs/                     # 使用说明、Zotero API / MCP 参考、发布与 node 学习笔记
.trae/documents/          # 设计与实施方案（本地，未纳入版本控制）
```

依赖统一由根目录的 `package.json` 管理。

## 环境要求

- Node + **pnpm**（统一用 pnpm，勿与 npm / yarn 混用）。
- **TypeScript ^5.9**：`tsdown@0.22.0` 的 peer 依赖不支持 TypeScript 7.x。
- Zotero 桌面版已运行，且已开启本地 API（见[第 3 步](#第-3-步打开-zotero-的本机通信开关)）。
- **模型侧必需**：Zotero 已安装集成 MCP 插件（插件市场中的 **Zotero MCP Plugin** / `zotero-integrated-mcp`），监听 23120——若用其他 MCP 插件或端口不同，需在设置页改「集成 MCP 地址」（`mcpUrl`）；并在 MCP 插件设置中**开启「允许写操作」**。只装插件不开写操作时，模型侧读类工具照常，但让模型新建 / 修改分类会直接报错（插件返回「写操作已禁用」）。详见[模型侧 MCP 与权限边界](#模型侧-mcp-与权限边界)。
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

- **访问地址**：启动后终端会打印 URL（web server 配置 `printUrl: true`），浏览器打开 **http://127.0.0.1:3080**。该地址来自 profile 组合配置里的 web server（`host` 默认 `127.0.0.1`、`port` 默认 `3080`）。
- **命令来源**：`dsh` 是桌面 App 自带的 CLI（如 `/usr/local/bin/dsh`）；仓库里也装了同一 CLI 的 devDependency，等价写法是 `pnpm dsh --profile demo`，两者读同一个 `~/.dsh/profiles/demo`。
- **启动前**：Host 半边与 Client 半边加载的都是构建产物（`lib/`、`client/client.js`），改完 `src/` 要先构建再重启 dsh。

## 日常迭代

| 改了什么 | 要做什么 |
|---|---|
| `src/`（Host 半边） | `pnpm build` → 重启 dsh |
| `src/client/`（Client 半边） | `pnpm build:client` → 刷新页面（多数改动无需重启；Host 改动要进程级重启） |
| `cordis.patch.yml` | 重启 dsh |

客户端 bundle 没有热更新：改完刷新或重启，改动才会出现。

## 配置层与权限实现

界面操作见[安装与设置](#安装与设置)与[设置项说明](#设置项说明设置--zotero文献库)，这里只记实现。

### 设置怎么落盘

- 入口是「设置」对话框的 `settings.section` 席位（section id `zotero`，`order: 30`），仅当 Host 服务本插件的 settings 命名空间时才注册。命名空间 id `dsh-plugin-zotero` 必须与 [cordis.patch.yml](cordis.patch.yml) 的 insert 行 id 同步。
- **表单没有保存按钮**：最后一次改动后防抖 600ms 落盘；离开页面时合法草稿立刻冲盘、非法草稿直接丢弃；写盘失败**不自动重试**（否则每 600ms 打一次后端），等用户下一次编辑。
- 落盘目标是 profile 的 patch 层 `~/.dsh/profiles/<profile>/cordis.patch.yml`。所有字段走 Schemastery `.volatile()`，只提交新值并唤醒引用，**无需重启**即时生效。「已覆盖」表示该值来自 patch 层而非默认值，「恢复默认」清掉覆盖；若被更高优先级的 patch 层覆盖，保存会报「被覆盖」错误。
- 表单露出九个字段（`zoteroBaseUrl`、`requestTimeoutMs`、`fulltextMaxBytes`、`defaultLimit`、`mcpUrl`、`mcpProbeTimeoutMs`、`translateProvider`、`translateTarget`、`easyScholarKey`），另有两个不以输入框露出的字段：`writeEnabled`（写权限总开关）、`disabledMcpTools`（被停用的 MCP 工具**原始名**，由「MCP 工具」区开关维护，模型侧据此过滤注册）。实现见 [src/index.ts](src/index.ts)、[src/zotero/config.ts](src/zotero/config.ts)、[src/client/ZoteroCard.tsx](src/client/ZoteroCard.tsx)。

### 模型侧 MCP 与权限边界

模型侧工具由**插件自己**桥接：[src/host/mcp-bridge.ts](src/host/mcp-bridge.ts) 直连本机 Zotero 集成 MCP，按配置里的 `disabledMcpTools` 过滤后以 `mcp__zotero__*` 注册给模型。[cordis.patch.yml](cordis.patch.yml) **不再**插入 `@deepseek-ai/dsh-mcp-client` —— 它不支持按工具开关，且同 `serverName` 会与自注册工具重名冲突。插件未安装或服务未起时模型侧工具全部不可用；装了但没开写操作时读类工具正常、`create_collection` 等写工具被拒。

⚠️ 模型的写能力有两处来源，都要单独关才收得住：集成 MCP 工具（含 `write_item` / `write_note` / `write_tag` / `write_metadata` / `add_by_identifier` / `create_collection` / `update_collection` / `delete_collection` / `add_items_to_collection` / `remove_items_from_collection`，可在「MCP 工具」里逐个关掉），以及插件自有的 `zotero_update_annotation` / `zotero_delete_annotation` / `zotero_create_note` / `zotero_update_note` / `zotero_delete_note`（只在「Zotero 写权限」开关打开时注册）。

**写操作为什么优先走 MCP**：这些工具在 Zotero 进程内直接改库，不经过本地 API，因此**不会触发「本地 API 授权」弹窗**。反过来，若让模型用 shell/curl 直接打 `127.0.0.1:23119` 的写接口，就必须先用 `POST /api/local/authorize` 换 key —— 该端点每次调用都会弹一次授权框，且点「允许」拿到的是一次性 key（首个写请求即被 Zotero 删除）。为此插件在 [mcp-bridge.ts](src/host/mcp-bridge.ts) 给写工具描述统一注入「首选写通道」引导语，并点明标注 / 笔记这两类只能走插件自带的 `zotero_*` 工具；「导入本地文件」用 `write_item` 的 `action: "import"` + `filePath` + `parentItemKey` 一条调用即可。

### 写权限与授权

点击路径见[第 5 步](#第-5-步可选想让-ai-帮你改文献库)。机制上分两道闸：`writeEnabled` 决定面板写入口与模型侧 `zotero_*` 工具**是否注册**，本地 API key 决定 Zotero **认不认**这次写入，两者缺一不可。

- 授权走 `POST /api/local/authorize`，Zotero 弹框会挂住这条请求直到用户点按钮，因此等待期间按钮禁用（再点只是多弹一个框，还可能撞上 Zotero 每分钟 5 次的授权限流）。
- 选「始终允许」拿到的长期 key 存到 `~/.dsh/storages/dsh-plugin-zotero/local-api-key.json`（`0600`，只在 Host 进程内读写，不进配置存储、不在表单里回显），之后**重启 dsh / 重启 Zotero 都直接复用**。选「允许」拿到的是一次性 key，首个写请求即被 Zotero 删除。
- 升级到带本功能的新版本时，会自动从 Zotero 自己的密钥库（profile 下的 `localAPIKeys.json`）导入此前点过的「始终允许」，不需要再点一次。撤销在 Zotero 侧做即可：下一次写入收到 401，插件随即删掉本地副本并回到「未授权」。拿到长期授权后主按钮降级为「重新授权」，正常路径下不需要再点。

写请求一律带并发前置条件（条目版本），撞上并发改动返回「Zotero 里这条已经变了」而不是覆盖；删除类操作在面板里必须点两次才真删，且是硬删、不进回收站。出问题时的止血手段仍是那个开关：关掉即彻底回到严格只读。

## 相关文档

- [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md) — 入口、交互、toast 与错误对照表
- [Zotero 本地 API 参考](docs/Zotero文档/Zotero本地API参考.md)
- [Zotero 集成 MCP 服务参考](docs/Zotero文档/Zotero集成MCP服务参考.md)
- [方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)
- [DSH 插件开发文档](docs/DSH插件开发文档/README.zh.md)
- [开发与设计方案](.trae/documents/Zotero-DSH插件开发与设计方案.md)（本地）

## License

[MIT](LICENSE)
