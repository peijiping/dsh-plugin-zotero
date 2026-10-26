/**
 * 右栏共用样式。
 *
 * 小标题（摘要 / 全文 / 参考文献 / 附件 / 笔记）统一用 {@link sectionTitleStyle}：
 * 蓝色、加粗、字号略大，方便在密集的元数据里一眼识别分区。
 */

/** 蓝色高亮色（与分隔条 hover 蓝一致）。 */
export const ACCENT = '#508cff'

/** 分区小标题。 */
export const sectionTitleStyle = {
  margin: '0 0 6px',
  fontSize: 13,
  fontWeight: 700,
  color: ACCENT,
  letterSpacing: 0.2,
} as const

/** 可点击的小标题行（带展开/收起箭头）。 */
export const sectionToggleRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  margin: '0 0 6px',
} as const

/** 展开/收起箭头按钮。 */
export const sectionToggleButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  padding: 0,
  fontSize: 11,
  lineHeight: 1,
  color: ACCENT,
  background: 'transparent',
  border: '1px solid rgba(80,140,255,0.4)',
  borderRadius: 5,
  cursor: 'pointer',
} as const
