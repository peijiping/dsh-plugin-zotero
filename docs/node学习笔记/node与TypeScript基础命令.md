# Node 与 TypeScript 基础命令

> 以 `tstest` 目录的实际操作为例，按学习顺序整理。
>
> **关于包管理器**：本仓库统一使用 **pnpm**。但 npm 是随 Node 一起分发的默认工具，也是理解整个生态的基础——所以下面每条命令都给出 `npm` 与 `pnpm` 两种写法，对照着记最容易上手。

## 1. node —— 运行 JavaScript / TypeScript

```bash
node hello.ts    # 新版 Node 可以直接跑 TS（自动剥离类型标注）
node hello.js    # 运行编译后的 JS 文件
```

- `node` 是 JavaScript 的运行时（就像 Python 的 `python` 解释器）。
- 新版 Node（23+ 默认支持，22.x 需加 `--experimental-strip-types`）能直接执行 `.ts` 文件，但它只是"去掉类型"，不做类型检查。

## 2. init —— 初始化项目

```bash
npm init -y      # npm 写法，-y 表示全部用默认值
pnpm init        # pnpm 写法，无需 -y，直接生成
```

- 把当前目录变成一个 Node 项目，生成 `package.json`（项目的"身份证"：名字、版本、依赖清单）。
- 只有"目录里有 `package.json`"，包管理器才认为这里是一个包的边界。

## 3. install / add —— 安装依赖

```bash
# npm
npm install typescript --save-dev
npm install -D tsx          # -D 是 --save-dev 的缩写

# pnpm（注意：安装用 add，不是 install）
pnpm add -D tsx
pnpm add typescript
pnpm add -D --save-exact tsx@4.23.15   # 开发依赖 + 锁死精确版本
```

- 包会下载到 `node_modules/` 目录。
- `--save-dev` / `-D`：记录为**开发依赖**（`devDependencies`），只在开发时用（如编译器、运行器），不会打包进最终产物。
- 不加 `-D` 则记录为生产依赖（`dependencies`）。
- `--save-exact`（简写 `-E`）：写版本号时用**精确值**，不加 `^` / `~` 前缀（详见本节末尾的补充）。
- 同时会生成/更新锁文件，锁定依赖的精确版本，保证别人装到的版本和你一致：npm 是 `package-lock.json`，pnpm 是 `pnpm-lock.yaml`。
- `pnpm install`（不带 `add`）专门表示"按清单和锁文件把依赖装齐"，对应 npm 的 `npm install`。
- 卸载：npm 用 `npm uninstall xxx`，pnpm 用 `pnpm remove xxx`。

### 补充：`--save-exact` —— 版本号前缀的取舍

`-D` 和 `--save-exact` 是**两个独立**的参数，管的是不同的事：

| 参数 | 全称 | 作用 |
|------|------|------|
| `-D` | `--save-dev` | 写进 `devDependencies` 而不是 `dependencies` |
| `--save-exact`（简写 `-E`） | — | 写进 `package.json` 的版本号用精确值，不加 `^` / `~` |

同一条命令，加不加 `--save-exact`，落到 `package.json` 的内容不同：

```jsonc
// pnpm add -D @deepseek-ai/dsh@0.2.0-rc.2
"@deepseek-ai/dsh": "^0.2.0-rc.2"   // 允许后续装到 0.2.x 里的任何新版本

// pnpm add -D --save-exact @deepseek-ai/dsh@0.2.0-rc.2
"@deepseek-ai/dsh": "0.2.0-rc.2"    // 永远只认这一个版本
```

几个要点：

- `^` 的含义是"主版本号相同即可"，`~` 是"次版本号相同即可"，去掉前缀就是完全相等。默认插入哪种前缀由 `save-prefix` 配置决定（默认 `^`），`--save-exact` 相当于一次性地把它覆盖成空。
- `-D` 和 `--save-exact` 只影响**写进 `package.json` 的版本声明**。`pnpm-lock.yaml` 本来就会把版本钉死到精确值，所以短时间内看不出差别；差异出现在将来有人删掉 `node_modules`、或按 `package.json` 里的范围重新解析依赖时。
- 什么时候该用：依赖的行为需要和某个具体版本严格对齐时（例如要和本机已装的桌面 App 内置运行时保持同一版本，避免行为不一致难排查）。
- 什么时候不必用：多数工具类依赖（编译器、运行器）保留默认的 `^` 更方便，能自动吃到补丁修复。
- 想全局默认精确，不必每次敲参数，写进 `.npmrc`（`save-exact=true`）即可。

## 4. npx / pnpm exec —— 运行项目里装好的命令

```bash
npx tsc --version
npx tsx hello.ts

pnpm exec tsx hello.ts      # pnpm 的等价写法
pnpm dlx create-vite        # 等价于 npx 的"临时下载再执行"
```

- `npx` 会优先在当前项目的 `node_modules/.bin/` 里找命令；找不到时可以临时下载执行。
- 装完 `-D tsx` 之后，`npx tsx` 就不会再提示 "Need to install..." 了。
- pnpm 把这两件事拆成两个命令：`pnpm exec` 跑**本地已装**的命令，`pnpm dlx` 跑**临时下载**的命令。

### 补充：装包 / 跑脚本 / 跑工具 的区别

