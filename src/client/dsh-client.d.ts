/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的环境声明。
 *
 * 该模块由宿主冻结模块表在运行期提供（构建时列为 external），发布的 npm
 * 包只是 dev 期的镜像；这里只声明本插件用到的那部分（与 dshmarket 的
 * primitives.d.ts 同法）。签名对齐 dsh 0.2.0-rc.2。
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type {
    ButtonHTMLAttributes,
    InputHTMLAttributes,
    ReactElement,
    ReactNode,
  } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Pill(props: {
    active?: boolean
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement

  export function Input(props: {
    icon?: ReactNode
    className?: string
  } & InputHTMLAttributes<HTMLInputElement>): ReactElement

  export function Modal(props: {
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }): ReactElement | null

  export function Tooltip(props: {
    label: string | (() => string)
    side?: 'right' | 'bottom' | 'top'
    delayMs?: number
    disabled?: boolean
    maxWidth?: number
    children: ReactElement
  }): ReactElement

  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuEntry[]
  }
  export interface MenuSeparator {
    type: 'separator'
    id: string
  }
  export interface MenuLabel {
    type: 'label'
    id: string
    text: string
  }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items: readonly MenuEntry[]
    footer?: readonly MenuEntry[]
    selectedId?: string | undefined
    selectedIds?: readonly string[] | undefined
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    closeOnPointerLeave?: boolean
    dense?: boolean
    compact?: boolean
    className?: string
  }): ReactElement

  export interface DisclosureRowProps {
    icon: ReactNode
    title: string
    open: boolean
    expandable: boolean
    onToggle: () => void
    expandOnRowClick?: boolean | undefined
    previewChevron?: boolean | undefined
    keepContentWhenOpen?: boolean | undefined
    collapsedContent?: ReactNode
    children?: ReactNode
    className?: string | undefined
    rowClassName?: string | undefined
    leadingClassName?: string | undefined
    chevronClassName?: string | undefined
    titleClassName?: string | undefined
  }

  export function DisclosureRow(props: DisclosureRowProps): ReactElement

  // ---- 配置表单（settings form）--------------------------------------------
  // 只在插件页（plugins.row.config / plugins.bundle.config 席位）使用。

  /** `SettingsForm` 的框架文案。 */
  export interface SettingsFormLabels {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }

  /** 表单整体状态（`SettingsFormModel.shell()` 的返回）。 */
  export interface SettingsFormState {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  export function SettingsForm(props: {
    labels: SettingsFormLabels
    state: SettingsFormState
    onSave: () => void
    onDiscard: () => void
    children?: ReactNode
  }): ReactElement

  /** 单个值字段：显示暂存文本、是否已覆盖、是否非法。 */
  export function SettingsValueField(props: {
    id: string
    label: string
    hint?: string | undefined
    help?: { label: string; content: ReactNode } | undefined
    overriddenLabel?: string | undefined
    resetLabel?: string | undefined
    invalidLabel?: string | undefined
    numeric?: boolean | undefined
    disabled?: boolean | undefined
    placeholder?: string | undefined
    text: string
    overridden: boolean
    invalid: boolean
    onEdit: (text: string) => void
    onReset: () => void
  }): ReactElement

  /** 受控开关（`role="switch"`）；点按后回调「期望的新状态」。 */
  export function Switch(props: {
    checked: boolean
    onChange: (checked: boolean) => void
    label: string
    disabled?: boolean | undefined
    title?: string | undefined
    className?: string | undefined
  }): ReactElement

  /** 字段的转换规格（`settingsNumberField` / `settingsTextField` 的产物）。 */
  export interface SettingsFieldSpec {
    field: string
    format: (value: unknown) => string
    parse: (text: string) => { kind: 'set'; value: unknown } | { kind: 'clear' } | undefined
  }

  /** 整数字段：空串=清除覆盖；非有限数字=阻止保存。 */
  export function settingsNumberField(field: string): SettingsFieldSpec

  /** 文本字段：空串=清除覆盖。 */
  export function settingsTextField(field: string): SettingsFieldSpec

  /** 单字段的投影（`SettingsFormModel.field()` 的返回）。 */
  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }

  /** 表单动作（`SettingsFormModel.actions()` 的返回）。 */
  export interface SettingsActions {
    edit(field: string, text: string): void
    resetField(field: string): void
    save(): void
    discard(): void
  }

  /** 快照 store：`bind()` 产物的读面。 */
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }

  /**
   * 一张卡片的暂存表单模型；`scope` 由 `configForms.get(entryId)` 提供。
   * 只声明本插件用到的成员。
   */
  export class SettingsFormModel {
    constructor(scope: unknown, specs: SettingsFieldSpec[], secrets?: SettingsFieldSpec[])
    bind<T>(project: () => T): SnapshotStore<T>
    shell(): SettingsFormState
    field(field: string): SettingsFieldState
    actions(): SettingsActions
    dispose(): void
  }
}
