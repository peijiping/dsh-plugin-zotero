# AGENTS.md

面向 AI 编码代理的项目指南。

## 项目概述

DSH (DeepSeek) Zotero 插件，基于 cordis 框架（`@deepseek-ai/cordis`）开发。项目处于早期阶段，`src/index.ts` 尚为脚手架状态。

## 目录结构

- `src/` — 插件主包源码（ESM，NodeNext）
  - `index.ts` — 插件入口
  - `client/` — 客户端（web）代码
  - `zotero/` — Zotero 相关逻辑（如 `client.ts`）
  - `tools/` — 工具代码（当前为空）
- `client/` — 构建产物 `client.js`（由 tsdown 产出，勿手改）
- `lib/` — `tsc` 构建产物（勿手改）
- `tstest/` — 独立测试/实验沙盒子项目，与主包环境隔离，不在主包依赖中登记
- `docs/` — DSH 插件开发文档（除非用户明确要求，**不要读取此目录**，以节省 token）
- `local/` — 本地文件

## 常用命令

```bash
npm run build            # tsc 编译 src/ -> lib/
npm run build:client     # tsdown 打包 client
npm run typecheck:client # tsc --noEmit 校验 client
```

测试子项目（在 `tstest/` 目录下）：

```bash
npm run dev   # tsx watch src/main.ts
```

## 硬性约束

- **TypeScript 版本**：主包使用 tsdown@0.22.0，其 peer 依赖要求 `typescript ^5.0.0 || ^6.0.0`，**不支持 TypeScript 7.x**。主包固定使用 ^5.9.0。
- **tstest 沙盒**：可使用 TypeScript 7.x + tsx（tsx 负责转译，绕开 tsdown 限制）；commonjs 模块类型；不得将 tstest 依赖引入主包。
- **构建产物**：不要修改 `lib/`、`client/client.js` 等产物文件。

## 约定

- 主包为 ESM（`"type": "module"`），模块解析 NodeNext，strict 模式。
- 发布文件清单见 `package.json` 的 `files` 字段：`lib`、`client`、`locale`、`cordis.patch.yml`。
- `dsh` 配置字段定义了 client 注入项与平台（web），修改需谨慎。
- 遵循迭代改进方式，避免过度工程化，优先轻量方案。
