/**
 * 条目行右键菜单的纯逻辑：按当前选中条目数决定有哪几项。
 *
 * 单独拆出来是为了能在 Node 里跑场景验收（local/item-context-menu-scenarios.ts），
 * 不把 React / DOM 拖进测试。图标只给名字，由 ItemList 映射成 SVG。
 */

import { isBibliographicItem, MAX_BIBLIOGRAPHY_ITEMS } from '../zotero/bibliography'
import type { ZoteroItemSummary } from '../zotero/types'
import { bibliographyStyles } from './bibliography'
import type { Translate } from './locales'

export type ItemMenuIconName = 'chat' | 'copy' | 'review' | 'text' | 'numbers' | 'digest'

export interface ItemMenuEntry {
  id: string
  label: string
  icon: ItemMenuIconName
  disabled?: boolean
  submenu?: { id: string; label: string; icon: ItemMenuIconName }[]
}

/** 菜单固定动作的 id；参考文献样式 id 走 `isBibliographyStyle` 识别。 */
export const ITEM_MENU_INSERT = 'insert-item'
export const ITEM_MENU_COPY = 'copy-bibliography'
/** 汇总笔记与标注：单选、多选同一项，文案不带篇数。 */
export const ITEM_MENU_DIGEST = 'digest-annotations'
export const ITEM_MENU_REVIEW = 'review-items'

/**
 * 单选：加入对话 + 复制参考文献 + 汇总笔记与标注；多选再补一项综述对比。
 *
 * 复制对整批生效：混选了笔记 / 附件时照常给入口，由后端跳过并在结果里说明
 * （原来多选工具栏就是这么做的）；超过上限才置灰，避免点了没反应。
 *
 * 汇总项的单选 / 多选文案相同、**不带篇数**：篇数在弹层第一屏就有，菜单里那点
 * 字数省下来让四项排得齐；没有会话上下文时置灰而不是消失（消失会让人以为
 * 这个功能只对多选开放）。
 */
export function itemMenuEntries(
  t: Translate,
  items: readonly ZoteroItemSummary[],
  options: { copying: boolean; canReview: boolean; canDigest: boolean },
): ItemMenuEntry[] {
  const entries: ItemMenuEntry[] = [{
    id: ITEM_MENU_INSERT,
    label: t('action.insertItem'),
    icon: 'chat',
  }]

  if (items.some(({ itemType }) => isBibliographicItem(itemType))) {
    const tooMany = items.length > MAX_BIBLIOGRAPHY_ITEMS
    entries.push({
      id: ITEM_MENU_COPY,
      label: t('bibliography.copy'),
      icon: 'copy',
      disabled: options.copying || tooMany,
      submenu: tooMany ? undefined : bibliographyStyles(t).map(({ id, label }) => ({
        id,
        label,
        icon: id === 'apa' ? 'text' : 'numbers',
      })),
    })
  }

  // 单条独立笔记不给汇总：它没有标注，汇总出来的只有它自己的正文，
  // 与「把条目加入对话」是同一个动作（详情页的插入菜单也是这么处理的）。
  const noteOnly = items.length === 1 && items[0]?.itemType === 'note'
  if (items.length > 0 && !noteOnly) {
    entries.push({
      id: ITEM_MENU_DIGEST,
      label: t('digest.action'),
      icon: 'digest',
      disabled: !options.canDigest,
    })
  }

  if (items.length > 1 && options.canReview) {
    entries.push({
      id: ITEM_MENU_REVIEW,
      label: t('review.action'),
      icon: 'review',
    })
  }
  return entries
}
