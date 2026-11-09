/**
 * 条目类型 → 图标与本地化名称。
 *
 * Zotero 为三十余种条目类型分别提供了图标，但多数在 16px 下都是「纸页」变体；
 * 右栏宽度有限，这里按形态收敛成一组家族（描边风格与树内其它图标一致），
 * 未收录的类型兜底为文档。类型全名由 locales 的 `type.<itemType>` 文案提供。
 */

import type { ReactElement } from 'react'

import type { Translate } from './locales'

type IconFamily =
  | 'document'
  | 'book'
  | 'thesis'
  | 'report'
  | 'webpage'
  | 'dataset'
  | 'software'
  | 'legal'
  | 'media'
  | 'note'
  | 'attachment'

/** Zotero schema 的 itemType 键 → 图标家族。 */
const FAMILY: Record<string, IconFamily> = {
  // 文档：期刊 / 会议 / 报纸 / 杂志 / 百科 / 词条 / 博客 / 论坛 / 邮件 / 访谈 / 演示……
  journalArticle: 'document',
  magazineArticle: 'document',
  newspaperArticle: 'document',
  conferencePaper: 'document',
  preprint: 'document',
  manuscript: 'document',
  encyclopediaArticle: 'document',
  dictionaryEntry: 'document',
  blogPost: 'document',
  forumPost: 'document',
  letter: 'document',
  email: 'document',
  instantMessage: 'document',
  interview: 'document',
  presentation: 'document',
  document: 'document',

  book: 'book',
  bookSection: 'book',

  thesis: 'thesis',
  report: 'report',
  webpage: 'webpage',
  dataset: 'dataset',
  computerProgram: 'software',

  // 法律类：案卷 / 法规 / 法案 / 听证 / 专利 / 标准
  case: 'legal',
  statute: 'legal',
  bill: 'legal',
  hearing: 'legal',
  patent: 'legal',
  standard: 'legal',

  // 多媒体：艺术品 / 录音 / 影片 / 地图 / 播客 / 广播 / 视频
  artwork: 'media',
  audioRecording: 'media',
  film: 'media',
  map: 'media',
  podcast: 'media',
  radioBroadcast: 'media',
  tvBroadcast: 'media',
  videoRecording: 'media',

  note: 'note',
  attachment: 'attachment',
}

/** 每个家族一条 path（16×16 viewBox，描边绘制）。 */
const PATH: Record<IconFamily, string> = {
  document: 'M4.5 2.5h5l3 3v8h-8z M9.5 2.5v3h3 M6.5 8h4.5 M6.5 10.5h4.5',
  book: 'M8 4.3c-1.4-1-3-1.4-4.7-1.2v8.8c1.7-.2 3.3.2 4.7 1.2 1.4-1 3-1.4 4.7-1.2V3.1C11 2.9 9.4 3.3 8 4.3z M8 4.3v8.8',
  thesis: 'M8 3.2 13.4 5.9 8 8.6 2.6 5.9z M4.6 7.1v3.1c0 1.3 1.5 2.3 3.4 2.3s3.4-1 3.4-2.3V7.1 M13.4 5.9v3.2',
  report: 'M5 2.5h5l3 3v8H5z M10 2.5v3h3 M7 8h4 M7 10.5h4 M2.6 5.2v1 M2.6 8v1 M2.6 10.8v1',
  webpage: 'M2.8 4h10.4v8H2.8z M2.8 6.3h10.4 M4.2 5.15h.5 M5.6 5.15h.5',
  dataset: 'M3.5 4.2c0-.8 2-1.5 4.5-1.5s4.5.7 4.5 1.5-2 1.5-4.5 1.5S3.5 5 3.5 4.2z M3.5 4.2v7.6c0 .8 2 1.5 4.5 1.5s4.5-.7 4.5-1.5V4.2 M3.5 8c0 .8 2 1.5 4.5 1.5s4.5-.7 4.5-1.5',
  software: 'M6.1 5.4 3.6 8l2.5 2.6 M9.9 5.4 12.4 8l-2.5 2.6 M8.8 4.4 7.2 11.6',
  legal: 'M6.2 4.4 8.4 2.2 11.8 5.6 9.6 7.8z M7.6 6.9 3.8 10.7 M3 12.6h5',
  media: 'M3 4.6h10v6.8H3z M6.9 6.4 9.6 8 6.9 9.6z',
  note: 'M4.5 3h7v10h-7z M4.5 5.6h7 M6.6 7.9h3.3 M6.6 9.9h3.3',
  attachment: 'M9.6 3.5 4.9 8.2a1.9 1.9 0 0 0 2.7 2.7l4.7-4.7a3 3 0 0 0-4.2-4.2L3.4 6.7a4.2 4.2 0 0 0 5.9 5.9l1.2-1.2',
}

/** 已读图标的粉色：不用主题蓝，蓝色容易被读成「未读消息」徽标。 */
const READ_ICON_COLOR = '#e8798d'

/** 未读图标用 Zotero 蓝：列表行里比中性灰更醒目，也与树、按钮同一支蓝。 */
const ICON_COLOR = '#4a86e8'

/**
 * 条目类型图标；未知类型显示文档图标，已读条目整体转粉色。
 * 无底衬，默认 22px（比 Zotero 原生 16px 放大，列表里才看得清）。
 */
export function ItemTypeIcon({
  itemType,
  read = false,
  size = 22,
}: {
  itemType: string
  read?: boolean
  size?: number
}): ReactElement {
  const family = FAMILY[itemType] ?? 'document'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinejoin="round"
      strokeLinecap="round"
      style={{ opacity: read ? 0.95 : 0.9, color: read ? READ_ICON_COLOR : ICON_COLOR }}
      aria-hidden
    >
      <path d={PATH[family]} />
    </svg>
  )
}

/** 条目类型的本地化名称；未收录的类型回退为原始 schema 键。 */
export function itemTypeLabel(t: Translate, itemType: string): string {
  if (itemType === '') return ''
  const key = `type.${itemType}`
  const label = t(key)
  return label === '' || label === key ? itemType : label
}
