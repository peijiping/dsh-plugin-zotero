# dsh-plugin-zotero

**把 Zotero 文献库搬进 DSH：用 AI 检索、精读、整理文献，让原文与模型直接对话。**

插件把 Zotero 的分类、标签、条目元数据、PDF 全文、笔记与标注接进 DSH，让「检索 — 精读 — 摘录 — 讨论 — 成稿」在同一条工作流里完成：右侧栏浏览文库，双击条目打开独立阅读页，划词摘录 / 翻译 / 框图，一键写成引用胶囊送进会话草稿，模型随即基于原文接续作答。模型侧还能检索、精读、新建分类、导入论文、回挂译文——凡 Zotero 本地接口与集成 MCP 能做的，都能交给它。

不用写代码、不用记命令。第一次使用照着[安装与设置](#安装与设置)点 5 步即可，都是一次性的，以后打开 Zotero 和 DSH 直接用。完整交互与错误对照见 [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)。

## 截图

[![DSH 右侧栏中的 Zotero 文献库面板](docs/images/zotero-pane.png)](docs/images/zotero-pane.png)

<sub>右侧栏「Zotero 文献库」面板：分类树 + 标签面板 + 条目列表；双击条目单开阅读标签页，PDF 整页渲染、高亮原位叠加。</sub>

[![在 DSH 内边读 PDF 边与 AI 交互](docs/images/zotero-reading-with-ai.png)](docs/images/zotero-reading-with-ai.png)

<sub>阅读现场：译文附件与原文可切换，点高亮弹出标注卡片，选中的原文已作为引用写入左侧会话草稿。</sub>

## 它能替你做的事

- **找文献**：按标题、年份、全文关键词检索，也能跨库搜高亮和批注；右侧栏按分类、标签、标题 / 摘要逐层缩小范围。
- **读文献**：双击就在 DSH 内开独立阅读页，PDF 基于 pdf.js 官方 Viewer 连续滚动、高亮原位叠加，原文与译本附件随时切换。左上角一份目录统一收拢 PDF 书签、网页快照与笔记标题，并随当前页面自动高亮定位。划选可摘录、翻译（左右对照、自动判向、可临时换模型精翻）或写高亮 / 下划线（跨页自动拆条、带评论，改色 / 改页码 / 加标签 / 互转 / 删除都在一处，有评论的标注另显示注释图标）；笔记可新建、编辑、删除。开启写权限后改动直接进 Zotero 库，不是副本。
- **整理文库 / 帮你入库**：新建、重命名、移动、删除分类，批量归类，导入本地论文，把译文回挂到条目——说一句「把这几篇归到『待读』」它就照做。人侧面板的分类只读，整理交给模型。
- **带进对话**：单条目、列表多选、单 / 多标签、整目录、划词摘录、标注、笔记、翻译与截图，全部以引用胶囊写进当前草稿（不自动发送、不抢焦点），发送那一刻才展开全文，发出后历史里仍是胶囊，悬停预览、点击看全文。独立笔记自动改插正文，不给模型一个只剩标题的空壳。公式、图表这类没法划选的内容，用左上角「截图加入对话」框一块正文——一张图片附件加一段出处说明（文献身份、页码、章节、区域文字）同条发出。
- **安全可控**：写能力默认全关——不开「Zotero 写权限」面板就是纯只读，模型也看不到任何写工具。开启后写操作优先走集成 MCP（在 Zotero 进程内执行，不弹本地 API 授权框），标注 / 笔记这两类 MCP 覆盖不到的才走本地 API，需一次性点「始终允许」；每个模型工具都能单独开关。

面板布局与 Zotero 本体一致：顶部状态栏显示连接状态、提供刷新与跳回 Zotero 的入口，左侧分类树与可拖高、可折叠的标签面板，右侧条目列表（附件数统一显示在副标题最右，读过的条目图标与标题淡化）。分隔条宽度、选中分类与展开状态按本机记住；列表带「最近阅读」入口，单击选中、`Ctrl` / `Cmd` 多选、双击开详情标签页，边读边摘、边问边改。

> 面向使用者的完整说明（入口、交互、toast 与错误对照表）见 [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)。

## 安装与设置

第一次使用要走 5 步，**全程点鼠标，不用敲命令、不用写代码**。这 5 步都是一次性的，做完以后每天只要打开 Zotero 和 DSH 就能用。

| 步骤 | 在哪做 | 做什么 | 必须吗 |
|---|---|---|---|
| [1](#第-1-步在-dsh-里安装本插件) | DSH | 安装本插件 | 必须 |
| [2](#第-2-步给-zotero-装一个桥接小插件) | Zotero | 装桥接小插件 Zotero MCP Plugin | 想让 AI 动手就必须 |
| [3](#第-3-步打开-zotero-的本机通信开关) | Zotero | 打开「允许本机其他程序通信」开关 | 必须 |
| [4](#第-4-步回到-dsh-确认已经连上) | DSH | 到「设置 → Zotero文献库」看一眼 | 必须（只是确认） |
| [5](#第-5-步可选想让-ai-帮你改文献库) | DSH + Zotero | 打开写权限并授权 | 想改库 / 划高亮才需要 |

开始前请确认两件事：**Zotero 桌面版已装好并且正开着**（本插件读的是你本机 Zotero 里的文献，不是云端）；**DSH 桌面版 ≥ 0.2.1-rc.3**。

### 第 1 步：在 DSH 里安装本插件

1. 打开 DSH，进「设置」→ 左侧的「**插件市场**」。
2. 如果页面提示「还没有插件索引」，点「**添加索引源**」，把这个地址填进去再点「添加」：`https://awesome-dsh-plugin.com/index.json`。这是社区维护的插件目录，只需加一次。
3. 回到「发现」，搜索框里输入 `zotero`，找到 **dsh-plugin-zotero**（作者 peijiping），点开它。
4. 点「**安装**」，在弹出的确认框里确认，等安装进度走完。
5. 按提示**重启 DSH**。

怎么算装好了：重启后 DSH 右侧栏多出「**Zotero 文献库**」入口，「设置」左侧列表里（「Agent 预设」下面）多出「**Zotero文献库**」一页。看到这两个就对了。

<details>
<summary>习惯用命令行的人可以这样装（可选，效果一样）</summary>

```sh
dsh plugin --profile <profile> add dsh-plugin-zotero
```

包内是预构建产物（`lib/` + `client/client.js`），安装时**不运行构建脚本**，无需 `allowBuilds` 授权。要求 dsh ≥ 0.2.1-rc.3（`package.json` 的 `engines.dsh` 为 `>=0.2.1-rc.3 <0.3.0-0`）。本地源码开发见[方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)。

</details>

### 第 2 步：给 Zotero 装一个桥接小插件

AI 要替你新建分类、导入论文、改条目信息，靠的是 Zotero 端的一个小插件（叫 **Zotero MCP Plugin**）。它装在 Zotero 里，装完不用配置。

1. 打开 Zotero，菜单「**工具 → 插件**」。
2. 在插件市场里搜 `mcp`。
3. 安装列表**第一行**、标签是 `ai` / `integration` 的那个 **Zotero MCP Plugin**（包名 `zotero-integrated-mcp`）。
4. 装好后不需要额外设置，它默认在 `http://127.0.0.1:23120/mcp` 上待命。

[![Zotero 插件市场中安装 Zotero MCP Plugin](docs/images/zotero-mcp-plugin-market.png)](docs/images/zotero-mcp-plugin-market.png)

<sub>上图为 Zotero 插件市场，第一行「Zotero MCP Plugin」已安装。</sub>

装完还要**在它的设置里勾选「允许写操作」**，否则 AI 能查能读，但让它新建分类会直接报「写操作已禁用」。

> 这一步不做也能用右侧面板浏览文献，只是 AI 那边的 Zotero 工具用不了。如果你装的是**别的** MCP 插件、或端口不是 23120，见[第 4 步](#第-4-步回到-dsh-确认已经连上)改地址。

### 第 3 步：打开 Zotero 的本机通信开关

Zotero 默认不允许别的程序读它的文献库。这个开关就是放行同一台电脑上的程序（也就是 DSH）——**数据不出本机**，端口只对本机开放。

Zotero → **设置** → **高级** → 勾选「**允许此计算机上的其他应用程序与 Zotero 通信**」。

[![在 Zotero 高级设置中允许其他应用与 Zotero 通信](docs/images/zotero-allow-communication.png)](docs/images/zotero-allow-communication.png)

<sub>上图为 Zotero「设置 → 高级」中开启本地 API 的开关。</sub>

没勾选的话，DSH 面板会显示「Zotero 未连接」并提示你回来开这个开关。想自己确认一下，可以在浏览器里打开 `http://127.0.0.1:23119/api/`，看到 `Zotero is running` 就是通了（命令行等价写法：`curl http://127.0.0.1:23119/api/`）。

### 第 4 步：回到 DSH 确认已经连上

打开 DSH 的「**设置**」，点左侧列表里的「**Zotero文献库**」。这一页就是本插件的全部设置，从上到下四块：**Zotero 写权限**、**API 设置**、**MCP 设置**（含下方的 MCP 工具清单）、**划词翻译**。

- 正常情况**一个字都不用改**，默认值就是对的。每一项的含义见[设置项说明](#设置项说明设置--zotero文献库)。
- 回到会话，打开右侧栏的「Zotero 文献库」：顶部状态栏显示连接状态，左边应该已经列出你在 Zotero 里的分类。看到分类树就说明整条链路通了。
- 如果 Zotero 里装的 MCP 插件不是第 2 步那个、或者端口不是 23120：把「**MCP 设置 → 集成 MCP 地址**」改成实际地址（形如 `http://127.0.0.1:<端口>/mcp`）。改完自动保存、立即生效，不用重启。

### 第 5 步（可选）：想让 AI 帮你改文献库

**默认是只读的**：面板只能看和引用，AI 也看不到任何写工具。想在读 PDF 时直接划高亮、写笔记，或者让 AI 帮你整理分类、导入论文，就打开写权限：

1. 「设置 → Zotero文献库」最上面那块「Zotero 写权限」，打开「**允许写入 Zotero**」开关。
2. 等一秒左右让它自动保存（页面会闪一下「正在自动保存…」），下面的按钮就可以点了。
3. 点「**授权 Zotero 写权限**」。Zotero 会弹出一个确认框，**一定要选「始终允许」**——选「允许」只管一次，第二次写入就又失败了。
4. 状态行变成「**已授权（永久有效），重启 DSH 后继续可用**」就完成了。以后重启 DSH、重启 Zotero 都不用再点。

[![DSH 设置里的 Zotero 写权限开关与授权按钮](docs/images/zotero-settings-write.png)](docs/images/zotero-settings-write.png)

<sub>上图为「设置 → Zotero文献库」顶部的写权限区块：开关已打开、状态显示「已授权（永久有效）」，主按钮已降级为「重新授权」——正常使用不需要再点它。旁边的「重新读取」只在写入报错时用来重查本机授权状态。</sub>

授权凭据存在本机 `~/.dsh/storages/dsh-plugin-zotero/local-api-key.json`（权限 `0600`，不会出现在任何表单里）。要收回权限，在 Zotero 里清除本地 API 授权即可，插件下次写入被拒后会自动删掉本地副本、回到「未授权」。想临时全面止损，把「允许写入 Zotero」关掉就彻底回到只读。

> 写入是**直接改你本机的 Zotero 库**，插件不另存副本。删除类操作在面板里要点两次（「删除」→「确认删除」）才真删，而且**不进 Zotero 回收站**，撤销不了。

## 设置项说明（设置 → Zotero文献库）

入口只有一个：DSH 的「**设置**」→ 左侧「**Zotero文献库**」。

**没有保存按钮**：任何一项改完、停手约一秒就自动落盘，页面顶部会显示「正在自动保存…」，失败会显示红字提示（再改任意一项就会重试）。所有改动**立即生效，不用重启 DSH**。字段旁出现「已覆盖」表示这一项被你改过、不是默认值，点「恢复默认」即可还原。

### Zotero 写权限

见[第 5 步](#第-5-步可选想让-ai-帮你改文献库)。一句话：**开关管「有没有写入口」，授权按钮管「Zotero 认不认」**，两件事都做完才写得进去。

### API 设置

这块管右侧面板怎么连你本机的 Zotero。**四项默认值适用于绝大多数人，不用动。**

[![DSH 设置中的 API 设置四项](docs/images/zotero-settings-api.png)](docs/images/zotero-settings-api.png)

| 界面上的名字 | 默认值 | 说人话 | 什么时候才需要改 |
|---|---|---|---|
| **Zotero 地址** | `http://127.0.0.1:23119` | 本机 Zotero 的门牌号，面板所有数据都从这里取 | 你在 Zotero 里改过本地 API 端口 |
| **请求超时（毫秒）** | `5000` | 等 Zotero 回话最多等 5 秒，超了就报错 | 库特别大、经常提示超时，可以调到 10000 |
| **全文上限（字节）** | `204800` | 一篇附件的纯文本最多给这么多（约 200 KB，中文约 6～7 万字），超出部分截掉 | 想让 AI 一次读到更长的全文，可以调大（更费 token） |
| **默认条目数** | `50` | 面板列表一次先拉 50 条，往下点「加载更多」再续 | 想一屏看到更多条目 |

<sub>对应配置字段名（写配置文件时才用得到）：`zoteroBaseUrl`、`requestTimeoutMs`、`fulltextMaxBytes`、`defaultLimit`。</sub>

### MCP 设置

这块管 AI 那边怎么连 Zotero 的桥接小插件。

| 界面上的名字 | 默认值 | 说人话 | 什么时候才需要改 |
|---|---|---|---|
| **集成 MCP 地址** | `http://127.0.0.1:23120/mcp` | 第 2 步装的那个小插件的接头地址 | 换了别的 MCP 插件，或它的端口不是 23120 |
| **MCP 探活超时（毫秒）** | `800` | 每次判断「AI 工具能不能用」时，最多等 0.8 秒 | 机器很慢、状态栏老是误报「模型工具不可用」 |

<sub>对应配置字段名：`mcpUrl`、`mcpProbeTimeoutMs`。</sub>

### MCP 工具（AI 能力逐项开关）

再往下是「**MCP 工具**」清单：现场列出桥接小插件提供的全部工具，每行右边一个开关，顶部写着「共 N 个工具，已禁用 M 个」。

- **关掉某一项**，AI 就再也用不了那个能力（等于从 AI 的工具表里摘掉），比如你不想让 AI 删分类，就把 `delete_collection` 关掉。
- 「**重新读取**」重新拉一次清单；显示「读取工具列表失败」通常是 Zotero 没开或小插件没装。
- 清单里名字带 `write_` / `create_` / `update_` / `delete_` / `add_` / `remove_` 的是会改库的工具，其余是只读的。

[![DSH 设置中的 MCP 设置与 MCP 工具开关清单](docs/images/zotero-settings-mcp.png)](docs/images/zotero-settings-mcp.png)

<sub>上图为「MCP 设置」区块与下方的「MCP 工具」清单，每行右侧的开关单独控制 AI 能不能使用该工具。</sub>

### 划词翻译

最后一块管「阅读页划选文字 → 译文浮层」。两项都是下拉，改完同样自动保存、立即生效。

| 界面上的名字 | 默认值 | 说人话 | 什么时候才需要改 |
|---|---|---|---|
| **默认翻译引擎** | `Bing 免费翻译（快）` | 免密钥、一般 1 秒内出结果，日常阅读够用 | 学术长句想要更顺的译文，换 `DeepSeek 模型精翻（占额度）`（走当前账号的 Flash 模型，1～3 秒、占额度）；模型通道取不到时自动回落 Bing |
| **目标语言** | `自动（中→英 / 英→中）` | 按选区语种判向：中文原文译英文，英文及其它语种译中文简体 | 想固定译入某一门语言（简体 / 繁体中文、英、日、韩、法、德、俄） |

- 译文浮层标题栏**另有一枚引擎下拉**：换一次就用新引擎立刻重译当前选区，是本次会话的临时覆盖，不写回这里；浮层上的徽标显示本次**实际**用到的引擎（选了精翻却显示 Bing，说明已自动回落）。
- 单次翻译上限 4000 字，超限直接提示缩小选区，不静默截断；同一段文本重复翻译会命中进程内缓存。
- **隐私**：选中的文字会发给所选服务（Bing 即微软的翻译接口，DeepSeek 走你的账号模型）。涉密材料不要用划词翻译。
- <sub>对应配置字段名：`translateProvider`、`translateTarget`。</sub>

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
| **人侧面板** | 在 DSH 右侧栏浏览 Zotero 文库（分类树 / 标签面板 / 条目列表 / 搜索 / 条目详情 / 笔记 / 标注 / PDF 阅读），把条目（含多选批量）、摘录、标注、笔记、标签或整目录引用写进会话草稿；开启写权限后还能就地新建 / 修改 / 删除高亮、划线与笔记 | 插件在宿主 web server 自注册的 `/dsh-zotero/api/*` 路由（写 action 另需自定义写头） |
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

- Host 路由为 `GET /dsh-zotero/api/<action>`，action 有 `health` / `tree` / `items` / `tags` / `item` / `collection-bib` / `mcp-tools`。`items` 支持 `tag`（重复出现为 AND，`A || B` 为 OR）与 `q` 组合过滤。
- Host 侧带信任栅栏：仅接受 GET，拒绝 `sec-fetch-site: cross-site`，且 `Host` 必须是回环地址（防 DNS rebinding）。
- 响应统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`，错误码见 [src/zotero/types.ts](src/zotero/types.ts)。
- 条目详情里的笔记由 Host 侧从 `itemType: "note"` 子条目提取并清洗 HTML（剥离脚本、事件属性与冗余 `data-*`，图片限宽），Client 只负责折叠展示。
- 面板正文会被每个会话各挂一份，因此分类树 / 条目列表 / 标签选中 / 搜索词等状态放在 [src/client/paneStore.ts](src/client/paneStore.ts) 的模块级单例里，各会话看到的是同一块面板；右侧栏的展开状态与 tab 则**按会话**持久。条目详情的取数状态在各自 tab 组件内，互不干扰。
- 无会话时面板仍可通过右侧栏的 guide 入口（「Zotero 文献库」）打开。

## 目录结构

```
src/                      # 插件源码（主包，ESM / NodeNext / strict）
├── index.ts              # Host 半入口：Config schema、HTTP 路由、MCP 桥接与写工具注册
├── host/
│   ├── router.ts         # HTTP 路由 /dsh-zotero/api/<action>，含回环 + 写头栅栏
│   ├── mcp-bridge.ts     # 自持集成 MCP 连接 + 按开关过滤注册模型工具
│   ├── write-tools.ts    # 模型侧标注 / 笔记写工具（writeEnabled 关时不注册）
│   └── static.ts         # pdf.js 资源
├── zotero/
│   ├── client.ts         # Zotero 本地 API 读取 + 笔记提取清洗 + 集成 MCP JSON-RPC
│   ├── write.ts          # 本地 API 写通道：授权复用、版本前置条件
│   ├── key-store.ts      # 写权限凭证落盘（0600）+ 从 Zotero 密钥库导入「始终允许」
│   ├── annotation-writes.ts / notes.ts   # 标注与笔记的增改删语义校验
│   ├── palette.ts        # 从真实库里枚举出的 Zotero 标注色板
│   ├── config.ts         # 端点 / 超时 / 截断阈值 + 运行时设置读取器
│   └── types.ts          # Host ↔ Client 数据契约
└── client/               # Client 半（浏览器）
    ├── index.ts          # 注册右侧栏 tab（面板 + 条目详情）、面板正文与「设置」独立页
    ├── ZoteroCard.tsx    # 设置页正文（写权限 / API 设置 / MCP 设置 / 工具开关，防抖自动保存）
    ├── ZoteroPane.tsx    # 面板容器：状态栏 + 分类树 / 标签面板 + 条目列表
    ├── CollectionTree.tsx / TagPanel.tsx / ItemList.tsx
    ├── SearchField.tsx   # 目录筛选 / 条目搜索 / 标签筛选共用的紧凑搜索框
    ├── itemType.tsx / readState.tsx       # 文献类型图标与已读标记
    ├── ZoteroItemPane.tsx  # 条目详情 tab 的正文与标题
    ├── ItemDetail.tsx    # 文档优先详情：选附件 / 跨附件定位 / 打开 Zotero
    ├── InfoPanel.tsx     # 左上角悬浮信息面板（可分块折叠）
    ├── OutlinePanel.tsx  # 左上角目录浮层，随页面高亮当前章节
    ├── NoteEditor.tsx    # 笔记阅读 / 编辑共用的 contenteditable 编辑器
    ├── viewer/           # 渲染器注册表 + pdf.js 官方 Viewer / 文本回退 / 标注叠加与几何换算
    ├── viewer/shot/      # 截图加入对话：状态机 / 定格遮罩 / 裁切水印 / PDF、DOM、iframe 三种采集适配器
    ├── AnnotationList.tsx / NoteList.tsx    # 标注与笔记列表
    ├── Toast.tsx         # 插入结果等轻提示
    ├── reference.ts / cite.ts  # 引用胶囊的 ref 编码与提交时的文本展开
    ├── useInsertion.ts / inline.ts        # 往会话草稿插入引用胶囊
    ├── styles.ts         # 强调色等共用样式常量
    ├── paneStore.ts      # 跨会话共享的面板状态
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
- 表单露出六个字段（`zoteroBaseUrl`、`requestTimeoutMs`、`fulltextMaxBytes`、`defaultLimit`、`mcpUrl`、`mcpProbeTimeoutMs`），另有两个不以文本框露出的字段：`writeEnabled`（写权限总开关）、`disabledMcpTools`（被停用的 MCP 工具**原始名**，由「MCP 工具」区开关维护，模型侧据此过滤注册）。实现见 [src/index.ts](src/index.ts)、[src/zotero/config.ts](src/zotero/config.ts)、[src/client/ZoteroCard.tsx](src/client/ZoteroCard.tsx)。

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
