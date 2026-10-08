# tsconfig.json 介绍说明

> `tsconfig.json` 是 **TypeScript 的编译配置文件**，告诉 `tsc`（TypeScript 编译器）如何编译一个项目：编译哪些文件、输出到哪、转成什么版本的 JS、类型检查有多严格。本文结合本项目的实际文件讲解。

## 1. 它是干什么的

可以把 `tsconfig.json` 理解为 TypeScript 编译器的**任务说明书**：

- **编译范围**：哪些目录/文件要编译。
- **输出规则**：编译产物放哪、转成什么语法版本、要不要生成类型声明。
- **检查力度**：类型检查开多严格。

你运行 `tsc` 时，它会自动就近查找 `tsconfig.json` 并按里面的规则执行；编辑器（VS Code / Trae）也靠它来做智能提示和错误标红。没有它，`tsc` 不知道要干什么。

一个目录里存在 `tsconfig.json`（或 `jsconfig.json`）也标志着：**这里是一个 TypeScript 项目的根**。

## 2. 常用字段速查

以根目录 `tsconfig.json` 为例：

```json
{
  "compilerOptions": {                  // 编译选项（核心，见下节）
    "target": "ES2022",                 // 产物 JS 语法版本：可运行于支持 ES2022 的环境
    "module": "NodeNext",               // 产物模块系统：按 Node.js 的 ESM/CJS 规范处理
    "moduleResolution": "NodeNext",     // import 路径的解析规则（与 module 配套）
    "rootDir": "src",                   // 源码根目录：输入文件的公共父目录
    "outDir": "lib",                    // 产物输出目录
    "strict": true,                     // 严格类型检查（一系列严格选项的总开关）
    "declaration": true,                // 同时生成 .d.ts 类型声明文件
    "skipLibCheck": true                // 跳过 node_modules 里依赖的类型检查（加速编译）
  },
  "include": ["src"]                    // 只编译 src/ 目录
}
```

几个要点：

- 最重要的两层结构：`compilerOptions`（怎么编译）+ 顶层文件选择字段（编译谁）。
- `module` 和 `moduleResolution` 通常成对出现，保持一致即可（都用 `NodeNext` 是 Node.js ESM 项目的推荐搭配）。
- `strict: true` 是社区共识的最佳实践，新项目无脑开。
- `skipLibCheck: true` 只跳过**第三方库内部**的类型检查，不影响检查你自己的代码。

## 3. 文件选择字段：`include` / `exclude` / `files`

| 字段 | 作用 | 例子 |
|------|------|------|
| `include` | 要编译的目录/通配符 | `["src"]` |
| `exclude` | 从 include 结果中排除 | `["node_modules", "lib"]` |
| `files` | 精确列出单个文件 | `["src/index.ts"]` |

- `include` 支持 glob：`"src/**/*"` 表示 src 下所有文件（`"src"` 是其简写）。
- `node_modules` 默认就在排除列表里，一般不用手动写。
- 编译器还会顺着 `import` 语句把被引用的文件带进来，即使它不在 `include` 里。

## 4. `compilerOptions` 里最常用的选项

| 选项 | 含义 | 典型取值 |
|------|------|---------|
| `target` | 产物 JS 语法版本 | `ES2022`（Node 16+ / 现代浏览器） |
| `module` | 产物模块格式 | `NodeNext`、`ESNext`、`CommonJS` |
| `moduleResolution` | 路径解析规则 | 与 `module` 配套，一般同为 `NodeNext` |
| `outDir` / `rootDir` | 输出目录 / 输入根目录 | `lib` / `src` |
| `strict` | 严格检查总开关 | `true` |
| `declaration` | 生成 `.d.ts` 声明 | 库项目 `true`，应用项目可不设 |
| `noEmit` | 只做类型检查，不产出文件 | `true`（配合 CI 校验很常用） |
| `jsx` | JSX 处理方式（前端项目） | `react-jsx` |
| `paths` | 路径别名（如 `@/xxx`） | 见下 |

本项目是发布到 npm 的库，所以用了 `declaration: true`（让使用者拿到类型提示）；如果是纯应用（如脚本、网站），通常不需要。

## 5. 运行命令

`tsc` 有两种典型用法，都受 tsconfig.json 控制：

