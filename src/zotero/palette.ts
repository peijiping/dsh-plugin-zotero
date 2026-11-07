/**
 * Zotero 阅读器的标注调色板。
 *
 * 这七个值是从本机文库里枚举出来的真实 `annotationColor`，不是照着肉眼配的近似色：
 * 面板只能提供这几种，Host 也只接受这几种，写进库的颜色因此和 Zotero 自己建的
 * 标注完全同构（将来 Zotero 若加色，取一次真实值补进来即可）。
 *
 * 面板（色块）与 Host（写入校验）共用这一份：两边各写一遍，迟早变成「面板能点、
 * 库里写不进」。
 */

export const ANNOTATION_COLORS = [
  '#ffd400',
  '#ff6666',
  '#5fb236',
  '#2ea8e5',
  '#a28ae5',
  '#e56eee',
  '#f19837',
] as const

/**
 * 是否是调色板里的颜色；大小写按 Zotero 的存储习惯归一到小写再比。
 *
 * 故意不写成类型守卫（`value is string`）：调用方手里本来就有个 `string`，
 * 守卫会把「不是」那一支窄化成 `never`，错误文案里的原文反而取不出来。
 */
export function isPaletteColor(value: unknown): boolean {
  return (
    typeof value === 'string'
    && (ANNOTATION_COLORS as readonly string[]).includes(value.trim().toLowerCase())
  )
}
