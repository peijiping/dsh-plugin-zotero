# dsh-plugin-zotero —— 项目长期记忆

## 面板形态决策（2026-10-15 定稿）
- 面板**固定为会话级右侧面板内的 tab**：`sidebarRightTabs.register({id,kind,title,guide})` + 正文席位 `sidebar.right.pane.tab`，入口走 `guide`，由用户从右侧边栏手动打开。
- **不要**再实现「常驻 / 自动打开 / pin」：`resident.ts` 已永久删除，用户实测该交互（常驻开关 + 逐会话自动 `openTab`）**体验不好**。
- **不要**再尝试把面板做成常驻浮层右栏：`shell.overlay` 方案已实施、已实测、**被用户否决**（浮层不占轨道会盖住中栏右缘，效果不好）。下面「席位体系」一节保留该调研结论，仅供将来参考。
- 插入继续用会话作用域标准 prop `inputActions`（光标处插入、带 `draftRev` 校验）。root 作用域拿不到它，所以也**不要**再把面板移出会话作用域。

## 构建 / 校验（pnpm 不在 PATH，用绝对路径或直接调本地 bin）
- `./node_modules/.bin/tsc -p tsconfig.client.json --noEmit` —— 客户端类型检查
- `./node_modules/.bin/tsdown` —— 产出 `client/client.js`（勿手改产物）
- `./node_modules/.bin/tsc -p tsconfig.json` —— 宿主半 → `lib/`
- 或 `/opt/homebrew/bin/pnpm <script>`
- 框架版本：`@deepseek-ai/dsh` / `dsh-client-*` = `0.2.0-rc.2`；客户端依赖在 pnpm 的
  `node_modules/.pnpm/@deepseek-ai+<pkg>@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4/...` 下。

## DSH 客户端 UI 席位体系（已穷举，别再重新摸索）
- `SlotMap` 是空的声明合并接口，各包 `declare module` 合并；`SlotKind = single|list|keyed|chain`，
  `SlotScope = root|session-maybe|session`。
- 根作用域**容器级**席位只有 6 个：`root`、`sidebar`、`main`(keyed)、`rightbar`(single)、
  `shell.overlay`(list)、`shell.leading`(single)。
- **不存在** `sidebar.left.*` / `workspace.*` / `app.*` / `layout.*` 前缀席位。
- `AppFrame` 网格**只有 3 条轨道** `sidebar | center | rightbar` → **没有第二条右栏轨道**。
- `rightbar` 已被 `ui-sidebar-right` 占用；往 single 席位再注册是 **shadow 顶掉**，不是并排。
- `shell.overlay` 是唯一「插件自有的全 frame 浮层」：`absolute; inset:0; z-index:20;
  pointer-events:none`，直接子元素自动 `pointer-events:auto`；入口 `ctx.slots.inject('shell.overlay', …)`。
- `sidebar.right.*` 全 6 个席位都是 `scope:'session'`；展开态/标签按
  `dsh.sidebar-right.v1.<sessionId>` 持久；`ctx.sidebarRight` 无会话上屏时**抛错**。
- 框架**没有** pin/常驻功能（`pin` 只是 `ctx.resources.pin` 资源保活）。
- 会话级标准 prop 只在 `scope: 'session' | 'session-maybe'` 席位派生（`ScopeStandardProps`）；
  `root` 作用域拿不到 `inputActions` / `useInput` / `sessionId`。
- 根作用域可用的全局标准 hook：`usePanelInfo`、`useWorkspaces`、`useSessions`、
  `useSessionStatus`、`useSessionRetainInfo`、`useResource` + `renderFactorySlot`。
  自定义 hook 用 entry 的 `inject: () => ({ hooks: { xxx: observable } })` 提供，props 名变 `useXxx`。

## 可用的公开跨插件服务（客户端）
- `ctx.slots`、`ctx.locale`、`ctx.sidebarRight`(`ISidebarRight`)、`ctx.sidebarRightTabs`、
  `ctx.layout`(`ILayout`)、`ctx.sessions`(`ISessions`，`dsh-api-session-controller`)、
  `ctx.conversation`(`IConversation`，`dsh-client-ui-conversation`)。
- 从 root 拿会话输入能力：`mounted` → `ctx.sessions.scope(id)` → `ctx.conversation.input.for(actx)`
  → `SessionInput`（`state`/`setDraft`/`insertReference`/`submit`/`notify`/`focus`；
  **无** `captureInsertion`/`insertText` —— 精确 `InputActions` 的公开读取路径不存在）。

## 几何观测（非公开 DOM 依赖，须集中一处并容错）
- frame 内联 `style.gridTemplateColumns` = `左轨 中轨 右轨`（右栏宽度取第三段）。
- `div.frame[data-rightbar-collapsed]` / `[data-rightbar-fullscreen]`。
- 右栏列 `[data-rightbar-col]`；会话右栏面板 `[data-sidebar-right-panel]`（展开时带
  `data-sidebar-right-open`，宽度可直接量该元素）。
- 反查 frame：`anchor.closest('[data-shell-overlay]').parentElement`。
- 主题令牌：`--dsw-alias-bg-base`（内容底色）、`--dsw-alias-border-l3`、`--dsw-alias-label-secondary`。

## 本项目约定
- 主包 ESM + `strict`，NodeNext；客户端 ESM→CJS bundle，入口 `src/client/index.ts`。
- 客户端只把 `react` / `react-dom` / `react/jsx-runtime` / `@deepseek-ai/cordis` /
  `@deepseek-ai/dsh-client-ui-primitives` 列为 external，其余打包进 `client/client.js`。
- 框架包的类型只声明「本项目用到的子集」，写在 `src/client/dsh-client.d.ts`（同 dshmarket 做法）。
- 面板 UI 一律用内联 style + CSS 变量，不硬编码浅色（需同时适配 light/dark）。
- `docs/` 默认不读（AGENTS.md 约定），仅用户明确要求时读。
- 改代码后同步更新 `docs/插件使用说明/dsh-plugin-zotero使用说明.zh.md`。
