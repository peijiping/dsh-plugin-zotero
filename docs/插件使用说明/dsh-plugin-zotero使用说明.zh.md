# dsh-plugin-zotero 使用说明

> 设计依据见 [Zotero-DSH插件开发与设计方案.md](../../.trae/documents/Zotero-DSH插件开发与设计方案.md)。

## 0. 这个插件做什么

分两半，职责不重叠：

| 半边 | 能力 | 通道 |
|---|---|---|
| **人侧面板** | 只读浏览 Zotero 文献库（分类树 / 条目详情 / PDF 全文），把引用写进会话草稿 | 插件在 DSH 宿主 web server 上自注册的 `/dsh-zotero/api/*` 路由 |
| **模型侧** | 检索、精读、按需操作文库 | 桥接本机 Zotero 集成 MCP（`http://127.0.0.1:23120/mcp`），工具名 `mcp__zotero__*` |

两条通道互不依赖：MCP 没起，面板照常用；Zotero 没开，模型工具自然也不可用。

**面板不做任何写操作**——没有新建/改名/删除分类的按钮。这是刻意设计。

## 1. 安装

### 前置

1. Zotero 桌面版已运行，且已开启本地 API（见 §2）。
2. 本机已运行 Zotero 集成 MCP 服务（监听 23120）。缺这个不影响面板，只是模型侧没工具。
3. 主包已构建出两类产物：

```sh
cd /Users/peijiping/Documents/Codes/TS/dsh-plugin-zotero
pnpm install
pnpm build          # tsc：src/ -> lib/（Host 半边）
pnpm build:client   # tsdown：src/client/ -> client/client.js（Client 半边）
```

### 装进 profile

本地路径 link 的完整操作见 [方案一：本地路径安装](../插件发布/方案一本地路径安装.zh.md)，核心三步：

```sh
dsh plugin --profile demo add ./
dsh --profile demo --dump-config   # 应能看到 dsh-plugin-zotero 与 mcp-zotero 两行
dsh --profile demo
```

### 日常迭代

| 改了什么 | 要做什么 |
|---|---|
| `src/`（Host 半边） | `pnpm build` → 重启 dsh |
| `src/client/`（Client 半边） | `pnpm build:client` → 重启 dsh → 浏览器重新打开页面 |
| `cordis.patch.yml` | 重启 dsh |

客户端 bundle **没有热更新**：改完必须重启 dsh 并重新加载页面，否则浏览器拿到的还是上一次构建的字节。

## 2. 开启 Zotero 本地 API

Zotero → 设置（Preferences）→ 高级（Advanced）→ 勾选 **「允许本机其他应用与 Zotero 通信」**。

- 默认端口 `23119`，只监听回环地址。
- 验证：

```sh
curl http://127.0.0.1:23119/api/          # 期望输出：Zotero is running
curl -i http://127.0.0.1:23119/api/users/0/collections | head -1
```

- 未勾选时读端点返回 **403**，面板会显示「Zotero 未连接」并提示启用步骤。
- 注意：裸 `GET /api/users/0` **不支持**（返回 `No endpoint found`），要带子资源路径。

## 3. 面板入口

1. DSH web 界面右上角 → **打开右侧边栏**。
2. 右侧栏选中 **「Zotero 文献库」**。

面板布局：

- 顶部：文库名（如「我的文库」）+ 两个状态点（「Zotero 已连接」/「模型工具可用」）+ **刷新**按钮。
- 左栏 260px：搜索框 + 分类树；输入关键词后左栏切换为搜索结果。
- 右栏：条目详情（元数据 → 摘要 → 附件列表 → 全文块）或分类概要 + 整目录 bib 预览。

分类树展开是**按需拉取**的，展开一个分类才会去取它下面的条目（上限 200 条），不会预取全库。

> 状态点「模型工具可用」只是对 23120 做端口探活，**不代表当前会话真的挂上了 `mcp__zotero__*` 工具**。真正的工具列表由模型侧会话决定。

## 4. 三种引用方式

| 方式 | 入口 | 写进草稿的文本 |
|---|---|---|
| **单条目引用** | 详情区标题右侧 **「添加条目引用」** 按钮；或条目行**右键**菜单 → 「添加条目引用」 | `【Zotero 条目｜<itemKey>】标题` + 作者 / 年份 / 出处 / DOI / 链接 / 标签 / 摘要 |
| **摘录** | 全文块内**鼠标拖选**文字 → 浮出 **「添加摘录」** 气泡 | `【Zotero 摘录｜<条目标题>｜<itemKey>】` + `"<原文>"` |
| **整目录引用** | 分类行**右键**菜单 → 「添加整目录引用」 | `【Zotero 目录｜<分类名>｜<collectionKey>】共 N 条` + 每行 `- 标题（作者, 年）` |

三条行为约定：

