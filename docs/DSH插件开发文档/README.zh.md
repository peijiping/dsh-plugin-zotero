# DSH 插件开发 · 中文文档学习包

本目录是从官方仓库 `deepseek-ai/deepseek-harness` 镜像下来的**中文版插件开发文档**，
离线可读。所有文件都保留原文档正文，仅文件名做了扁平化，末尾附官方链接。

> 镜像时间：2026-10（master 分支）。官方文档更新后请重新拉取。

## 一、先建立心智模型

DSH 的插件系统 = **Cordis 插件框架** + **Harness 的能力服务**。三句话记住：

1. **插件就是一个导出 `apply(ctx)` 的模块**。`apply` 在加载时被调用，你通过 `ctx` 注册能力。
2. **注册是 effect，会自动回收**。事件、工具、定时器在插件卸载时自动清理，无需 `removeListener`。
3. **能力靠 `inject` 声明依赖**。`export const inject = ['tools']` 让框架等到 `tools` 就绪再加载你。

分发形态是 npm 包（**组合包 / bundle**）：`package.json` 里的 `dsh.bundle.patch` 指向一个
`cordis.patch.yml`，安装进 **profile** 后由 loader 按层组合。

## 二、推荐学习路径（按顺序读）

### 阶段 1 · 最小可运行（约 1 小时）

| 顺序 | 文档 | 你会得到 |
|---|---|---|
| 1 | [basic-index.zh.md](basic-index.zh.md) | 写出第一个 `apply` 插件，用 `--patch` overlay 加载 |
| 2 | [basic-tool.zh.md](basic-tool.zh.md) | 用 `defineTool` 注册一个模型可调用的工具 |
| 3 | [basic-config.zh.md](basic-config.zh.md) | 用 Schemastery 让插件接受配置 |

### 阶段 2 · Cordis 框架（动手教程，7 章）

如果想彻底搞懂"为什么"，跟着 [tutorial/](tutorial/) 逐章敲一遍。
教程用仓库内的独立启动器，**不需要 API key**。

1. [tutorial/01-first-plugin.zh.md](tutorial/01-first-plugin.zh.md) — 插件是函数，由 loader 挂载
2. [tutorial/02-lifecycle-and-effects.zh.md](tutorial/02-lifecycle-and-effects.zh.md) — 生命周期与自动回收
3. [tutorial/03-services.zh.md](tutorial/03-services.zh.md) — 在 ctx 上提供能力、用 inject 依赖
4. [tutorial/04-events.zh.md](tutorial/04-events.zh.md) — 类型化事件、广播与 waterfall
5. [tutorial/05-config.zh.md](tutorial/05-config.zh.md) — 校验配置、错误要响亮
6. [tutorial/06-composition-and-hmr.zh.md](tutorial/06-composition-and-hmr.zh.md) — 把配置当插件树、热重载
7. [tutorial/07-into-the-harness.zh.md](tutorial/07-into-the-harness.zh.md) — 接入真实 harness 服务

概念速查（不想一步步做时读这个）：[cordis-primer.zh.md](cordis-primer.zh.md)
教程总览：[tutorial/index.zh.md](tutorial/index.zh.md)

### 阶段 3 · 深入与分发

- [framework-index.zh.md](framework-index.zh.md) — 插件与生命周期全景
- [framework-service.zh.md](framework-service.zh.md) — 如何对外提供服务
- [framework-events.zh.md](framework-events.zh.md) — 事件模型
- [practice-index.zh.md](practice-index.zh.md) — 能力分层：Definition / Provider / Consumer 三类包
- [practice-llm-adapter.zh.md](practice-llm-adapter.zh.md) — 接入一个 LLM 适配器
- [practice-dynamic-cordis.zh.md](practice-dynamic-cordis.zh.md) — 动态挂载插件
- [basic-publish.zh.md](basic-publish.zh.md) — **打包成组合包、装进 profile、理解层优先级**
- [glossary.zh.md](glossary.zh.md) — 术语表（bundle / profile / patch / fiber / effect…）

### 阶段 4 · 界面插件（Web UI）

`@deepseek-ai/dsh-client-ui-*` 系列插件给前端加卡片、设置页、侧边栏。
社区插件 `dshmarket` 是完整范例，本地已安装，可直接读源码：

```
~/.dsh/profiles/desktop/node_modules/dshmarket/
  package.json      → dsh.bundle.patch 和 dsh.client.inject
  cordis.patch.yml  → 把自己 insert 进组合
  src/index.ts      → Host 半（Node 侧）
  src/client/       → 浏览器半
  lib/              → 构建产物（发布入口）
```

`dsh.client.inject` 声明你依赖哪些前端插件（locale、settings、theme…），
`platform: "web"` 表示只注入 Web 端。

## 三、环境说明（你当前是桌面 App）

官方文档默认你在**源码 checkout** 里跑 `pnpm dsh ...`。你装的是打包版桌面 App
（`/Applications/DeepSeek Harness.app`），差异如下：

- CLI 启动器在 `runtime/cli/bin/dsh`，**未加入 PATH**。想用命令行，可直接调该绝对路径，
  或 `export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin:$PATH"`。
- 文档里 `pnpm dsh web --patch ./x/cordis.yml` 对应本地覆盖层加载；
  桌面 App 侧更简单的路径是用 **侧边栏「插件」页** 或 agent 的 `plugin_manager` 工具启停/安装。
- profile 目录：`~/.dsh/profiles/desktop/`（`package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml`）。
- **插件安装的构建脚本会在宿主进程、沙箱之外执行**，只对可信来源授权并锁定 commit。

## 四、官方链接

- 开发文档目录：https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop
- 第一个插件：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md
- 开发一个工具：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/tool.zh.md
- 插件配置：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.zh.md
- 打包与安装：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md
- 工具编写参考（cookbook）：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.zh.md
- 添加设置卡片（cookbook）：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-settings-card.zh.md
- Cordis 教程：https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/cordis-tutorial
- Cordis 核心 API：https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/cordis-api
- 社区插件市场：https://dshmarket.com

> 注：`raw.githubusercontent.com` 在本机被网络重置，但 `api.github.com` 可用；
> 本目录的文档即通过 GitHub Contents API 下载。
