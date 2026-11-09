/**
 * 两个很小的共用 UI 件：统一按钮、分区标题。
 *
 * - `Button` 包一层宿主 Button，自动挂 {@link softButtonClass}：所有非 primary
 *   按钮都是「浅蓝底 + 蓝描边 + hover 加深」。`primary`（设置页未授权时的
 *   「授权」）保留实心，否则主操作会被弱化。
 * - `SectionTitle` 给「我的文库 / 标签 / 当前范围」三处标题同一套蓝紫配色，
 *   无底色、无边框，只保留渐变竖条 + 蓝色文字。
 *
 * 颜色规则集中写在 styles.ts 的 THEME_CSS 里，这里只管结构与透传。
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'

import { Button as HostButton } from '@deepseek-ai/dsh-client-ui-primitives'

import { SECTION_TITLE_CLASS, SOFT_BUTTON_CLASS, SOFT_BUTTON_STYLE } from './styles'

type HostButtonProps = Parameters<typeof HostButton>[0]

/** 与宿主 Button 同签名；自动套上浅底描边，保留调用方自己的紧凑尺寸。 */
export function Button({ className, variant, style, ...rest }: HostButtonProps): ReactElement {
  if (variant === 'primary') {
    return <HostButton {...rest} variant="primary" className={className} style={style} />
  }
  const merged = [SOFT_BUTTON_CLASS, className].filter((part): part is string => Boolean(part)).join(' ')
  return (
    <HostButton
      {...rest}
      variant={variant}
      className={merged}
      style={{ ...SOFT_BUTTON_STYLE, ...style }}
    />
  )
}

/** 无底色的分区标题（渐变竖条 + 蓝字）；文字过长时省略号截断。 */
export function SectionTitle({
  children,
  title,
  style,
}: {
  children: ReactNode
  title?: string
  style?: CSSProperties
}): ReactElement {
  return (
    <span className={SECTION_TITLE_CLASS} title={title} style={{ fontSize: 13, ...style }}>
      <span className="dsh-zp-title-bar" />
      <strong className="dsh-zp-title-text">{children}</strong>
    </span>
  )
}
