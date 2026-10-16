# dsh-plugin-zotero

基于 [cordis](https://github.com/deepseek-ai/cordis) 框架的 DSH 插件，把本机 Zotero 文献库接进 DSH：

- **人侧**：在 DSH 右侧栏浏览 Zotero 文库（分类树 / 搜索 / 条目详情 / PDF 全文），把条目引用、摘录或整目录引用写进会话草稿。
- **模型侧**：桥接本机 Zotero 集成 MCP，模型可用 `mcp__zotero__*` 工具检索与操作文库。

两条通道互不依赖：MCP 没起，面板照常可用；Zotero 没开，模型工具自然也不可用。

> 面向使用者的完整说明（入口、交互、错误对照表）见 [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md)。

## 特性

- **右侧栏面板「Zotero 文献库」**：顶部状态栏（Zotero / 模型工具探活）+ 左侧分类树（按需拉取、标题摘要搜索）+ 右侧条目详情或分类概要。
- **三种插入方式**：单条目引用、全文划词摘录、整目录引用，均只写进会话草稿（不自动发送、不抢焦点），文本携带 `itemKey` / `collectionKey` 供模型接续操作。
- **面板严格只读**：不提供任何新建 / 改名 / 删除分类的按钮。
- **模型侧工具**：由 `cordis.patch.yml` 顺带插入 `@deepseek-ai/dsh-mcp-client`，指向 `http://127.0.0.1:23120/mcp`。

## 架构

| 半边 | 代码位置 | 通道 |
|---|---|---|
| Host | `src/index.ts`、`src/host/`、`src/zotero/` | 把 Zotero 本地 API 包装成只读 HTTP 端点，挂在 DSH 宿主 web server 上 |
| Client | `src/client/` | 在右侧栏注册 tab 与面板正文，数据与选择状态放在模块级单例 |

数据流：

```
浏览器面板  --同源 fetch-->  /dsh-zotero/api/*（Host 路由）  --HTTP-->  Zotero 本地 API（127.0.0.1:23119）
```

- Host 侧带信任栅栏：仅接受 GET，拒绝 `sec-fetch-site: cross-site`，且 `Host` 必须是回环地址（防 DNS rebinding）。
- 响应统一信封 `{ok:true,data}` / `{ok:false,error:{code,message}}`，错误码见 `src/zotero/types.ts`。
- 面板正文会被每个会话各挂一份，因此分类树 / 搜索词 / 选中项等状态放在 `src/client/paneStore.ts` 的模块级单例里，各会话看到的是同一块面板。

## 目录结构

```
src/
├── index.ts            # 插件入口（Host 半）
├── host/
│   └── router.ts       # 只读 HTTP 路由 GET /dsh-zotero/api/<action>
├── zotero/
│   ├── client.ts       # Zotero 本地 API 客户端（只读）
│   ├── config.ts       # 端点、超时、截断阈值等常量
│   └── types.ts        # Host ↔ Client 数据契约
└── client/             # 客户端（web）代码
    ├── index.ts        # 注册右侧栏 tab 与面板正文
    ├── ZoteroPane.tsx  # 面板容器：状态栏 + 分类树 + 详情
    ├── CollectionTree.tsx / ItemDetail.tsx
    ├── paneStore.ts    # 跨会话共享的面板状态
    ├── inline.ts       # 往会话草稿插入文本
    ├── compose.ts      # 插入文本模板
    ├── api.ts          # 调 Host 端点
    └── locales.ts      # zh / en 文案

client/client.js        # tsdown 产物（勿手改）
lib/                    # tsc 产物（勿手改）
cordis.patch.yml        # bundle patch 层：插入本插件与 MCP 桥接行
```

## 环境要求

- Node + **pnpm**（主包与 `tstest/` 统一用 pnpm，勿与 npm / yarn 混用）。
- **TypeScript ^5.9**：`tsdown@0.22.0` 的 peer 依赖不支持 TypeScript 7.x。
- Zotero 桌面版已运行，且已开启本地 API（见「配置」）。
- （模型侧可选）本机 Zotero 集成 MCP 服务监听 23120。
- `dsh` CLI 可用。

## 构建

```sh
pnpm install
pnpm build          # tsc：src/ -> lib/（Host 半边）
pnpm build:client   # tsdown：src/client/ -> client/client.js（Client 半边，产出 __ModuleLoader__ 外壳）
pnpm typecheck:client  # tsc --noEmit 校验客户端源码
```

## 安装进 profile

本地路径 link 的完整操作见 [方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)，核心三步：

```sh
dsh plugin --profile demo add ./
dsh --profile demo --dump-config   # 应能看到 dsh-plugin-zotero 与 mcp-zotero 两行
dsh --profile demo
```

## 日常迭代

| 改了什么 | 要做什么 |
|---|---|
| `src/`（Host 半边） | `pnpm build` → 重启 dsh |
| `src/client/`（Client 半边） | `pnpm build:client` → 重启 dsh → 浏览器重新打开页面 |
| `cordis.patch.yml` | 重启 dsh |

客户端 bundle **没有热更新**：改完必须重启 dsh 并重新加载页面。

## 配置

### 开启 Zotero 本地 API

Zotero → 设置 → 高级 → 勾选 **「允许本机其他应用与 Zotero 通信」**（默认端口 23119，仅监听回环）。验证：

```sh
curl http://127.0.0.1:23119/api/   # 期望输出：Zotero is running
```

未勾选时读端点返回 403，面板显示「Zotero 未连接」并提示启用步骤。

### 模型侧 MCP 与权限边界

`cordis.patch.yml` 的 `insert` 里插入 `mcp-zotero`（`@deepseek-ai/dsh-mcp-client`），服务端为本机 Zotero 集成 MCP（本机实测 `zotero-integrated-mcp v1.1.0`，暴露 20 个工具）。

⚠️ 面板只读，**但桥接的模型工具不是**：20 个工具中含 5 个改变文库结构的写工具（`create_collection` / `update_collection` / `delete_collection` / `add_items_to_collection` / `remove_items_from_collection`）。想收紧为纯只读，把 profile patch 里 `mcp-zotero` 那一行移除或注释掉即可，面板功能不受影响。

## 相关文档

- [插件使用说明](docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md) — 入口、交互、错误对照表
- [Zotero 本地 API 参考](docs/Zotero文档/Zotero本地API参考.md)
- [Zotero 集成 MCP 服务参考](docs/Zotero文档/Zotero集成MCP服务参考.md)
- [方案一：本地路径安装](docs/插件发布/方案一本地路径安装.zh.md)
- [开发与设计方案](.trae/documents/Zotero-DSH插件开发与设计方案.md)

## License

[MIT](LICENSE)
