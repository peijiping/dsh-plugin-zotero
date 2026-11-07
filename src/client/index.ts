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

import { createElement, type ComponentType, type ReactElement } from 'react'

import type { InputActions } from './inline'
import { dicts, NS, type Translate } from './locales'
import { resetPaneStore } from './paneStore'
import { createZoteroSource, type SessionsFace, type ZoteroTriggerSource } from './reference'
import { ZoteroCardController, ROW_ID, ZoteroSettingsSection } from './ZoteroCard'
import { ITEM_ADDRESS_PREFIX, ZoteroItemPane } from './ZoteroItemPane'
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

  /** 打开 / 聚焦某条目的 tab；标题先给一个，布局恢复后由标题席位读 params。 */
  const openItem = (key: string, title?: string): void => {
    const address = `${ITEM_ADDRESS_PREFIX}${encodeURIComponent(key)}`
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
    })

  const ItemTitle = (props: { useTabInfo: ItemPaneProps['useTabInfo'] }): ReactElement => {
    const info = props.useTabInfo()
    const params = info.tab.navigation?.params as { title?: unknown } | undefined
    const title = typeof params?.title === 'string' && params.title !== ''
      ? params.title
      : t('itemTab.title')
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
    () => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject(
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
    )),
    'dsh-plugin-zotero: settings section',
  )
}
