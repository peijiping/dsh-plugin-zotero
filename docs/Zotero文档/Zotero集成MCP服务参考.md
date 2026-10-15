# Zotero 集成 MCP 服务（zotero-integrated-mcp）参考

> 依据本机运行中的服务实测整理：`http://127.0.0.1:23120/mcp`
>
> - 服务标识：`zotero-integrated-mcp` v1.1.0
> - 协商协议版本：`2024-11-05`
> - 探测时间：2026-10-14（工具清单由 `initialize` + `tools/list` 握手获得）
>
> 配套阅读：[Zotero 本地 API（Local API）完整参考](./Zotero本地API参考.md)

---

## 目录

1. [概述](#1-概述)
2. [与本地 API 的关系](#2-与本地-api-的关系)
3. [客户端配置](#3-客户端配置)
4. [连接与握手](#4-连接与握手)
5. [工具清单](#5-工具清单)
6. [通用约定](#6-通用约定)
7. [mode 档位速查](#7-mode-档位速查)
8. [已知注意点](#8-已知注意点)

---

## 1. 概述

本机在 `127.0.0.1:23120` 上运行着一个 MCP（Model Context Protocol）服务，把 Zotero 文库的能力以 **MCP 工具**的形式暴露给 AI 客户端。

- **传输方式**：Streamable HTTP（JSON-RPC 2.0 over HTTP POST）
- **端点**：`http://127.0.0.1:23120/mcp`
- **能力声明**：`tools`（`listChanged: true`）、`logging`、`prompts`、`resources`

其中 `prompts` 与 `resources` 虽然出现在 capabilities 里，但实际清单均为**空数组**；全部能力都通过 `tools` 提供。

---

## 2. 与本地 API 的关系

两者不是同一个东西，端口相邻但用途不同：

| 对比项 | Zotero 本地 API | Zotero 集成 MCP |
|---|---|---|
| 端点 | `http://localhost:23119/api/` | `http://127.0.0.1:23120/mcp` |
| 提供方 | Zotero 桌面客户端内置 | 独立运行的 MCP 服务进程 |
| 协议 | Zotero Web API v3（REST） | MCP（JSON-RPC 2.0） |
| 面向对象 | 脚本 / 命令行工具 | AI 客户端（LLM 工具调用） |
| 能力范围 | 原始读写接口 | 在上层封装了检索、评分、分页、内容裁剪 |

MCP 服务可理解为本地 API 之上的一层**面向 LLM 的封装**：内置了相关性评分、`mode` 内容裁剪档位、全文缓存库等 REST 接口本身没有的能力。

---

## 3. 客户端配置

```json
"zotero-mcp": {
  "type": "streamable-http",
  "url": "http://127.0.0.1:23120/mcp",
  "enable": 0
}
```

字段说明：

| 字段 | 值 | 含义 |
|---|---|---|
| `type` | `streamable-http` | 使用 Streamable HTTP 传输，对应 MCP 的 `/mcp` 单端点模式 |
| `url` | `http://127.0.0.1:23120/mcp` | 服务端点，仅监听本机回环地址 |
| `enable` | `0` | 客户端侧的启用开关，`0` 表示**未启用** |

> 注意：`enable: 0` 只是该配置文件里的开关状态，不影响服务本身是否在运行。文档中的工具清单是独立于该开关、直接对端点探测得到的。

---

## 4. 连接与握手

MCP 是有状态的：必须先 `initialize`，拿到 `Mcp-Session-Id`，后续请求都要带上该请求头。

**第一步：初始化，取得 Session ID**

```bash
curl -sS -i -X POST http://127.0.0.1:23120/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"trae","version":"1.0"}}}'
```

响应头中会返回 `Mcp-Session-Id`，响应体形如：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": { "listChanged": true },
      "logging": {},
      "prompts": {},
      "resources": {}
    },
    "serverInfo": { "name": "zotero-integrated-mcp", "version": "1.1.0" }
  }
}
```

服务端把协议版本**降级协商**为 `2024-11-05`，即使客户端请求的是 `2025-03-26`。

**第二步：发送 initialized 通知，然后列出工具**

```bash
SID='<上一步返回的 Mcp-Session-Id>'

curl -sS -X POST http://127.0.0.1:23120/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -sS -X POST http://127.0.0.1:23120/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

调用工具时把 `method` 换成 `tools/call`：

```json
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "get_libraries", "arguments": { "limit": 10 } } }
```

> `Accept` 头必须同时包含 `application/json` 与 `text/event-stream`。本服务在本次探测中统一返回 JSON（非 SSE 流）。

---

## 5. 工具清单

共 **20 个工具**。按用途分为四组，参数列中 `*` 表示必填。

### 5.1 文库与检索

| 工具 | 说明 | 参数 |
|---|---|---|
| `get_libraries` | 列出当前客户端可用的所有 Zotero 文库，返回精简元数据的分页数组 | `limit`、`offset` |
| `search_libraries` | 按名称搜索文库 | `q`*、`limit`、`offset` |
| `search_library` | 主检索入口：支持布尔运算、相关性评分、分页；结果来自个人文库。配合 `get_content` 取全文 | `libraryID`、`q`、`title`、`titleOperator`、`yearRange`、`fulltext`、`fulltextMode`、`fulltextOperator`、`itemType`、`includeAttachments`、`mode`、`relevanceScoring`、`sort`、`limit`、`offset` |
| `search_fulltext` | 在所有文档的全文中检索，返回**带上下文的命中片段**；取完整文本需再用 `get_content` | `libraryID`、`q`*、`itemKeys`、`mode`、`contextLength`、`maxResults`、`caseSensitive` |
| `fulltext_database` | 访问**缓存全文库**（只读），比从 Zotero 重新抽取更快 | `action`*、`query`、`itemKeys`、`limit`、`caseSensitive` |

`search_library` 的枚举与专用参数：

| 参数 | 取值 | 默认 |
|---|---|---|
| `titleOperator` | `contains` / `exact` / `startsWith` / `endsWith` / `regex` | `contains` |
| `fulltextMode` | `attachment`（仅 PDF）/ `note`（仅笔记）/ `both` | `both` |
| `fulltextOperator` | `contains` / `exact` / `regex` | `contains` |
| `itemType` | 条目类型名，如 `attachment`（找出无元数据的独立 PDF）、`journalArticle`、`book` | — |
| `includeAttachments` | `"true"` / `"false"`（**字符串**，见 §8） | `"false"` |
| `sort` | `relevance` / `date` / `title` / `year` | `relevance` |
| `yearRange` | 形如 `"2020-2023"` | — |
| `relevanceScoring` | 布尔，开启相关性评分 | — |

`fulltext_database` 的 `action` 取值：`list`（已缓存条目）、`search`（在内容中检索，需 `query`）、`get`（取全文，需 `itemKeys`）、`stats`（库统计）。

### 5.2 条目与内容

| 工具 | 说明 | 参数 |
|---|---|---|
| `get_item_details` | 单条文献的完整书目元数据（标题、作者、日期、标识符、附件、笔记、标签），适合生成引用；全文请用 `get_content` | `itemKey`*、`libraryID`、`mode` |
| `get_item_abstract` | 取条目的摘要（通常是出版方提供的作者自撰摘要） | `itemKey`*、`libraryID`、`format` |
| `get_content` | 取 PDF、附件、笔记、摘要的全文；**可能含 OCR 噪声**；用户要完整文本时不应摘要化 | `itemKey` 或 `attachmentKey`（二选一必填）、`libraryID`、`mode`、`include`、`contentControl`、`format` |

`get_content` 的两个嵌套对象：

**`include`** —— 内容类型开关（仅在传 `itemKey` 时生效）

| 字段 | 默认 | 含义 |
|---|---|---|
| `pdf` | `true` | 包含 PDF 附件内容 |
| `attachments` | `true` | 包含其他附件内容 |
| `notes` | `true` | 包含笔记内容 |
| `abstract` | `true` | 包含摘要 |
| `webpage` | `false` | 包含网页快照（在 standard/complete 档位自动开启） |

**`contentControl`** —— 覆盖 mode 默认的内容裁剪行为

| 字段 | 默认 | 含义 |
|---|---|---|
| `preserveOriginal` | `true` | 处理时始终保留原文结构 |
| `allowExtended` | `false` | 允许超出 mode 默认长度上限 |
| `expandIfImportant` | `false` | 高重要度内容时扩充长度 |
| `maxContentLength` | — | 本次请求的最大内容长度覆盖值 |
| `prioritizeCompleteness` | `false` | 优先保证句子/段落完整，而非严格卡长度 |
| `standardExpansion` | — | 智能扩写配置，见下 |

`standardExpansion`：`enabled`（默认 `false`）、`trigger`（`high_importance` / `user_query` / `context_needed`，默认 `high_importance`）、`maxExpansionRatio`（默认 `2`，范围 1–10）。

### 5.3 标注与笔记

| 工具 | 说明 | 参数 |
|---|---|---|
| `search_annotations` | 跨库按关键词／颜色／标签检索高亮、批注、笔记，带相关性评分 | `libraryID`、`q`、`itemKeys`、`types`、`colors`、`tags`、`mode`、`maxTokens`、`minRelevance`、`limit`、`offset` |
| `get_annotations` | 取指定条目的标注与笔记，支持颜色／标签过滤 | `itemKey` / `annotationId` / `annotationIds`（三选一必填）、`libraryID`、`types`、`colors`、`tags`、`mode`、`maxTokens`、`limit`、`offset` |

- **至少要提供一个检索条件**：`search_annotations` 需 `q`、`colors`、`tags` 之一；`get_annotations` 需 `itemKey`、`annotationId`、`annotationIds` 之一。
- `types` 取值：`note`、`highlight`、`annotation`、`ink`、`text`、`image`（`get_annotations` 默认 `["note","highlight","annotation"]`）。
- 这两个工具的描述都强调：引用时**务必保留原始措辞**。
- `minRelevance`（`search_annotations`）：默认 `0.1`，范围 0–1，仅在提供 `q` 时生效。
- 默认条数：`search_annotations` 为 15，`get_annotations` 为 20。

### 5.4 分类目录（读写）

| 工具 | 说明 | 参数 |
|---|---|---|
| `get_collections` | 取分类列表；默认返回顶层分类的扁平分页结果 | `libraryID`、`mode`、`limit`、`offset`、`recursive`、`parentCollection` |
| `search_collections` | 按名称搜索分类 | `libraryID`、`q`、`limit` |
| `get_collection_details` | 单个分类的详情 | `collectionKey`*、`libraryID` |
| `get_collection_items` | 取某分类下的条目 | `collectionKey`*、`libraryID`、`limit`、`offset` |
| `get_subcollections` | 取子分类；`recursive=true` 返回完整嵌套树 | `collectionKey`*、`libraryID`、`limit`、`offset`、`recursive` |
| `create_collection` | **写**：新建分类，可用 `parentCollection` 嵌套 | `name`*、`libraryID`、`parentCollection` |
| `update_collection` | **写**：重命名或移动分类 | `collectionKey`*、`libraryID`、`name`、`parentCollection` |
| `delete_collection` | **写／破坏性**：删除分类 | `collectionKey`*、`libraryID`、`deleteItems` |
| `add_items_to_collection` | **写**：批量把条目加入分类 | `collectionKey`*、`itemKeys`*、`libraryID` |
| `remove_items_from_collection` | **写**：从分类移除条目（不删除文献本身） | `collectionKey`*、`itemKeys`*、`libraryID` |

行为要点：

- `get_collections` 的 `recursive=true` 会返回完整嵌套树，此时 `mode` / `limit` / `offset` 均被忽略；`parentCollection` 用于限定某个父级的直接子级。
- `update_collection` 的 `parentCollection` 传**空字符串 `""`** 表示移动到顶层。
- `delete_collection` 默认**只把条目移出分类，不删除条目**；`deleteItems=true` 才会把它们送入回收站。
- `get_subcollections` 的 `limit` 默认 100、`offset` 默认 0，`recursive=true` 时两者被忽略。

---

## 6. 通用约定

| 约定 | 说明 |
|---|---|
| `libraryID` | 可选。**省略时默认个人文库（user library）**；群组文库需显式传入对应 ID（先用 `get_libraries` / `search_libraries` 获取） |
| `mode` | 各工具统一的「详细程度 / 内容量」档位，控制返回体量与 token 开销；不传则使用服务端用户默认值 |
| `format` | 仅 `get_content`、`get_item_abstract` 支持：`json`（默认，带结构化元数据）或 `text`（纯文本） |
| `limit` / `offset` | 分页；`limit` 通常会覆盖 `mode` 的默认条数 |
| 颜色 | 支持十六进制（如 `#ffd400`）或名称：`yellow`、`red`、`green`、`blue`、`purple`、`orange` |
| 颜色语义 | 服务内置约定：yellow=疑问、red=错误/重要、green=赞同、blue=信息、purple=定义 |
| 条目键 | `itemKey` / `collectionKey` / `attachmentKey` 均为 Zotero 的 8 位条目键，通常需先用检索工具获取 |

颜色语义对照：

| 颜色 | 含义 |
|---|---|
| yellow | 疑问（question） |
| red | 错误 / 重要（error / important） |
| green | 赞同（agree） |
| blue | 信息（info） |
| purple | 定义（definition） |
| orange | — （schema 中列出但描述未给语义） |

---

## 7. mode 档位速查

同一档位名在不同工具下含义不同，需分开记忆。

| 工具 | minimal | preview | standard | complete |
|---|---|---|---|---|
| `search_library` | 30 条结果 | 100 条 | 自适应 | 500+ 条 |
| `search_annotations` | 见 §5.3 默认条数 | — | 默认档 | — |
| `get_item_details` | 基础信息 | 关键字段 | 综合 | 全字段 |
| `get_content` | 500 字符 | 1.5K 字符 | 3K 字符 | 不限 |
| `get_collections` | 20 个分类 | 50 个 | 100 个 | 500+ 个 |
| `search_fulltext` | 100 上下文 | 200 上下文 | 自适应 | 400+ 上下文 |

（`get_annotations` 也接受 `mode`，语义与 `search_annotations` 一致。）

---

## 8. 已知注意点

以下为实测/读 schema 得到的、容易踩坑的点，写插件时需留意：

1. **`search_library.includeAttachments` 是字符串而非布尔** —— 枚举值是 `"true"` / `"false"`。这与其他工具的布尔参数写法不一致，传 `true`（布尔）可能不被接受。且当 `itemType: "attachment"` 时必须为 `"true"`。
2. **写操作真实生效** —— `create_collection`、`update_collection`、`delete_collection`、`add_items_to_collection`、`remove_items_from_collection` 会改动本地 Zotero 库，接入 AI 时需明确权限边界。
3. **`delete_collection` 的默认语义是「安全」的** —— 不动条目，只有显式传 `deleteItems: true` 才入回收站。反向使用（本想删条目却只删了分类）是常见误解。
4. **`recursive: true` 会静默忽略分页参数** —— `get_collections`、`get_subcollections` 均是如此，不要指望 `limit` 能限制递归结果的规模。
5. **`prompts` / `resources` 是空集** —— capabilities 里声明了这两项能力，但 `prompts/list`、`resources/list` 都返回 `[]`，集成时当作纯工具服务处理即可。
6. **协议版本会被降级** —— 客户端请求 `2025-03-26`，服务端实际返回 `2024-11-05`，实现客户端时不要依赖更高版本才有的特性。
7. **`get_content` 输出可能含 OCR 噪声** —— 工具描述中已明确提示，涉及精确引用时应做校验。
8. **端口仅绑定回环地址** —— `127.0.0.1:23120` 不对外暴露，这既是安全边界，也意味着只能在同机环境下调用。

---

## 附：一次完整的探测流程

```bash
# 1. 初始化并取 Session ID
curl -sS -i -X POST http://127.0.0.1:23120/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"trae","version":"1.0"}}}'

# 2. 复用 Session ID 发送 initialized 通知 + 拉取工具清单
SID='mcp-xxxxxxxx-xxxxxxxxx'
curl -sS -X POST http://127.0.0.1:23120/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
curl -sS -X POST http://127.0.0.1:23120/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```
