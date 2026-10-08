# package.json 介绍说明

> `package.json` 是 Node.js / npm 生态的**包清单（manifest）文件**，用 JSON 描述一个"包"的身份、依赖和配置。npm、构建工具、IDE 都以它为准来理解这个目录。本文结合本项目的两个实际文件讲解。

## 1. 它是干什么的

可以把 `package.json` 理解为项目的**身份证 + 购物清单 + 操作手册**：

- **身份证**：告诉别人这个包叫什么、版本多少、入口在哪。
- **购物清单**：声明项目依赖哪些外部包、什么版本范围，`npm install` 按它下载。
- **操作手册**：`scripts` 定义项目专属命令，`npm run xxx` 执行。

没有它，`npm install`、`npm run build`、发布到 npm 都无从谈起。

## 2. 常用字段速查

以根目录 `package.json` 为例：

```json
{
  "name": "dsh-plugin-zotero",          // 包名：发布到 npm 时的唯一标识
  "version": "0.1.0",                   // 版本号：语义化版本 主.次.补丁
  "type": "module",                     // 模块系统：module=ESM，commonjs=CJS
  "main": "lib/index.js",               // 传统入口：别人 require/import 时的默认文件
  "exports": {                          // 现代入口：可暴露多个子路径，未列出的路径外部无法导入
    ".": "./lib/index.js",
    "./client": "./client/client.js"
  },
  "files": ["lib", "client"],           // 发布到 npm 时只打包这些目录
  "scripts": {                          // 自定义命令快捷键
    "build": "tsc -p tsconfig.json",
    "build:client": "tsdown"
  },
  "devDependencies": { ... }            // 开发依赖（见下节）
}
```

几个要点：

- `name` / `version` 是必填双雄，其他字段按需添加。
- `exports` 优先于 `main`；同时写时 Node 以 `exports` 为准。
- `type` 决定 `.js` 文件按 ESM 还是 CJS 解析——**这就是为什么根目录是 `module`、`tstest/` 是 `commonjs`，两者互不影响**。
- `scripts` 里的命令名完全自定义（`build`、`build:client` 都是自己起的），冒号只是命名习惯，不是语法要求。

## 3. 三种依赖的区别

| 字段 | 什么时候用 | 本项目例子 |
|------|-----------|-----------|
| `dependencies` | 运行时需要，会随包一起安装 | （本插件无，逻辑由宿主提供） |
| `devDependencies` | 只在开发/构建时用，装编译器、打包器等 | `typescript`、`tsdown` |
| `peerDependencies` | 声明"我需要宿主环境提供这个包"，自己不安装 | `@deepseek-ai/cordis`（由 DSH 宿主提供） |

- 插件类项目大量使用 `peerDependencies`：插件和宿主**必须共享同一份**核心库实例，如果插件自己装一份，就会出现两套实例、类型对不上的问题。
- 对应命令：`npm install xxx`（生产）、`npm install -D xxx`（开发）。

## 4. 版本号与 `^` `~` 的含义

依赖版本遵循语义化版本（semver）：`主版本.次版本.补丁版本`，如 `^5.9.0`：

- `^5.9.0`：允许 `5.x.x` 内升级（>=5.9.0 且 <6.0.0），**不接受跨主版本**。
- `~5.9.0`：只允许补丁升级（>=5.9.0 且 <5.10.0），更保守。
- 无前缀（如 `5.9.0`）：锁死精确版本。

所以 `"typescript": "^5.9.0"` 升到 7.x 时必须**手动改主版本号**——这也是为什么根目录目前停在 5.9：构建工具 `tsdown@0.22` 的 peer 依赖只接受 `typescript ^5.0.0 || ^6.0.0`，等它支持 7.x 后再改这里。

## 5. 自定义字段：`dsh` 配置

`package.json` 允许工具定义自己的字段（npm 会保留不认识的字段）。根目录里的 `dsh` 就是 DSH 插件系统的专属配置：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 打包补丁
  "client": {
    "inject": ["@deepseek-ai/dsh-client-locale", ...],  // 客户端注入的模块
    "platform": "web"
  }
}
```

- npm 本身不读它，由 DSH 的打包流程读取。
- 这是插件生态的常见做法，类似 `eslint` 字段之于 ESLint。

## 6. 为什么一个项目下有多个 package.json

npm 以 `package.json` 划定**包的边界**：一个目录里只要存在它，该目录就是一个独立作用域的包——有自己的名字、依赖、脚本，与外层互不干扰。

本项目的结构：

```text
dsh-plugin-zotero/            ← 项目根目录
├── package.json              ← 主包：插件本体，会被发布（module，TS 5.9）
├── lib/ client/ locale/
└── tstest/
    └── package.json          ← 独立子包：测试沙盒（commonjs，TS 7.0.2，tsx）
```

`tstest/` 是刻意隔离的实验沙盒：

- 它**不是**主包的依赖，所以不出现在根目录的 `devDependencies` 里——依赖清单装的是 npm 上的外部包，不是仓库内的本地目录。
- 两边的 `type`（module/commonjs）和 TypeScript 版本（5.9 / 7.0.2）完全不同但互不干扰，正好可以分别试验不同环境。
- 在 `tstest/` 里执行 `npm install` / `npx tsx` 时，npm 会就近使用 `tstest/package.json`，不会波及主包。

这种"一个仓库放多个包"的组织方式俗称 **monorepo（多包仓库）**，常见于：独立测试沙盒、前后端分包、pnpm workspace 统一管理等场景。

## 7. 相关命令回顾

```bash
npm init -y              # 生成 package.json
npm install -D tsx       # 安装并写入 devDependencies
npm run build            # 执行 scripts 里的 build
npm ls typescript        # 查看实际安装的版本
npm view typescript version   # 查看 npm 上的最新版本
```

> 配套阅读：同目录下《Node 与 TypeScript 基础命令》。
