/**
 * dsh-plugin-zotero —— 客户端入口。
 *
 * 在右侧栏注册一个「页」类型 tab（不给 patterns，走 guide 入口），并把面板
 * 正文注册到 `sidebar.right.pane.tab` 席位。会话级标准 prop `inputActions`
 * （ui-conversation 下发）与 `sessionId`（ui-session 下发）随槽位作用域透传给
 * 正文。
 *
 * 同时注册一个 Zotero 引用源（见 reference.ts）：面板插的引用 chip 靠它的 codec
 * 在提交时展开成模型文本。它不进 `@` 菜单（候选恒空）。
 *
 * 注意：cordis 的对象式 inject 是「拦截 config」，不是 {required,optional}，
 * 因此这里用数组式 inject。
 */

import { createElement, useEffect, type ComponentType, type ReactElement } from 'react'

import { GuideIcon } from './GuideIcon'
import {
  createHistoryRefNode,
  HISTORY_REF_NODE,
  zoteroHistoryRule,
  type UiConversationFace,
} from './historyRef'
import type { InputActions } from './inline'
import { ensureItemTitle, rememberItemTitle, useItemTitle } from './itemTitles'
import { dicts, NS, type Translate } from './locales'
import { resetPaneStore } from './paneStore'
import { createZoteroSource, type SessionsFace, type ZoteroTriggerSource } from './reference'
import { SettingsNavIcon } from './SettingsNavIcon'
import { installTheme } from './styles'
import { ZoteroCardController, ROW_ID, ZoteroSettingsSection } from './ZoteroCard'
import { ITEM_ADDRESS_PREFIX, itemKeyFromAddress, ZoteroItemPane } from './ZoteroItemPane'
import { ZoteroPane } from './ZoteroPane'

/** locale 服务中本插件用到的那部分。 */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

/** guide 入口项（kind / providerId 由注册表注入）。 */
interface GuideEntry {
  id: string
  title: () => string
  description?: () => string
  order?: number
  /**
   * 卡片图标：宿主用 `entry.icon ?? CubeGlyph` 渲染，没传就是灰色立方体占位。
   * 它要的是 React 组件（接 size / className），不是图片路径；`package.json` 的
   * `icon` 只服务插件市场与插件列表，管不到这里。
   */
  icon?: ComponentType<{ size?: number; className?: string }>
}

/** 右侧栏 tab 类型定义。 */
interface TabDefinition {
  id: string
  kind: string
  title: (address: string) => string
  multiple?: boolean
  keepMounted?: boolean
  patterns?: readonly string[]
  priority?: 'extension' | 'builtin' | 'fallback'
  guide?: readonly GuideEntry[]
}

/** 右侧栏 tab 类型注册表。 */
interface SidebarRightTabsService {
  register(definition: TabDefinition): unknown
}

/** 右侧栏导航服务（只用到按资源地址打开）。 */
interface SidebarRightService {
  openResource(address: string, options?: { params?: unknown }): void
}

/** slots 服务。 */
interface SlotsService {
  register(meta: Record<string, unknown>, component: ComponentType<never>): unknown
  /** 声明感知注册：席位尚未声明时先等，声明后（含重新声明）再注册；返回解除器。 */
  inject(key: string, callback: () => unknown): () => void
}

/** 配置表单服务（由 `@deepseek-ai/dsh-client-ui-settings` 提供）。 */
interface ConfigFormsService {
  /** 某 Host 插件条目的共享配置表单（`scope` 交给 `SettingsFormModel`）。 */
  get(entryId: string): unknown
  /** Host 服务其中任一命名空间时才注册；返回的 disposer 交给 `ctx.effect`。 */
  whileServed(
    namespaces: string[],
    register: (served: Set<string>) => () => void,
  ): () => void
}