三者不是新旧关系，是**职责不同的三件事**。npm 和 npx 随 Node 一起安装，pnpm 需要单独安装（本机 `pnpm -v` 已是 11.x）：

| 职责 | npm 写法 | pnpm 写法 | 类比 |
|------|---------|----------|------|
| **装包**、管理依赖 | `npm install -D tsx` | `pnpm add -D tsx` | App Store 下载 App |
| 执行 `scripts` 里的脚本 | `npm run build` | `pnpm build` | 一键启动预设好的操作 |
| 直接运行包自带的工具 | `npx tsx hello.ts` | `pnpm exec tsx hello.ts` | 直接打开某个 App |

几个要点：

- `npm run xxx` 里的 `xxx` 是项目作者在 `package.json` 中**自定义的快捷键**，叫什么、干什么完全随意：

  ```json
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc"
  }
  ```

  `npm run dev` ≈ 手动敲 `tsx watch src/main.ts`，唯一多做的事是把 `node_modules/.bin` 加进 PATH（所以脚本里能直接写 `tsx`、`tsc`，不用加 `npx`）。

- `scripts` 里的值就是**纯 shell 命令字符串**，包管理器只是代你敲一遍，不是"直接执行 ts 脚本"。

- `npm run build` 和 `npx tsc` 可以等价——区别只是命令**写在哪**：`npx` 临时敲，`scripts` 里存起来复用。

- pnpm 可以**省略 `run`**：`pnpm build` 就等于 `pnpm run build`。只有当脚本名和 pnpm 内置命令重名时（比如叫 `install`、`add`）才必须写全 `pnpm run xxx`。

**记忆口诀**：
- 装东西 → `npm install xxx` / `pnpm add xxx`
- 项目定了快捷键 → `npm run 快捷键名` / `pnpm 快捷键名`
- 临时或直接执行工具命令 → `npx 工具名` / `pnpm exec 工具名`

## 5. tsc —— TypeScript 编译器

```bash
npx tsc                 # 按 tsconfig.json 编译整个项目
npx tsc hello.ts        # ❌ 报错 TS5112（见下）
npx tsc hello.ts --ignoreConfig   # 忽略 tsconfig，只编译指定文件
```

- 作用：把 `.ts` 编译成 `.js`（如生成 `hello.js`），并在编译期做**类型检查**。
- **TS5112 错误**：目录里已有 `tsconfig.json` 时，tsc 规定"命令行指定了文件就不读配置"，两者冲突。要么去掉文件名（用 `npx tsc`），要么加 `--ignoreConfig`。
- 上面三条在 pnpm 项目里把 `npx` 换成 `pnpm exec` 即可，如 `pnpm exec tsc`。

### tsconfig.json（配置文件）

```jsonc
{
  "compilerOptions": {
    "target": "es2020",      // 编译成哪个版本的 JS
    "module": "commonjs",    // 模块规范
    "outDir": "./dist",      // 编译产物输出目录
    "strict": true           // 开启严格类型检查
  },
  "include": ["src"]         // 编译哪些文件
}
```

## 6. tsx —— 直接运行 TypeScript（推荐学习阶段用）

```bash
npx tsx hello.ts
pnpm exec tsx hello.ts      # pnpm 写法
```

- 跳过"手动编译 → 再跑 JS"两步，一条命令直接运行 TS，改完即跑。
- 内部用的是 esbuild，速度很快；但**不做类型检查**，检查类型还是要靠 `tsc` 或编辑器。

## 7. 两种工作流对比

| 流程 | 命令 | 特点 |
|------|------|------|
| 传统编译 | `npx tsc` → `node dist/hello.js`（pnpm：`pnpm exec tsc`） | 有完整类型检查，适合正式项目 |
| 直接运行 | `npx tsx hello.ts`（pnpm：`pnpm exec tsx hello.ts`） | 即改即跑，适合学习和脚本 |

## 8. 本次实验涉及的文件

| 文件 | 作用 |
|------|------|
| `hello.ts` | 你写的 TypeScript 源码 |
| `hello.js` | tsc 编译产物 |
| `package.json` | 项目清单，记录依赖和脚本 |
| `package-lock.json` / `pnpm-lock.yaml` | 锁文件，锁定依赖精确版本（npm / pnpm 各一份，任选其一） |
| `node_modules/` | 下载的依赖包（不用提交到 git） |
| `tsconfig.json` | tsc 的编译配置 |

## 9. 把 `tstest` 从 npm 切到 pnpm

在 `tstest/` 目录下执行：

```bash
rm -rf node_modules package-lock.json   # 清掉 npm 的安装产物与锁文件
pnpm install                            # 重新安装，生成 pnpm-lock.yaml
```

- **两个锁文件不能共存**：留着 `package-lock.json` 会让后续 `pnpm install` 的结果和记录不一致。
- 迁完后新增依赖一律用 `pnpm add`，不要再敲 `npm install`，否则又会生成 npm 的锁文件，等于白切。
- 可选：在 `package.json` 里加 `"packageManager": "pnpm@11.0.8"`，让协作者和 CI 认准同一个安装器。
- 如果切换后有工具报 `Cannot find module`，多半是 pnpm 默认的软链接布局导致，加一行 `nodeLinker: hoisted`（或 `.npmrc` 里的 `shamefully-hoist=true`）退回扁平结构即可。

> 配套阅读：同目录下《package.json 介绍说明》《node_modules 介绍说明》。
