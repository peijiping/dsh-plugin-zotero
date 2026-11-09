/**
 * 右栏共用配色中心。
 *
 * 颜色分两类：
 * - 图标用固定的 Zotero 色（蓝 / 绿 / 橙 / 红），深浅主题下都保持彩色；
 * - 按钮用半透明底色叠在宿主背景上；标题不铺底色，只靠渐变竖条与文字色点缀。
 *   文字取宿主主题变量，避免写死亮/暗两套值。伪类（hover / active /
 *   disabled）没法写进内联 style，统一放在 {@link THEME_CSS}，由客户端入口注入一次。
 */

import type { CSSProperties } from 'react'

/** 蓝色高亮色（详情面板的区块标题、当前附件标记等旧调用）。 */
export const ACCENT = '#508cff'

/** Zotero 风格的图标色：固定彩色，不随主题变。 */
export const TREE_BLUE = '#3b7de0'
export const TREE_GREEN = '#2f9e63'
export const TREE_ORANGE = '#e0872f'
export const TREE_RED = '#dc5a55'
export const TREE_PURPLE = '#8a63e8'

/** 标题的蓝→紫点缀。 */
export const TITLE_BAR_GRADIENT = `linear-gradient(180deg, #4a86e8 0%, ${TREE_PURPLE} 100%)`

/**
 * 所有按钮的常态配色：浅蓝底 + 蓝色线条轮廓。
 *
 * 用内联样式而非 CSS 类覆盖宿主 Button 的默认 background/border（内联优先级
 * 更高）；hover 等伪类交给 {@link THEME_CSS} 的 `.dsh-zp-soft-btn` 规则。
 * 文字取宿主主题变量，深浅色都可读；主色只体现在底、框、图标上。
 */
export const SOFT_BUTTON_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  background: 'rgba(74,134,232,0.10)',
  border: '1px solid rgba(74,134,232,0.45)',
  boxShadow: '0 1px 1px rgba(31,64,128,0.05)',
  boxSizing: 'border-box',
}

/** 选中 / 激活态：同一套描边，底色与边框加深。 */
export const SOFT_BUTTON_ACTIVE_STYLE: CSSProperties = {
  ...SOFT_BUTTON_STYLE,
  background: 'rgba(74,134,232,0.24)',
  border: '1px solid rgba(74,134,232,0.85)',
}

/** 所有「浅底 + 描边」按钮共用的 class（primary 实心主操作不加）。 */
export const SOFT_BUTTON_CLASS = 'dsh-zp-soft-btn'
/** 标题外壳 class；文字色与渐变竖条写在 CSS 里（要做 light/dark 渐进增强）。 */
export const SECTION_TITLE_CLASS = 'dsh-zp-title'

/** 按钮 class：选中 / 激活态多挂 `is-active`，hover 时底色加深得更多。 */
export function softButtonClass(active = false): string {
  return active ? `${SOFT_BUTTON_CLASS} is-active` : SOFT_BUTTON_CLASS
}

/**
 * 标签胶囊的配色，与蓝色系操作按钮分开：
 * 默认**完全无底色**（只留中性灰细描边），选中照 Zotero 标签选择器用
 * **深灰底 + 白字**——全站已经够蓝了，标签选中不再掺蓝。
 * 不复用 `.dsh-zp-soft-btn`，否则它 hover 的 !important 会改掉选中底色。
 */
export const TAG_IDLE_STYLE: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, CanvasText)',
  background: 'transparent',
  border: '1px solid rgba(127,127,127,0.34)',
  boxSizing: 'border-box',
}

/** Zotero 风格的选中标签高亮：深灰 #5a5a5a + 白字。 */
export const TAG_SELECTED_STYLE: CSSProperties = {
  color: '#ffffff',
  background: '#5a5a5a',
  border: '1px solid #4f4f4f',
  fontWeight: 600,
  boxSizing: 'border-box',
}

/**
 * 「全部 / 任一」这类模式开关的选中态：与全站按钮同族（浅蓝底 + 蓝描边），
 * 只把底色加深一档，不用实心色，也不改文字色。
 */
export const MODE_BUTTON_ACTIVE_STYLE: CSSProperties = {
  ...SOFT_BUTTON_ACTIVE_STYLE,
  background: 'rgba(74,134,232,0.32)',
  border: '1px solid rgba(74,134,232,0.9)',
}

export const TAG_BUTTON_CLASS = 'dsh-zp-tag'

/** 选中态多挂 `is-selected`，CSS 只负责 hover / active。 */
export function tagButtonClass(selected = false): string {
  return selected ? `${TAG_BUTTON_CLASS} is-selected` : TAG_BUTTON_CLASS
}

/** 全局主题样式：只在入口注入一次，portal / 浮层里的按钮同样生效。 */
export const THEME_CSS = `
.dsh-zp-soft-btn {
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dsh-zp-soft-btn:hover:not(:disabled) {
  background-color: rgba(74, 134, 232, 0.20) !important;
  border-color: rgba(74, 134, 232, 0.78) !important;
}
.dsh-zp-soft-btn.is-active:hover:not(:disabled) {
  background-color: rgba(74, 134, 232, 0.42) !important;
}
.dsh-zp-soft-btn:active:not(:disabled) {
  background-color: rgba(74, 134, 232, 0.26) !important;
}
.dsh-zp-soft-btn.is-active:active:not(:disabled) {
  background-color: rgba(74, 134, 232, 0.46) !important;
}
.dsh-zp-soft-btn:disabled {
  opacity: 0.55 !important;
  cursor: default;
}
.dsh-zp-tag {
  transition: background-color 120ms ease, border-color 120ms ease;
}
.dsh-zp-tag:hover {
  background-color: rgba(127, 127, 127, 0.10) !important;
  border-color: rgba(127, 127, 127, 0.60) !important;
}
.dsh-zp-tag.is-selected:hover {
  background-color: #4b4b4b !important;
  border-color: #404040 !important;
}
.dsh-zp-tag.is-selected:active {
  background-color: #404040 !important;
}
.dsh-zp-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  /* 无底色、无描边：只靠渐变竖条与文字色点缀，避免标题变成色块。 */
  padding: 2px 0;
  font-weight: 700;
  letter-spacing: 0.1px;
  /* 老浏览器 / 宿主未声明 color-scheme 时退回主题文字色，仍可读。 */
  color: var(--dsw-alias-label-primary, CanvasText);
  color: light-dark(#2456ad, #aacaff);
}
.dsh-zp-title-bar {
  flex: 0 0 auto;
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background-image: ${TITLE_BAR_GRADIENT};
}
.dsh-zp-title-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`.trim()

const THEME_STYLE_ID = 'dsh-plugin-zotero-theme'

/** 幂等：插件重载 / 多会话只留一份 <style>。 */
export function installTheme(): void {
  if (typeof document === 'undefined' || document.getElementById(THEME_STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = THEME_STYLE_ID
  style.textContent = THEME_CSS
  document.head.appendChild(style)
}