/** 引用源注册服务（由 `@deepseek-ai/dsh-client-ui-input-trigger` 提供）。 */
interface InputTriggersService {
  /** 注册一个触发源；同名（trigger + name）重复注册会抛，故必须走 effect disposer。 */
  registerSource(source: ZoteroTriggerSource): () => void
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sidebarRightTabs: SidebarRightTabsService
  sidebarRight: SidebarRightService
  configForms: ConfigFormsService
  inputTriggers: InputTriggersService
  sessions: SessionsFace
  /**
   * cordis 运行时服务查找。**不要在 `inject` 里声明 `conversation`**：宿主
   * `ConversationController` 注册晚于插件 apply，inject 未就绪会让 fiber 永久
   * PENDING、apply 静默不执行（第 0 步 Spike 实测 apply=false / click=true）。
   */
  get?(name: string): unknown
  /**
   * 回调式 inject：等服务就绪后再执行，不会让插件 fiber 卡在 PENDING
   * （与数组式 inject 的区别见上面的注释）。
   */
  inject(
    deps: string[],
    callback: (scope: ClientContext & { uiConversation: UiConversationFace }) => void,
  ): unknown
}

/** tab 类型 id，同时用作 `sidebar.right.pane.tab` 席位的 key。 */
const TAB_ID = 'zotero'

/** 条目 tab 的类型 id / kind；正文与标题席位也按这个 key 注册。 */
const ITEM_TAB_ID = 'zotero-item'

/** 「设置」对话框里这一页的 section id（`settings.section` 的 `id`）。 */
const SETTINGS_SECTION_ID = 'zotero'

export const name = 'dsh-plugin-zotero'
export const inject = [
  'slots',
  'locale',
  'sidebarRightTabs',
  'sidebarRight',
  'configForms',
  'inputTriggers',
  'sessions',
]

