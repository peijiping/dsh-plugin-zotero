# DSH 插件发布与安装（AI 讲解版）

> 本文是对 [basic-publish.zh.md](./basic-publish.zh.md) 的通俗化整理，步骤细节以原文档为准。

## 先搞懂两个概念

| 概念 | 是什么 | 由谁创建 |
|---|---|---|
| **组合包（bundle）** | 一个 npm 包，附带一份 patch 配置层 | 插件作者（你）编写并分发 |
| **profile** | 一份"可启动的组合"，位于 `$DSH_HOME/profiles/<name>`，记录装了哪些 bundle | 用户通过 `dsh` 命令自动生成 |

安装的本质：把你的 bundle 登记进 profile 的 `dsh.profile.bundles` 列表。**无论哪种发布方式，安装命令都是同一个 `dsh plugin add`，区别只在于包从哪里来。**

## 共同前提：打包三件套

不管走哪条路，你的包目录必须是这个结构：

```
hello-plugin/
├── package.json       # 声明 dsh.bundle
├── cordis.patch.yml   # patch 层（插件行）
└── index.js           # 插件入口
```

`package.json` 关键字段：

```json
{
  "name": "dsh-hello-plugin",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

注意：patch 里的插件行按**包名**（而不是相对源码路径）引用插件，这样 Node 的模块解析才能找到已安装的代码。

## 四种安装/发布方式对比

| | 方式一：本地路径 | 方式二：npm 注册表 | 方式三：tarball 包 | 方式四：GitHub 源码 |
|---|---|---|---|---|
| **定位** | 开发调试 | 推荐分发 | 私下交付 | 开源仓库 |
| **安装命令** | `add ./hello-plugin` | `add your-package` | `add ./x-0.1.0.tgz` | `add github:you/x#sha` |
| **产物形态** | 源码 link 链接 | 预构建 `lib/` | 预构建 `lib/` | 源码（装时构建） |
| **构建授权** | 不需要 | 不需要 | 不需要 | 需要 `allowBuilds` |

## 方式一：本地路径安装（开发调试用）

适合自己边开发边测，pnpm 会 link 你的源码 checkout，改动即时生效。

```sh
# 1. 安装（首次会自动初始化 profile，以 dsh-base 为第一个 bundle）
dsh plugin --profile demo add ./hello-plugin

# 2. 验证配置层是否生效（应看到 "# == dsh-hello-plugin" 层）
dsh --profile demo --dump-config

# 3. 启动
dsh --profile demo
```

卸载：`dsh plugin --profile demo remove dsh-hello-plugin`（会同时移除依赖和对应的层）。

## 方式二：npm 注册表发布（推荐分发方式）

作者发布前先构建好 `lib/`，用户装到的就是预构建代码，**零门槛、不需要任何构建授权**。

```sh
# 作者：
pnpm build      # 先产出 lib/
pnpm publish    # 发布到 npm

# 用户：
dsh plugin --profile demo add your-package-name
```

## 方式三：tarball 交付（不进注册表）

适合私下发给个别用户，同样**不需要构建授权**。

```sh
# 作者：
pnpm build
pnpm pack       # 产出 hello-plugin-0.1.0.tgz，把这个文件发出去

# 用户：
dsh plugin --profile demo add ./hello-plugin-0.1.0.tgz
```

## 方式四：GitHub 源码安装（最容易踩坑）

```sh
dsh plugin --profile demo add github:you/hello-plugin
```

**坑在哪**：git 安装拉的是**源码不是构建产物**，没有任何环节会跑你的 `build` 脚本，TypeScript 包到手时没有 `lib/`，加载直接失败。需要两边配合：

**作者**：在 `package.json` 提供 `prepare` 脚本（pnpm 在 git 安装后会自动运行它），且必须**自包含**——不能假设旁边有 monorepo checkout。通常用一个专用 tsdown 配置直接转译 `src/`，不做类型检查。

**用户**：pnpm ≥10 默认拒绝运行 git 依赖的 `prepare` 脚本，第一次 `add` 会失败。按 `dsh` 的提示，把包键加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

然后重新 `add`。注意这份授权等于"允许该包的代码在你机器上执行"，建议锁 commit（`github:you/hello-plugin#<sha>`），让后续推送无法悄悄改变实际运行的内容。

## 怎么选

- **日常开发** → 方式一（本地 link）
- **正式分发** → 方式二（npm），用户体验最好
- **不想发 npm、只给少数人** → 方式三（tarball）
- **开源项目想让人直接从仓库装** → 方式四，但要写好 `prepare` 脚本并引导用户授权

## 补充说明

- `dsh plugin --profile <name>` 后面可以直接跟任何 pnpm 子命令（它就是在 profile 目录里转发给 pnpm），所以 `list`、`update` 等也都能用。
- 后应用的 patch 层按行胜出，且 patch 替换目标行的整个 `config` 值（不做深度合并）。用户可以在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改动你的包。
- 内置组合包（如 `@deepseek-ai/dsh-base`）始终从 dsh 安装目录本身解析，可以放心依赖它存在且与安装保持一致。

## 配套阅读

- [打包与安装插件（原文档）](./basic-publish.zh.md)
