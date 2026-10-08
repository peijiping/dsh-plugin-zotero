# Node 与 TypeScript 基础命令

> 以 `tstest` 目录的实际操作为例，按学习顺序整理。

## 1. node —— 运行 JavaScript / TypeScript

```bash
node hello.ts    # 新版 Node 可以直接跑 TS（自动剥离类型标注）
node hello.js    # 运行编译后的 JS 文件
```

- `node` 是 JavaScript 的运行时（就像 Python 的 `python` 解释器）。
- 新版 Node（23+ 默认支持，22.x 需加 `--experimental-strip-types`）能直接执行 `.ts` 文件，但它只是"去掉类型"，不做类型检查。

## 2. npm init —— 初始化项目

```bash
npm init -y
```

- 把当前目录变成一个 npm 项目，生成 `package.json`（项目的"身份证"：名字、版本、依赖清单）。
- `-y`（yes）：所有问题都用默认值，不再逐个询问。

## 3. npm install —— 安装依赖

```bash
npm install typescript --save-dev
npm install -D tsx          # -D 是 --save-dev 的缩写
```

- 包会下载到 `node_modules/` 目录。
- `--save-dev` / `-D`：记录为**开发依赖**（`devDependencies`），只在开发时用（如编译器、运行器），不会打包进最终产物。
- 不加 `-D` 则记录为生产依赖（`dependencies`）。
- 同时会生成/更新 `package-lock.json`，锁定依赖的精确版本，保证别人装到的版本和你一致。

## 4. npx —— 运行项目里装好的命令

```bash
npx tsc --version
npx tsx hello.ts
```

- `npx` 会优先在当前项目的 `node_modules/.bin/` 里找命令；找不到时可以临时下载执行。
- 装完 `-D tsx` 之后，`npx tsx` 就不会再提示 "Need to install..." 了。

### 补充：npm / npm run / npx 的区别

三者不是新旧关系，是**职责不同的三件事**，npm 和 npx 都随 Node 一起安装：

| 命令 | 作用 | 例子 |
|------|------|------|
| `npm install` | **装包**、管理依赖（类比 App Store 下载 App） | `npm install -D tsx` |
| `npm run xxx` | 执行 **package.json 里 `scripts` 定义好的脚本** | `npm run build` |
| `npx xxx` | 直接**运行包自带的命令行工具**（类比"直接打开某个 App"） | `npx tsx hello.ts` |

几个要点：

- `npm run xxx` 里的 `xxx` 是项目作者在 `package.json` 中**自定义的快捷键**，叫什么、干什么完全随意：

  ```json
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc"
  }
  ```

  `npm run dev` ≈ 手动敲 `tsx watch src/main.ts`，唯一多做的事是把 `node_modules/.bin` 加进 PATH（所以脚本里能直接写 `tsx`、`tsc`，不用加 `npx`）。

- `scripts` 里的值就是**纯 shell 命令字符串**，npm 只是代你敲一遍，不是"直接执行 ts 脚本"。

- `npm run build` 和 `npx tsc` 可以等价——区别只是命令**写在哪**：`npx` 临时敲，`scripts` 里存起来复用。

**记忆口诀**：
- 装东西 → `npm install`
- 项目定了快捷键 → `npm run 快捷键名`
- 临时/直接执行工具命令 → `npx 工具名`

## 5. tsc —— TypeScript 编译器

```bash
npx tsc                 # 按 tsconfig.json 编译整个项目
npx tsc hello.ts        # ❌ 报错 TS5112（见下）
npx tsc hello.ts --ignoreConfig   # 忽略 tsconfig，只编译指定文件
```

- 作用：把 `.ts` 编译成 `.js`（如生成 `hello.js`），并在编译期做**类型检查**。
- **TS5112 错误**：目录里已有 `tsconfig.json` 时，tsc 规定"命令行指定了文件就不读配置"，两者冲突。要么去掉文件名（用 `npx tsc`），要么加 `--ignoreConfig`。

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
```

- 跳过"手动编译 → 再跑 JS"两步，一条命令直接运行 TS，改完即跑。
- 内部用的是 esbuild，速度很快；但**不做类型检查**，检查类型还是要靠 `tsc` 或编辑器。

## 7. 两种工作流对比

| 流程 | 命令 | 特点 |
|------|------|------|
| 传统编译 | `npx tsc` → `node dist/hello.js` | 有完整类型检查，适合正式项目 |
| 直接运行 | `npx tsx hello.ts` | 即改即跑，适合学习和脚本 |

## 8. 本次实验涉及的文件

| 文件 | 作用 |
|------|------|
| `hello.ts` | 你写的 TypeScript 源码 |
| `hello.js` | tsc 编译产物 |
| `package.json` | 项目清单，记录依赖和脚本 |
| `package-lock.json` | 锁定依赖精确版本 |
| `node_modules/` | 下载的依赖包（不用提交到 git） |
| `tsconfig.json` | tsc 的编译配置 |