export function apply(ctx: ClientContext): void {
  // 按钮 / 标题的伪类样式挂在 document.head，portal 出的浮层也能吃到。
  installTheme()
  ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-plugin-zotero: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(
    () => ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: 'zotero',
      title: () => t('tab.title'),
      guide: [{
        id: TAB_ID,
        title: () => t('guide.title'),
        description: () => t('guide.desc'),
        order: 10,
        icon: GuideIcon,
      }],
    }),
    'dsh-plugin-zotero: sidebar tab',
  )

  // 每个条目一个资源 tab：地址稳定（内容 id 即地址），同条目再次打开只聚焦已有 tab。
  ctx.effect(
    () => ctx.sidebarRightTabs.register({
      id: ITEM_TAB_ID,
      kind: ITEM_TAB_ID,
      title: () => t('itemTab.title'),
      patterns: ['dsh-resource://zotero-item/**'],
      priority: 'extension',
      keepMounted: true,
    }),
    'dsh-plugin-zotero: item tab',
  )

  /** 打开 / 聚焦某条目的 tab；标题先记进缓存，布局恢复后才不靠 params 也能显示。 */
  const openItem = (key: string, title?: string): void => {
    const address = `${ITEM_ADDRESS_PREFIX}${encodeURIComponent(key)}`
    if (title !== undefined) rememberItemTitle(key, title)
    ctx.sidebarRight.openResource(
      address,
      title === undefined || title === '' ? undefined : { params: { title } },
    )
  }

  // 引用 chip 的展开器：面板插的 chip 只带 key，提交时由这个 codec 现取文本。
  ctx.effect(
    () => ctx.inputTriggers.registerSource(createZoteroSource(t)),
    'dsh-plugin-zotero: reference codec',
  )

  // 会话历史里的引用胶囊：codec 在展开文本外留了 `<zotero-ref>` 边界（见
  // reference.ts），这里认领成胶囊节点，点开才显示完整引用。uiConversation 由
  // ui-conversation 包提供，用回调式 inject 等它就绪。
  ctx.inject(['uiConversation'], (scope) => {
    scope.effect(
      () => scope.uiConversation.userText.register(zoteroHistoryRule),
      'dsh-plugin-zotero: history rule',
    )
    const RefBody = createHistoryRefNode(t)
    scope.effect(
      () => scope.slots.inject('conversation.user.text.node', () =>
        scope.slots.register(
          { name: 'conversation.user.text.node', key: HISTORY_REF_NODE, priority: 100 },
          RefBody as ComponentType<never>,
        )),
      'dsh-plugin-zotero: history ref node',
    )
  })

  // 正文：把 t 闭包进来，并把槽位透传的会话级标准 prop（`inputActions` /
  // `sessionId`）交给面板；两者缺失都表示面板不在会话上下文。
  const Body = (props: { inputActions?: InputActions; sessionId?: string }): ReactElement =>
    createElement(ZoteroPane, {
      t,
      sessions: ctx.sessions,
      inputActions: props.inputActions,
      sessionId: props.sessionId,
      onOpenItem: openItem,
    })

  ctx.effect(
    () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: TAB_ID },
      Body as ComponentType<never>,
    ),
    'dsh-plugin-zotero: pane body',
  )

  type ItemPaneProps = Parameters<typeof ZoteroItemPane>[0]

  const ItemBody = (props: {
    inputActions?: InputActions
    sessionId?: string
    useTabInfo: ItemPaneProps['useTabInfo']
  }): ReactElement =>
    createElement(ZoteroItemPane, {
      t,
      useTabInfo: props.useTabInfo,
      sessions: ctx.sessions,
      inputActions: props.inputActions,
      sessionId: props.sessionId,
      // 只透传「取数函数」，不在 apply 闭包里缓存服务实例（服务此时尚未 ACTIVE）。
      conversation: () => ctx.get?.('conversation'),
    })

  /**
   * tab 标题。
   *
   * 标题**不能只读 `navigation.params`**：布局持久化只存
   * `{ id, kind, contentId, title }`，不存 params；刷新页面或切会话后框架用
   * `params: undefined` 重建 occurrence，标题就退回兜底文案。所以这里按地址里的
   * 条目 key 读缓存，缺了再补取一次（见 itemTitles.ts）。
   */
  const ItemTitle = (props: { useTabInfo: ItemPaneProps['useTabInfo'] }): ReactElement => {
    const info = props.useTabInfo()
    const navigation = info.tab.navigation
    const key = itemKeyFromAddress(navigation?.address || info.tab.contentId || '')
    const params = navigation?.params as { title?: unknown } | undefined
    const openedTitle = typeof params?.title === 'string' && params.title !== ''
      ? params.title
      : undefined
    const cached = useItemTitle(key)

    useEffect(() => {
      if (key !== null && cached === undefined) ensureItemTitle(key)
    }, [key, cached])

    const title = cached ?? openedTitle ?? t('itemTab.title')
    return createElement(
      'span',
      { title, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      title,
    )
  }

  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: ITEM_TAB_ID },
        ItemBody as ComponentType<never>,
      )),
    'dsh-plugin-zotero: item body',
  )

  ctx.effect(
    () => ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: ITEM_TAB_ID },
        ItemTitle as ComponentType<never>,
      )),
    'dsh-plugin-zotero: item title',
  )

  // 共享面板状态是模块级单例，插件卸载时清空。
  ctx.effect(() => () => resetPaneStore(), 'dsh-plugin-zotero: pane state')

  // 配置页：只有「设置」对话框里的独立一页（`settings.section`，root 作用域，
  // 右侧内容列），仅当 Host 服务本插件的 settings 命名空间时才注册 —— 否则
  // 表单恒为不可用状态，留着只会误导。
  // 席位选项里 `label` 是导航文案、`order` 决定它在左侧列表里的位置
  // （框架自带各页：账号 -10 / 通用 0 / 模型 10 / 内置插件 15 / Agent 预设 20，
  // 这里排在最后）。
  const controller = new ZoteroCardController(ctx.configForms.get(ROW_ID))
  ctx.effect(() => () => controller.dispose(), 'dsh-plugin-zotero: settings form')
  ctx.effect(
    () => ctx.configForms.whileServed([ROW_ID], () => {
      const offSection = ctx.slots.inject(
        'settings.section',
        () => ctx.slots.register(
          {
            name: 'settings.section',
            id: SETTINGS_SECTION_ID,
            order: 30,
            label: () => t('settings.nav'),
            locale: NS,
            inject: () => controller.inject(),
          },
          ZoteroSettingsSection as ComponentType<never>,
        ),
      )
      // 左导航图标是独立席位：外壳按 section id 取 `settings.section.icon`，
      // 没注册就退回默认齿轮。id 必须与上面一致，两者生命周期也绑在一起，
      // 免得 Host 不再服务设置命名空间时留下一个没有对应页的图标。
      const offIcon = ctx.slots.inject(
        'settings.section.icon',
        () => ctx.slots.register(
          { name: 'settings.section.icon', id: SETTINGS_SECTION_ID },
          SettingsNavIcon as ComponentType<never>,
        ),
      )
      return () => {
        offSection()
        offIcon()
      }
    }),
    'dsh-plugin-zotero: settings section',
  )
}