```bash
npx tsc                  # 按 tsconfig.json 完整编译（写产物）
npx tsc --noEmit         # 只类型检查，不写产物（常用作校验）
npx tsc -p tsconfig.client.json   # -p 指定用另一份配置文件
npx tsc --watch          # 监听源码变化，增量重编译
```

本项目的 `package.json` 中：

```json
"scripts": {
  "build": "tsc -p tsconfig.json",            // 完整编译 src/ -> lib/
  "typecheck:client": "tsc --noEmit -p tsconfig.client.json"  // 只校验 client 类型
}
```

`-p`（project）显式指定配置文件——这就是**一个项目多份 tsconfig 共存**的关键。

### 绕过配置文件：`--ignoreConfig` 与直接指定文件

有两种方式让 `tsc` 不理会 tsconfig.json：

```bash
npx tsc --ignoreConfig               # 专用参数：忽略找到的 tsconfig.json，只用命令行选项和文件编译
npx tsc hello.ts                     # 直接指定文件：官方规则——命令行给了文件就自动忽略 tsconfig.json
npx tsc hello.ts --ignoreConfig      # 两者可以叠加，显式声明更保险
```

- `--ignoreConfig` 是官方 CLI 参数，含义是"Ignore the tsconfig found and build with commandline options and files"。
- 直接给文件时 tsconfig.json 本来就会被忽略，`--ignoreConfig` 的价值在于**显式声明**，避免歧义。
- 适合快速转译单个文件、临时实验；此时命令行选项（`--target`、`--outFile` 等）是唯一配置来源。
- 这也是 tsx 之外另一种"不配 tsconfig 也能用"的方式，区别在于 tsc 仍要**预编译**，tsx 是运行时即时转译。

## 6. 为什么一个项目可以有多个 tsconfig.json

和 `package.json` 划分包边界类似，每份 `tsconfig.json` 定义一个**独立的编译上下文**：不同的编译范围、不同的目标环境，可以互不干扰。

常见场景：

- 主代码和前端代码目标环境不同（Node vs 浏览器）。
- 源码和测试用不同的检查严格度。
- 通过 `extends` 字段让多份配置继承一份公共基础配置，避免重复：

```json
{ "extends": "./tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx" } }
```

本项目的结构：

```text
dsh-plugin-zotero/
├── tsconfig.json            ← 主包：编译 src/ 到 lib/（NodeNext，ES2022）
├── tsconfig.client.json     ← client 的独立校验配置（typecheck:client 使用）
└── tstest/
    └── （没有 tsconfig.json）
```

## 7. 为什么 tstest 没有这个文件

`tstest/` 用 `tsx` 直接运行 TypeScript——tsx 在运行时**即时转译**（把 TS 转成 JS 后交给 Node 执行），用内置默认值就能工作，不依赖配置文件。

| | 主包 | tstest |
|---|---|---|
| 运行方式 | `tsc` 预编译成 `lib/` 产物 | `tsx watch src/main.ts` 直接运行 |
| 是否需要 tsconfig.json | **必需**（tsc 全靠它） | 可选（tsx 有合理默认值） |
| 模块类型 | ESM（package.json `"type": "module"`） | commonjs |

`tsconfig.json` 本质是给**编译器**看的说明书——只有需要"把 TS 编译成 JS 产物"时才必须配置；即时运行工具（tsx、ts-node）没有它也能跑。

> 顺带一提：tsx 如果发现目录里有 tsconfig.json 也会读取它来决定转译行为。tstest 里那个 `"build": "tsc"` 脚本因为缺少配置文件，直接运行会报错，属于占位脚本。

## 8. 相关命令回顾

```bash
npx tsc                       # 按 tsconfig.json 编译
npx tsc --noEmit              # 只类型检查不产出
npx tsc -p tsconfig.client.json   # 用指定配置编译/校验
npx tsc --ignoreConfig        # 忽略找到的 tsconfig.json，只用命令行选项和文件
npx tsc hello.ts              # 直接指定文件：同样忽略 tsconfig.json，按内置默认值编译
npx tsc --showConfig          # 打印解析后的完整配置（排查继承/合并问题）
```

> 配套阅读：同目录下《package.json 介绍说明》《Node 与 TypeScript 基础命令》。
