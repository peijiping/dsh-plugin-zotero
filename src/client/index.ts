/**
 * dsh-plugin-zotero —— 客户端入口。
 *
 * 在右侧栏注册一个「页」类型 tab（不给 patterns，走 guide 入口），并把面板
 * 正文注册到 `sidebar.right.pane.tab` 席位。会话级标准 prop `inputActions`
 * 由 ui-conversation 通过 `uiSession.provide` 下发，随槽位作用域透传给正文。
 *
 * 注意：cordis 的对象式 inject 是「拦截 config」，不是 {required,optional}，
 * 因此这里用数组式 inject。
 */

import { createElement, type ComponentType, type ReactElement } from 'react'

import type { InputActions } from './inline'
import { dicts, NS, type Translate } from './locales'
import { resetPaneStore } from './paneStore'
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
  title: () => string
  guide?: readonly GuideEntry[]
}

/** 右侧栏 tab 类型注册表。 */
interface SidebarRightTabsService {
  register(definition: TabDefinition): unknown
}

/** slots 服务。 */
interface SlotsService {
  register(meta: Record<string, unknown>, component: ComponentType<never>): unknown
  /** 声明感知注册：席位尚未声明时先等，声明后（含重新声明）再注册。 */
  inject(key: string, callback: () => unknown): unknown
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sidebarRightTabs: SidebarRightTabsService
}

/** tab 类型 id，同时用作 `sidebar.right.pane.tab` 席位的 key。 */
const TAB_ID = 'zotero'

export const name = 'dsh-plugin-zotero'
export const inject = ['slots', 'locale', 'sidebarRightTabs']

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

  // 正文：把 t 闭包进来，并把槽位透传的会话级标准 prop `inputActions` 取出来
  // 交给面板（面板不在会话上下文时该 prop 为 undefined）。
  const Body = (props: { inputActions?: InputActions }): ReactElement =>
    createElement(ZoteroPane, { t, inputActions: props.inputActions })

  ctx.effect(
    () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: TAB_ID },
      Body as ComponentType<never>,
    ),
    'dsh-plugin-zotero: pane body',
  )

  // 共享面板状态是模块级单例，插件卸载时清空。
  ctx.effect(() => () => resetPaneStore(), 'dsh-plugin-zotero: pane state')
}