1. **只写进草稿，不自动发送，不抢焦点**。插完你还能继续改。
2. 三种文本都带 `itemKey` / `collectionKey`——插完可以直接让模型用 `mcp__zotero__*` 接着操作同一批文献（例如「把上面这些条目加进 XXX 分类」）。
3. 摘录**保留原始措辞**，不做改写。超过 50 条的目录只列前 50 条并注明，完整清单提示模型用 `mcp__zotero__get_collection_items` 取。

### 插入失败时的提示（toast）

| toast 文案 | 含义 |
|---|---|
| 已添加到会话草稿 | 成功 |
| 当前面板不在会话上下文中，无法插入到输入框 | 面板没拿到会话的输入能力，换从会话页打开右侧栏 |
| 输入框草稿已变化，未插入；请避免在插入期间编辑草稿 | 插入期间草稿被改动，会拒绝插入而不是插到错位置，重试即可 |
| 没有可插入的内容 | 目标内容为空 |

## 5. MCP 集成：权限边界与写操作提醒

配置在 [cordis.patch.yml](../../cordis.patch.yml) 的 `insert` 里，由插件 bundle 顺带插入一行：

```yaml
- id: mcp-zotero
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: zotero                      # 工具名因此是 mcp__zotero__<rawName>
    transport: streamable-http
    url: http://127.0.0.1:23120/mcp
    toolCallTimeoutMs: 120000
```

服务端细节见 [Zotero集成MCP服务参考.md](../Zotero文档/Zotero集成MCP服务参考.md)。本机实测为 `zotero-integrated-mcp v1.1.0`，暴露 **20 个工具**。

### ⚠️ 权限边界：这些工具里有写操作

人侧面板是只读的，**但桥接进来的模型工具不是**。20 个工具中包含 5 个改变文库结构的写工具：

| 工具 | 作用 |
|---|---|
| `create_collection` | 新建分类 |
| `update_collection` | 改名 / 改父分类 |
| `delete_collection` | **删除分类** |
| `add_items_to_collection` | 把条目加进分类 |
| `remove_items_from_collection` | 把条目移出分类 |

也就是说，**模型可以在你不知情的情况下改动文库结构**。删分类与改归属是不可逆的结构变更（`delete_collection` 尤其在模型理解错分类名时危险）。

建议：

- 默认全开可以接受——多数调用是读工具，写工具偶尔很有用（比如「把刚找的文献收进 DRG 分类」）。
- 想收紧成纯只读：把 profile patch 里 `mcp-zotero` 那一行**移除或注释掉**，面板功能完全不受影响。
- 涉及 `delete_collection` 的请求，建议先让模型列出分类再确认，不要一句话让它删。

## 6. 常见错误对照表

| 现象 / 错误码 | 原因 | 处理 |
|---|---|---|
| 状态点「Zotero 未连接」，`zotero_unreachable` | Zotero 没启动，或本地 API 被关，连接被拒 | 启动 Zotero，确认 §2 的选项已勾选 |
| `zotero_disabled` | 本地 API 已开，但「允许本机其他应用与 Zotero 通信」没勾 → 403 | 勾选后点面板「刷新」 |
| `zotero_not_found` | 条目 / 分类 key 已失效（被删或换了文库） | 刷新后重新选 |
| `bad_request` / `internal_error` | 参数非法，或插件内部异常 | 刷新重试；持续出现看 dsh 控制台 |
| 状态点「模型工具不可用」 | 23120 无监听（集成 MCP 服务没装 / 没启用） | 确认服务在跑；面板本身可继续用 |
| 条目详情没有「全文」 | 该条目没有可用附件全文（或附件没做全文索引） | 先给条目添加 PDF 附件，并在 Zotero 里完成全文索引 |
| 条目详情没有引用块 | 顶层条目本身就是**裸 PDF 附件**（直接拖入的文件），没有书目元数据 | 正常现象：本地 API 对裸附件不生成 `csl-entry`。元数据可从附件所属条目取 |
| 整目录引用拿不到 bib | 本地 API 的 `/collections/<key>/items?format=bib` 返回空 body | 插件已绕开：改走 `/items?itemKey=...` 批量取（每批 ≤ 50），属上游限制 |
| 划词不出「添加摘录」 | 不是真实的鼠标拖拽选中（脚本建选区不行），或选区跨出了全文块 | 用鼠标在全文块内拖选 |
| 全文显示可能被截断 | 单条全文上限 200 KB | 属刻意限制；需要完整内容让模型用 `mcp__zotero__get_content` |
| 搜索 / 树加载后总是空 | 文库本身为空，或分类下确实没有条目 | 换分类或换关键词确认 |

## 相关文档

- 本地 API 端点细节：[Zotero本地API参考.md](../Zotero文档/Zotero本地API参考.md)
- 集成 MCP 服务：[Zotero集成MCP服务参考.md](../Zotero文档/Zotero集成MCP服务参考.md)
- 本地路径安装：[方案一：本地路径安装](../插件发布/方案一本地路径安装.zh.md)
- 设计方案：[Zotero-DSH插件开发与设计方案.md](../../.trae/documents/Zotero-DSH插件开发与设计方案.md)
