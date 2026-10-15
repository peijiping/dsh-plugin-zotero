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
}
