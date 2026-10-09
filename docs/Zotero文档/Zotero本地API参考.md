# Zotero 本地 API（Local API）完整参考

> 依据 Zotero 官方文档整理：
> - 本地 API：<https://www.zotero.org/support/dev/web_api/v3/local_api>
> - 读接口基础：<https://www.zotero.org/support/dev/web_api/v3/basics>
> - 写接口：<https://www.zotero.org/support/dev/web_api/v3/write_requests>
> - 文件上传：<https://www.zotero.org/support/dev/web_api/v3/file_upload>
> - 全文内容：<https://www.zotero.org/support/dev/web_api/v3/fulltext_content>
> - 类型与字段：<https://www.zotero.org/support/dev/web_api/v3/types_and_fields>
>
> 文档抓取时间：2026-10-08。本地实测环境：Zotero 10.0.6（macOS）。

---

## 目录

1. [概述](#1-概述)
2. [与 Web API 的差异](#2-与-web-api-的差异)
3. [通用约定](#3-通用约定)
4. [读接口（GET）](#4-读接口get)
5. [读请求参数](#5-读请求参数)
6. [写接口](#6-写接口)
7. [文件上传](#7-文件上传)
8. [全文内容](#8-全文内容)
9. [类型与字段接口](#9-类型与字段接口)
10. [HTTP 状态码](#10-http-状态码)
11. [附录：端口 23119 上的其他端点](#11-附录端口-23119-上的其他端点)

---

## 1. 概述

Zotero 桌面客户端会在本机 `localhost:23119` 的 `/api/` 路径下，暴露一套 **Zotero Web API v3 的本地实现**，直接读写用户本地数据库。

- **Base URL**：`http://localhost:23119/api/`
- **鉴权**：读请求无需鉴权；写请求（Zotero 10+）需要运行时申请的本地 API Key。
- **优点**：离线可用、无速率限制、无需网络、通常远快于 Web API（无需分页）。
- **用途**：本机脚本 / 命令行工具，避免直接读 SQLite 或回落 Web API。

**启用方式**：Zotero 设置 → 高级 → 勾选「Allow other applications on this computer to communicate with Zotero」。未启用时请求返回 `403 Forbidden`。

---

## 2. 与 Web API 的差异

| 差异点 | 本地 API 行为 |
|---|---|
| API 版本 | 仅支持 v3；未来同一时间也只会支持一个版本。建议先请求 `/api/` 并读取 `Zotero-API-Version` 响应头 |
| 鉴权 | 读请求无需鉴权；写请求需本地 API Key（与 zotero.org 的 API Key 无关） |
| 安全 | 因读请求无鉴权，本机应用可读整个文库；**不要把该端口转发/暴露到外部** |
| Server ID | Zotero 10+ 每个响应都带 `Zotero-Server-ID` 头，用于标识所连接的 Zotero 实例 |
| 对象版本 | Zotero 10+ 本地版本由本地维护，与 Web API 版本、其他实例版本**无任何对应关系** |
| 用户 ID | 只能访问当前登录用户数据。路径中用户 ID 可传 `0` 或真实数字 ID；传其他 ID 返回 `400` |
| 群组 | 群组元数据仅包含识别所需信息（无权限、成员列表），且只读 |
| Atom | 不支持。`format=atom` 或 `content=atom` 返回 `501 Not Implemented` |
| 本地化 | 类型/字段接口返回用户语言的名称，`locale` 参数被忽略；例外：`/api/creatorFields` 始终返回英文 |
| 分页 | 默认不分页，一次返回全部匹配对象；`limit`/`start` 仍可用，`Link` 头仍返回 |
| 局部上传 | 不支持二进制差量。`PATCH <p>/items/<key>/file` 返回 `405 Method Not Allowed` |
| 实现一致性 | 仅力求对齐文档行为，不复制全部实现细节（等值排序、快速搜索匹配、JSON 细节可能略有差异） |

**本地独有、Web API 不具备的能力**：

- `<p>/searches/<searchKey>/items` —— 执行已保存搜索并返回匹配条目（Web API 只暴露搜索元数据，不执行搜索）
- `<p>/items/<itemKey>/file` —— 返回 `302` 重定向到磁盘附件的 `file://` URL；`/file/view` 同理；`/file/view/url` 返回纯文本 URL
- `POST /api/local/authorize`（Zotero 10+）—— 申请写权限

> 下文用 `<p>` 表示用户/群组前缀 `<userOrGroupPrefix>`，本地即 `/api/users/0`（或 `/api/users/<你的数字ID>`）。

---

## 3. 通用约定

### 3.1 请求头

| 头 | 说明 |
|---|---|
| `Zotero-API-Version: 3` | 指定 API 版本（本地只有 3；也可用查询参数 `?v=3`） |
| `Zotero-Server-ID: <serverID>` | 可选（读）/ 必需（写）。读请求若提供则必须匹配当前实例，否则 `412` |
| `Zotero-API-Key: <key>` | 写请求鉴权（推荐） |
| `Authorization: Bearer <key>` | 写请求鉴权（等价写法） |
| `If-Unmodified-Since-Version: <版本>` | 写请求的前置条件（按库版本） |
| `If-Match` / `If-None-Match` | 文件上传前置条件 |
| `If-Modified-Since-Version: <库版本>` | 条件读请求，未变更时返回 `304` |
| `Zotero-Write-Token: <32位随机串>` | 幂等写保护；本地仅缓存于内存，重启即失效 |

API Key 也可用查询参数 `?key=<key>` 传递（不推荐）。

### 3.2 响应头

| 头 | 说明 |
|---|---|
| `Zotero-API-Version` | 响应所用 API 版本（`3`） |
| `Zotero-Schema-Version` | 本地 Zotero 实例的 schema 版本（实测 `44`） |
| `Zotero-Server-ID` | 标识当前 Zotero 实例（实测形如 `7L0DZm8WvJSc`） |
| `Last-Modified-Version` | 当前库版本，用于后续 `?since=` 与条件请求 |
| `Total-Results` | 多对象请求匹配到的结果总数 |
| `Link` | 分页链接（`rel=first/prev/next/last`，可能含 `rel=alternate`） |
| `Backoff` | 建议客户端降速的秒数（本地不限速，一般不会出现） |
| `Retry-After` | 配合 `429` / `503` 指示重试等待秒数 |

### 3.3 Server ID

- `GET /api/` 即可拿到 `Zotero-Server-ID`，客户端应缓存并在后续请求的 `Zotero-Server-ID` 请求头中回传。
- 读请求：该头可选；提供则必须匹配，否则 `412 Precondition Failed`。
- 写请求（含 `POST /api/local/authorize`）：该头**必需**，缺失返回 `428 Precondition Required`。
- 收到 `412` 表示当前实例与缓存数据的来源实例不同 → 丢弃缓存（含版本号）重新开始。
- 该 ID 存于数据库，随用户数据迁移而非随安装，跨重启/升级不变。

### 3.4 对象版本

- Zotero 10+ 本地版本每次「库 + 事务」保存或删除时递增，来源可以是用户操作、同步或本地写请求。
- 本地版本与 Web API 版本**无关**，也无关于其他 Zotero 实例的本地版本。`version` 属性、`Last-Modified-Version`、`format=versions`、`?since=`、`If-Unmodified-Since-Version` 均如此。
- 旧版 Zotero 曾返回同步版本（未同步为 `0` 且本地修改不变化）；应丢弃已存版本，不要比较。
- **例外**：`<p>/groups` 与 `/groups/<groupID>` 报告的是同步群组版本；群组库*内部*的对象（条目、分类、搜索）仍用本地版本。

### 3.5 对象 JSON 结构

```json
{
  "key": "ABCD2345",
  "version": 1,
  "library": { "type": "user", "id": 19499712, "name": "我的文库", "links": { "...": "..." } },
  "links": { "self": { "href": "...", "type": "application/json" },
             "alternate": { "href": "...", "type": "text/html" },
             "enclosure": { "href": "file:///...", "type": "application/pdf",
                            "title": "xxx.pdf", "length": 743519 } },
  "meta": { "numChildren": 0, "numItems": 0, "numCollections": 0 },
  "data": {
    "key": "ABCD2345",
    "version": 1,
    "itemType": "book",
    "title": "...",
    "creators": [],
    "tags": [],
    "collections": [],
    "relations": {},
    "dateAdded": "2014-06-12T21:28:55Z",
    "dateModified": "2014-06-12T21:28:55Z"
  }
}
```

- `data` 为「可写 JSON」，是写请求实际处理的内容；其它字段（`library`/`links`/`meta`）在写时被忽略。
- 单对象请求返回单个 JSON 对象；多对象请求返回 JSON 数组。

---

## 4. 读接口（GET）

以下所有读取均无需鉴权。

### 4.1 服务探测

| 方法 | 路径 | 说明 | 返回 |
|---|---|---|---|
| GET | `/api/` | 探测服务与版本 | `200`，`text/plain` 正文 `Nothing to see here.`，附 `Zotero-API-Version` / `Zotero-Schema-Version` / `Zotero-Server-ID` 头 |

### 4.2 分类 Collections

| 路径 | 说明 |
|---|---|
| `<p>/collections` | 库内全部分类 |
| `<p>/collections/top` | 顶层分类 |
| `<p>/collections/<collectionKey>` | 指定分类 |
| `<p>/collections/<collectionKey>/collections` | 指定分类下的子分类 |
| `<p>/collections/<collectionKey>/items` | 指定分类内的条目 |
| `<p>/collections/<collectionKey>/items/top` | 指定分类内的顶层条目 |
| `<p>/collections/<collectionKey>/tags` | 指定分类内的标签 |
| `<p>/collections/<collectionKey>/items/tags` | 指定分类内条目上的标签 |
| `<p>/collections/<collectionKey>/items/top/tags` | 指定分类内顶层条目上的标签 |

**返回示例**（`<p>/collections`）：

```json
[
  {
    "key": "T5QW57WU",
    "version": 22,
    "meta": { "numCollections": 0, "numItems": 0 },
    "data": { "key": "T5QW57WU", "version": 22, "name": "减脂",
              "parentCollection": false, "relations": {} }
  }
]
```

### 4.3 条目 Items

| 路径 | 说明 |
|---|---|
| `<p>/items` | 库内全部条目（不含回收站） |
| `<p>/items/top` | 顶层条目（不含回收站） |
| `<p>/items/trash` | 回收站中的条目 |
| `<p>/items/<itemKey>` | 指定条目 |
| `<p>/items/<itemKey>/children` | 指定条目下的子条目 |
| `<p>/items/<itemKey>/tags` | 指定条目的标签 |
| `<p>/items/tags` | 库内全部标签，可基于条目过滤 |
| `<p>/items/top/tags` | 顶层条目的标签 |
| `<p>/items/trash/tags` | 回收站条目的标签 |
| `<p>/publications/items` | 「我的出版物」中的条目 |
| `<p>/publications/items/tags` | 「我的出版物」条目的标签 |

**返回示例**（`<p>/items?limit=1`）：

```json
[
  {
    "key": "PSALA4ZM",
    "version": 23,
    "library": { "type": "user", "id": 19499712, "name": "我的文库" },
    "links": {
      "self": { "href": "http://localhost:23119/api/users/19499712/items/PSALA4ZM",
                "type": "application/json" },
      "alternate": { "href": "https://www.zotero.org/users/19499712/items/PSALA4ZM",
                     "type": "text/html" },
      "enclosure": { "href": "file:///Users/xxx/Zotero/storage/PSALA4ZM/xxx.pdf",
                     "type": "application/pdf", "title": "xxx.pdf", "length": 743519 }
    },
    "meta": { "numChildren": 0 },
    "data": { "key": "PSALA4ZM", "version": 23, "itemType": "attachment", "...": "..." }
  }
]
```

### 4.4 搜索 Searches

| 路径 | 说明 |
|---|---|
| `<p>/searches` | 库内全部已保存搜索 |
| `<p>/searches/<searchKey>` | 指定已保存搜索 |
| `<p>/searches/<searchKey>/items` | **（本地独有）** 执行该搜索并返回匹配条目 |

> Web API 仅提供搜索元数据；本地可真正执行搜索。

### 4.5 标签 Tags

| 路径 | 说明 |
|---|---|
| `<p>/tags` | 库内全部标签 |
| `<p>/tags/<name>` | 指定名称的所有类型标签 |
| `<p>/items/<itemKey>/tags` | 指定条目的标签 |
| `<p>/collections/<collectionKey>/tags` | 指定分类内的标签 |

（其余 `items/tags`、`items/top/tags`、`items/trash/tags`、`collections/<key>/items/tags` 等见上文对应小节。）

**返回示例**：

```json
[
  { "tag": "政治经济学", "meta": { "type": 0, "numItems": 3 } }
]
```

### 4.6 群组与 Key（Other URLs）

| 路径 | 说明 |
|---|---|
| `<p>/groups` | 当前可访问的群组集合（元数据有限且只读） |
| `/api/keys/<key>` | 指定 API Key 的用户 ID 与权限（Web API 用于管理 Key；本地主要面向读/删 Key） |

### 4.7 本地专属文件端点

| 路径 | 说明 | 返回 |
|---|---|---|
| `<p>/items/<itemKey>/file` | 附件文件 | `302` 重定向到磁盘 `file://` URL |
| `<p>/items/<itemKey>/file/view` | 同上 | `302` 重定向 |
| `<p>/items/<itemKey>/file/view/url` | 附件 URL | `200`，纯文本 URL |

---

## 5. 读请求参数

**所有参数均为可选。**

### 5.1 通用参数（所有读请求）

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `format` | `json`、`keys`、`versions`、`bib`、`atom`、以及[导出格式](#54-条目导出格式) | `json` | 响应格式。`keys` 返回换行分隔的对象 key（多对象请求，无上限）；`versions` 返回 `{key: version}` 对象（分类/条目/搜索多对象请求）；`bib` 返回 XHTML 格式参考文献（仅条目请求，最多 150 条）；`atom` **本地不支持**（`501`） |

### 5.2 `format=json` 参数

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `include` | `data`、`bib`、`citation`、[导出格式](#54-条目导出格式) | `data` | 响应中包含的格式，逗号分隔多值（如 `include=data,bib`）。`bib`/`citation` 仅对条目有效 |

### 5.3 `format=bib` / `include=bib` / `include=citation` 参数

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `style` | 字符串 | `chicago-note-bibliography` | 引用样式：Zotero Style Repository 中的文件名（不含 `.csl`，如 `apa`）或远程 CSL URL |
| `linkwrap` | `0` / `1` | `0` | 设为 `1` 时 URL/DOI 输出为超链接 |
| `locale` | 字符串 | `en-US` | 参考文献语言（部分样式固定语言）；**本地 API 忽略该参数** |

> `format=bib` 与 `include=bib` 的区别：前者返回按样式排序的完整 XHTML 参考文献（不受 `limit` 限制，建议只对分类/标签使用）；后者在每条条目的 `data` 块内返回单条格式化引用。

### 5.4 条目导出格式

可作为 `format` / `include` / `content` 的值（仅条目请求）：

`bibtex`、`biblatex`、`bookmarks`、`coins`、`csljson`、`csv`、`mods`、`refer`、`rdf_bibliontology`、`rdf_dc`、`rdf_zotero`、`ris`、`tei`、`wikipedia`

示例：`GET /api/users/0/items?format=bibtex&limit=10`

### 5.5 搜索参数（通用）

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `itemKey` | 逗号分隔的 key | null | 仅条目请求；单次最多 50 个 |
| `itemType` | [搜索语法](#57-搜索语法) | null | 条目类型搜索 |
| `q` | 字符串 | null | 快速搜索。默认搜索标题与各 creator 字段；仅支持短语搜索 |
| `since` | 整数 | `0` | 仅返回库版本大于该值后被修改的对象（取自之前的 `Last-Modified-Version`） |
| `tag` | [搜索语法](#57-搜索语法) | null | 标签搜索 |

> 本地 API 使用 Zotero 本地快速搜索实现，给定 `q` 返回的条目集合可能与 Web API 不完全一致。

### 5.6 端点专用搜索参数

**条目（Items）端点**

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `includeTrashed` | `0` / `1` | `0`（`/trash` 除外） | 是否包含回收站条目 |
| `qmode` | `titleCreatorYear` / `everything` | `titleCreatorYear` | 快速搜索模式；`everything` 包含全文内容 |

**标签（Tags）端点**

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `qmode` | `contains` / `startsWith` | `contains` | 快速搜索模式 |

**标签-在-条目（Tags-within-items）端点**

返回「条目上的标签」时，主参数（`q`、`qmode`、`tag`）作用于标签本身；以下参数用于筛选条目：

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `itemQ` | 字符串 | null | 等价于条目请求中的 `q` |
| `itemQMode` | `contains` / `startsWith` | `contains` | 等价于条目请求中的 `qmode` |
| `itemTag` | [搜索语法](#57-搜索语法) | null | 等价于条目请求中的 `tag` |

### 5.7 搜索语法

`itemType` 与 `tag` 支持布尔搜索：

- `itemType=book`
- `itemType=book || journalArticle`（OR）
- `itemType=-attachment`（NOT）
- `tag=foo`
- `tag=foo bar`（含空格的标签）
- `tag=foo&tag=bar`（AND）
- `tag=foo bar || bar`（OR）
- `tag=-foo`（NOT）
- `tag=\-foo`（字面量开头连字符）

> 请按客户端要求对搜索串做 URL 编码。

### 5.8 排序与分页参数

仅适用于多对象读请求（如 `<p>/items`）；`format=bib` 不支持排序分页。

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `sort` | `dateAdded`、`dateModified`、`title`、`creator`、`itemType`、`date`、`publisher`、`publicationTitle`、`journalAbbreviation`、`language`、`accessDate`、`libraryCatalog`、`callNumber`、`rights`、`addedBy`、`numItems`（标签） | `dateModified` | 排序字段 |
| `direction` | `asc` / `desc` | 因 `sort` 而异 | 排序方向 |
| `limit` | 整数（Web API 1–100，导出格式必填） | `25`（本地无上限） | 单次返回的最大结果数 |
| `start` | 整数 | `0` | 起始索引 |

> **本地 API 默认与上限均不限制 `limit`**：省略时一次返回全部匹配对象；`limit`/`start` 与 `Link` 头仍可用。

### 5.9 结果总数与分页头

- `Total-Results`：多对象读请求返回匹配总数（Web API 单次实际返回不超过 100）。
- `Link`：匹配数大于当前 `limit` 时给出分页链接，`rel` 可为 `first`、`prev`、`next`、`last`，有时含 `rel=alternate`（Zotero 网站对应页面）。

```
Link: <https://api.zotero.org/users/12345/items?limit=30&start=30>; rel="next",
      <https://api.zotero.org/users/12345/items?limit=30&start=5040>; rel="last",
      <https://www.zotero.org/users/12345/items>; rel="alternate"
```

### 5.10 缓存与增量

- 多对象请求返回 `Last-Modified-Version`；带 `If-Modified-Since-Version: <库版本>` 再次请求，若库未变化则返回 `304 Not Modified`（单对象条件请求暂不支持）。
- **增量抓取**：客户端应使用 `?since=` 只取上次之后变化的对象。
- 本地响应本就很廉价，客户端激进缓存意义不大；`?since=` 仍是抓取大型本地库变更的首选。
- 注意：Zotero 10+ 本地版本与 Web API 版本无关，缓存数据必须按 server ID 分区。

---

## 6. 写接口

> Zotero 10+ 的本地 API 支持 `POST` / `PUT` / `PATCH` / `DELETE`，作用于条目、分类、已保存搜索；另支持标签删除、全文写入与文件上传。请求/响应格式与 Web API 写接口一致。
> 本地 API 写操作是普通本地修改：立即在 Zotero UI 可见，若库已同步会在下次同步时上传到 zotero.org。

### 6.1 授权（获取本地 API Key）

本地 API Key 与 zotero.org 的 API Key 无关，也无法预先创建，需运行时申请：

```http
POST /api/local/authorize
Content-Type: application/json
Zotero-Server-ID: <serverID>

{ "appName": "My Application" }
```

Zotero 弹出对话框（显示应用名，按钮：Allow / Always Allow / Deny）：

| 结果 | 响应 |
|---|---|
| 允许 | `{ "key": "<32位 key>", "remember": false }` |
| 选择「Always Allow」 | `{ "key": "<32位 key>", "remember": true }`，key 可无限复用 |
| 拒绝 | `403 Forbidden`，正文 `{ "denied": true }` |
| 请求过频（每分钟超过 5 次弹窗请求） | `429 Too Many Requests`，附 `Retry-After` |

- `remember` 为 `false` 时 key 为**一次性**：首个成功校验它的写请求会消耗该 key，后续写需重新申请。
- 客户端应始终准备好在写请求收到 `401` 时重新授权。

**使用 key**（与 Web API 相同）：

1. `Zotero-API-Key: <key>`（推荐）
2. `Authorization: Bearer <key>`
3. `?key=<key>`（不推荐）

无 key 或 key 无法识别 → `401 Unauthorized`，附 `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"`。

Key 随用户 profile 存储，且**不做范围限制**：可写用户可编辑的任何库。用户可在 设置 → 高级 →「Clear Write Authorizations」撤销所有记住的授权。

### 6.2 条目写操作

#### 创建条目

```http
POST <p>/items
Content-Type: application/json
Zotero-Write-Token: <token>        （或 If-Unmodified-Since-Version: <库版本>）

[
  {
    "itemType": "book",
    "title": "My Book",
    "creators": [
      { "creatorType": "author", "firstName": "Sam", "lastName": "McAuthor" },
      { "creatorType": "editor", "name": "John T. Singlefield" }
    ],
    "tags": [ { "tag": "awesome" }, { "tag": "rad", "type": 1 } ],
    "collections": [ "BCDE3456", "CDEF4567" ],
    "relations": { "owl:sameAs": "http://zotero.org/groups/1/items/JKLM6543" }
  }
]
```

除 `itemType`、`tags`、`collections`、`relations` 外均可选。创建前可先取空模板（见 [9. 类型与字段接口](#9-类型与字段接口)）。

**响应**（`200 OK`）：

```json
{ "success": { "0": "<itemKey>" }, "unchanged": {}, "failed": {} }
```

| 状态码 | 含义 |
|---|---|
| `200 OK` | 请求完成，逐条结果见响应 JSON |
| `400 Bad Request` | 非法类型/字段；JSON 无法解析 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | `If-Unmodified-Since-Version` 过期，或 `Zotero-Write-Token` 已提交过 |
| `413 Request Entity Too Large` | 提交条目过多 |

#### 更新条目（整体 PUT）

先 `GET <p>/items/<itemKey>` 取当前可写 JSON（`data`），修改后整体回传：

```http
PUT <p>/items/<itemKey>
Content-Type: application/json

{ "key": "ABCD2345", "version": 1, "itemType": "book", "title": "My Amazing Book",
  "creators": [], "tags": [], "collections": [], "relations": {} }
```

- 除 `itemType`、`tags`、`collections`、`relations` 外均可选。
- **未指定的既有字段会被移除**；`creators`/`tags`/`collections`/`relations` 传空则清除关联。

| 状态码 | 含义 |
|---|---|
| `204 No Content` | 更新成功 |
| `400 Bad Request` | 非法类型/字段；JSON 无法解析 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 条目自获取后已变化（版本不匹配） |

#### 局部更新条目（PATCH）

只提交发生变化的属性，未包含的属性保持不变；清空属性传空字符串或空数组：

```http
PATCH <p>/items/<itemKey>
If-Unmodified-Since-Version: <条目版本>

{ "date": "2013", "collections": [ "BCDE3456", "CDEF4567" ] }
```

> 数组属性按完整列表解释，省略某分类 key 会把条目移出该分类。

#### 版本前置条件（PUT / PATCH 通用）

- 条目当前版本在 `version` 属性或 `Last-Modified-Version` 头中。
- `PUT`/`PATCH` 必须通过 `version` 属性或 `If-Unmodified-Since-Version` 头携带当前版本。
- 若服务器版本已变化 → `412 Precondition Failed`，需重新获取最新版本。
- 父子条目同请求创建时，子条目须排在父条目之后，并使用本地生成的 item key。

#### 删除条目

```http
DELETE <p>/items/<itemKey>
If-Unmodified-Since-Version: <条目版本>
```

| 状态码 | 含义 |
|---|---|
| `204 No Content` | 已删除 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 条目自获取后已变化 |
| `428 Precondition Required` | 未提供 `If-Unmodified-Since-Version` |

#### 批量删除条目（最多 50 个）

```http
DELETE <p>/items?itemKey=<key>,<key>,<key>
If-Unmodified-Since-Version: <库版本>

204 No Content
Last-Modified-Version: <库版本>
```

| 状态码 | 含义 |
|---|---|
| `204 No Content` | 已删除 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 库版本已变化 |
| `428 Precondition Required` | 未提供 `If-Unmodified-Since-Version` |

### 6.3 分类写操作

#### 创建分类

```http
POST <p>/collections
Zotero-Write-Token: <token>   （或 If-Unmodified-Since-Version: <库版本>）

[ { "name": "My Collection", "parentCollection": "QRST9876" } ]
```

| 状态码 | 含义 |
|---|---|
| `200 OK` | 请求完成，逐条结果见响应 JSON |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 版本过期或 write token 已提交 |

#### 更新分类（PUT）

```http
PUT <p>/collections/<collectionKey>

{ "key": "DM2F65CA", "version": 156, "name": "My Collection", "parentCollection": false }
```

| 状态码 | 含义 |
|---|---|
| `200 OK` | 更新成功 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 分类版本不匹配 |

> 条目与分类的归属关系通过条目 JSON 的 `collections` 属性增删。

#### 删除分类 / 批量删除分类（最多 50 个）

```http
DELETE <p>/collections/<collectionKey>
If-Unmodified-Since-Version: <分类版本>
```

```http
DELETE <p>/collections?collectionKey=<key>,<key>,<key>
If-Unmodified-Since-Version: <库版本>

204 No Content
Last-Modified-Version: <库版本>
```

| 状态码 | 含义 |
|---|---|
| `204 No Content` | 已删除 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 版本不匹配 |

### 6.4 已保存搜索写操作

#### 创建搜索

```http
POST <p>/searches
Zotero-Write-Token: <token>   （或 If-Unmodified-Since-Version: <库版本>）

[
  {
    "name": "My Search",
    "conditions": [
      { "condition": "title", "operator": "contains", "value": "foo" },
      { "condition": "date", "operator": "isInTheLast", "value": "7 days" }
    ]
  }
]
```

| 状态码 | 含义 |
|---|---|
| `200 OK` | 请求完成，逐条结果见响应 JSON |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 版本过期或 write token 已提交 |

#### 批量删除搜索（最多 50 个）

```http
DELETE <p>/searches?searchKey=<key>,<key>,<key>
If-Unmodified-Since-Version: <库版本>

204 No Content
Last-Modified-Version: <库版本>
```

### 6.5 标签删除（最多 50 个）

```http
DELETE <p>/tags?tag=<URL编码标签1> || <URL编码标签2> || <URL编码标签3>
If-Unmodified-Since-Version: <库版本>

204 No Content
Last-Modified-Version: <库版本>
```

### 6.6 多对象写请求

- 单次最多 50 个分类 / 已保存搜索 / 条目。
- `POST` 遵循 **PATCH 语义**：未指定的属性保持不动；要清除属性需传空字符串或 `false`。

`200 OK` 响应：

```json
{
  "successful": { "0": "<saved object>", "2": "<saved object>" },
  "unchanged":  { "4": "<objectKey>" },
  "failed": {
    "1": { "key": "<objectKey>", "code": 400, "message": "<error message>" },
    "3": { "key": "<objectKey>", "code": 400, "message": "<error message>" }
  }
}
```

- `successful` / `unchanged` / `failed` 的键是上传数组中的数字下标。
- `Last-Modified-Version` 为本次被修改对象所分配的库版本。

| 状态码 | 含义 |
|---|---|
| `200 OK` | 对象已上传 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 版本过期或 write token 已提交 |

**更新多个对象**：按创建多对象的方式，但每个对象须含 `key` 与 `version`（或统一用 `If-Unmodified-Since-Version` 头）。

- 条目可含 `dateAdded`/`dateModified`（ISO 8601，如 `2014-06-10T13:52:43Z`）。
- 已有条目的 `dateAdded` 若提供必须与现有值一致，否则 `400`。
- 更新未提供 `dateModified` 时，服务器会设为当前时间。

### 6.7 对象 Key

- 服务器会自动生成合法 key。
- 同步或同请求创建父子条目时，可能需要本地生成：符合正则 `/[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}/`。

### 6.8 Zotero-Write-Token

- 可选请求头，客户端生成的 32 位随机串，用于防止**未带版本**的写请求被重复处理（如重复提交表单）。
- 成功请求的 token 会被缓存 12 小时；同 key 使用同 token 的后续请求返回 `412 Precondition Failed`。失败请求不存储 token。
- 使用带版本的写请求（`If-Unmodified-Since-Version` 或对象版本）时，该 token 冗余，应省略。
- **本地 API** 同样缓存 12 小时，但**仅在内存**中，Zotero 重启即失效。

---

## 7. 文件上传

> Zotero 10+ 本地支持 Web API 的三阶段上传流程，文件上传到 Zotero 自身而非 S3。**不支持二进制差量**（见状态码 405）。
> 仅接受「存储文件」附件（`imported_file`、`imported_url`），其他类型返回 `400`；文件须小于 4 GB。

### 阶段 1：获取上传授权

```http
POST <p>/items/<itemKey>/file
Content-Type: application/x-www-form-urlencoded
If-None-Match: *                       （已有附件用 If-Match: <旧 MD5>）

md5=<hash>&filename=<filename>&filesize=<bytes>&mtime=<毫秒>
```

> 注意 `mtime` 单位为**毫秒**，非秒。

成功 `200` 返回两种 JSON 之一：

```json
{ "url": "...", "contentType": "...", "prefix": "", "suffix": "", "uploadKey": "..." }
```

或（磁盘文件 MD5 已匹配，无需上传）：

```json
{ "exists": 1 }
```

本地实现的 `url` 指向 `/api/local/uploads/<uploadKey>`，`prefix`/`suffix` 为空字符串。

| 状态码 | 含义 |
|---|---|
| `200 OK` | 已授权上传，或文件已存在 |
| `403 Forbidden` | 禁止编辑文件 |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 文件自获取后已变化（ETag 不匹配） |
| `413 Request Entity Too Large` | 超出库容量配额 |
| `428 Precondition Required` | 未提供 `If-Match` 或 `If-None-Match` |
| `429 Too Many Requests` | 未完成的上传过多，见 `Retry-After` |

### 阶段 2：上传文件内容

将 `prefix` + 文件内容 + `suffix` 拼接后 `POST` 到上一步的 `url`，`Content-Type` 设为 `contentType`。

| 状态码 | 含义 |
|---|---|
| `201 Created` | 上传成功 |

- 本地：收到的字节必须与上一步的 `md5` 一致，否则 `400`。
- 该请求**无需** `Zotero-Server-ID` 或 API key（upload key 即为授权凭证）；upload key 一小时后过期。

### 阶段 3：注册上传

```http
POST <p>/items/<itemKey>/file
Content-Type: application/x-www-form-urlencoded
If-None-Match: *                  （已有附件用 If-Match: <旧 MD5>）

upload=<uploadKey>
```

Zotero 把上传的文件移入附件存储目录并更新条目。

| 状态码 | 含义 |
|---|---|
| `204 No Content` | 注册成功，`Last-Modified-Version` 为新库版本 |
| `412 Precondition Failed` | 文件自获取后已变化 |

### 局部上传（不支持）

```http
PATCH <p>/items/<itemKey>/file?algorithm={xdelta,vcdiff,bsdiff}&upload=<uploadKey>
```

本地返回 `405 Method Not Allowed`，请改用完整上传。

### 相关辅助请求

- 新建附件：`GET <p>/items/new?itemType=attachment&linkMode={imported_file,imported_url,linked_file,linked_url}` 取模板，再 `POST <p>/items` 创建子附件条目。
- 下载已有文件：`GET <p>/items/<itemKey>/file`，校验响应 `ETag` 与条目 `md5` 是否一致。

---

## 8. 全文内容

### 获取变化的全文内容

```http
GET <p>/fulltext?since=<version>
```

```json
{ "<itemKey>": <version>, "<itemKey>": <version> }
```

| 状态码 | 含义 |
|---|---|
| `200 OK` | 成功，`Last-Modified-Version` 为库版本 |
| `400 Bad Request` | 未提供 `since` 参数 |

### 获取单个条目的全文

```http
GET <p>/items/<itemKey>/fulltext
```

`<itemKey>` 应为已存在的附件条目。

```json
{ "content": "This is full-text content.", "indexedPages": 50, "totalPages": 50 }
```

- 文本类文档使用 `indexedChars` / `totalChars`；PDF 使用 `indexedPages` / `totalPages`。

| 状态码 | 含义 |
|---|---|
| `200 OK` | 找到全文，`Last-Modified-Version` 为该全文内容的版本 |
| `404 Not Found` | 条目不存在，或该条目没有全文内容 |

### 写入条目全文内容

```http
PUT <p>/items/<itemKey>/fulltext
Content-Type: application/json

{ "content": "This is full-text content.", "indexedChars": 26, "totalChars": 26 }
```

文本类文档带 `indexedChars`/`totalChars`；PDF 带 `indexedPages`/`totalPages`。

| 状态码 | 含义 |
|---|---|
| `204 No Content` | 更新成功 |
| `400 Bad Request` | JSON 非法 |
| `404 Not Found` | 条目不存在或非附件 |

### 批量写入全文

```http
POST <p>/fulltext
```

接受最多 10 个条目（各含 `key` 属性）的数组，返回与其他多对象写相同的结果对象。批量写需要 `If-Unmodified-Since-Version`。

- `GET <p>/fulltext?since=<version>` 与 `Last-Modified-Version` 返回的都是**本地版本**，必须按 server ID 分区。
- Zotero 不索引的内容类型返回 `400`。

### 按全文内容搜索

使用条目搜索参数 `q` 与 `qmode=everything`（详见 [5.6](#56-端点专用搜索参数)）。

---

## 9. 类型与字段接口

> 客户端无需鉴权。类型/字段数据变化罕见，建议缓存（如 1 小时）。响应中的名称按用户语言本地化，`locale` 参数被忽略；`/api/creatorFields` 例外，始终英文。
> 整个 schema（含全部语言翻译）也可一次性下载：<https://api.zotero.org/schema>

| 方法 | 路径 | 说明 | 返回 |
|---|---|---|---|
| GET | `/api/itemTypes` | 全部条目类型 | `[{ "itemType": "book", "localized": "Book" }, ...]` |
| GET | `/api/itemFields` | 全部字段 | `[{ "field": "title", "localized": "Title" }, ...]` |
| GET | `/api/itemTypeFields?itemType=book` | 指定类型的有效字段 | `[{ "field": "title", "localized": "Title" }, ...]` |
| GET | `/api/itemTypeCreatorTypes?itemType=book` | 指定类型的有效 creator 类型 | `[{ "creatorType": "author", "localized": "Author" }, ...]` |
| GET | `/api/creatorFields` | 本地化的 creator 字段 | `[{ "field": "firstName", "localized": "First" }, ...]` |
| GET | `<p>/items/new?itemType=book` | 新条目模板（可写 JSON） | 该类型字段模板，`title`/`creators`/`tags`/`collections`/`relations` 等 |

**新条目模板示例**：

```json
{
  "itemType": "book",
  "title": "",
  "creators": [ { "creatorType": "author", "firstName": "", "lastName": "" } ],
  "url": "",
  "tags": [],
  "collections": [],
  "relations": {}
}
```

```json
{ "itemType": "note", "note": "", "tags": [], "collections": [], "relations": {} }
```

**附件模板**：

```http
GET <p>/items/new?itemType=attachment&linkMode=imported_url
```

```json
{
  "itemType": "attachment", "linkMode": "imported_url", "title": "", "accessDate": "",
  "url": "", "note": "", "tags": [], "relations": {}, "contentType": "", "charset": "",
  "filename": "", "md5": null, "mtime": null
}
```

| 状态码 | 含义 |
|---|---|
| `200 OK` | 成功 |
| `304 Not Modified` | 自 `If-Modified-Since` 后无变化 |
| `400 Bad Request` | `itemType` 缺失/非法，或语言不支持 |

> `locale` 参数（如 `GET /api/itemTypes?locale=fr-FR`）在本地被忽略。

---

## 10. HTTP 状态码

| 状态码 | 含义 |
|---|---|
| `200 OK` | 成功的 GET 请求 |
| `201 Created` | 文件内容上传成功 |
| `204 No Content` | 写操作成功（更新/删除/注册上传） |
| `302 Found` | 本地文件端点重定向到 `file://` URL |
| `304 Not Modified` | 条件 GET，数据未变化 |
| `400 Bad Request` | 请求非法（非法类型/字段、JSON 不可解析、缺参数、用户 ID 非本机用户等） |
| `401 Unauthorized` | 写请求缺少有效本地 API Key |
| `403 Forbidden` | 本地 API 未启用；鉴权失败/权限不足；用户拒绝授权（`{ "denied": true }`） |
| `404 Not Found` | 请求的资源不存在 |
| `405 Method Not Allowed` | 方法不支持（如本地 `PATCH .../file`） |
| `409 Conflict` | 目标库被锁定 |
| `412 Precondition Failed` | 版本前置条件失败；`Zotero-Write-Token` 重复；`Zotero-Server-ID` 不匹配 |
| `413 Request Entity Too Large` | 提交对象过多或超出库配额 |
| `417 Expectation Failed` | 使用了不支持的 `Expect` 头 |
| `428 Precondition Required` | 缺少必需前置条件（如写请求缺 `Zotero-Server-ID`、缺 `If-Unmodified-Since-Version`） |
| `429 Too Many Requests` | 触发限流，见 `Retry-After` |
| `500 Internal Server Error` | 服务器内部错误 |
| `501 Not Implemented` | 请求了不支持的功能（Atom 输出，或非 `/api/` 端点上的非 v3 版本） |
| `503 Service Unavailable` | 服务不可用（维护等），可能带 `Retry-After` |

**限流说明（本地不适用）**：

- `Backoff: <秒>`：服务器过载时任意响应都可能携带，客户端应仅做必要请求并暂停指定秒数。
- `429`：请求过多/并发过高，配合 `Retry-After` 等待；建议并发数不超过 4。

---

## 11. 附录：端口 23119 上的其他端点

`localhost:23119` 上除 `/api/` 外，还有 Zotero Connector 服务器（浏览器插件与文字处理集成使用），**不属于本地 Web API**：

| 端点 | 说明 |
|---|---|
| `GET /connector/ping` | 存活探测，返回 `Zotero is running` |
| `POST /connector/saveItems` | 保存抓取的条目 |
| `POST /connector/saveSnapshot` | 保存网页快照 |
| `POST /connector/selectItems` | 弹出条目选择器 |
| `GET /connector/getTranslatorCode` | 获取 translator 代码 |
| `POST /connector/getSelectedCollection` | 获取当前选中分类 |
| `POST /connector/document/execCommand` | 引用/文献插入协议入口（Google Docs 等） |
| `POST /connector/document/respond` | 引用协议事务响应 |

参考：<https://www.zotero.org/support/dev/client_coding/connector_http_server> 与 <https://www.zotero.org/support/dev/client_coding/http_integration_protocol>

---

## 本地实测补充（Zotero 10.0.6）

在 `http://localhost:23119` 实际请求的观察结果，供对照：

- `GET /api/` → `200`，正文 `Nothing to see here.`；响应头含 `Zotero-Version: 10.0.6`、`Zotero-API-Version: 3`、`Zotero-Schema-Version: 44`、`Zotero-Server-ID`。
- `GET /api/users/0/items`、`/items/top`、`/items/trash`、`/collections`、`/collections/top`、`/tags`、`/searches`、`/groups`、`/settings`、`/publications/items` → 均 `200`。
- `GET /api/users/0/items?format=bibtex`、`?q=...&qmode=titleCreatorYear`、`/items/<key>/fulltext`、`/items/<key>/file/view/url` → 均 `200`。
- `GET /api/users/0/items/<key>/file` → `302`（重定向到 `file://`）。
- 顶层 `GET /api/itemTypes`、`/api/itemFields`、`/api/creatorFields` → 均 `200`；`/api/itemTypeFields` 需带 `itemType` 参数，否则 `400`。
- 误区：类型/字段端点在**顶层**（`/api/itemTypes`），不带 `users/` 前缀；`/api/users/0/itemTypes` 返回 `404`。
- `GET /connector/ping` → `200`（`Zotero is running`）。