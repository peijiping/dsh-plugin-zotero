/**
 * 复制整批条目的参考文献到剪贴板。
 *
 * 条目列表的右键菜单与分类树目录的右键菜单共用这一份：前者还要展示逐条跳过
 * 的明细，后者只在 toast 里给一句汇总，所以这里只负责取数、格式化与写剪贴板，
 * 展示交给调用方。
 */

import type { ZoteroItemSummary } from '../zotero/types'
import type { BibliographyStyle } from '../zotero/bibliography'
import { fetchBibliography } from './api'
import { formatBibliography } from './bibliography'
import { writeClipboard } from './clipboard'

export type CopyBibliographyOutcome =
  | { ok: true; count: number; skipped: ZoteroItemSummary[] }
  /** 剪贴板写入或格式化失败：调用方给通用的「复制失败」提示。 */
  | { ok: false; reason: 'clipboard' }
  /** 后端生成参考文献失败，带原始错误信息。 */
  | { ok: false; reason: 'error'; message: string }

export async function copyBibliography(
  selection: readonly ZoteroItemSummary[],
  style: BibliographyStyle,
): Promise<CopyBibliographyOutcome> {
  try {
    const result = await fetchBibliography(selection.map(({ key }) => key), style)
    const skippedKeys = new Set(result.skippedKeys)
    const skipped = selection.filter(({ key }) => skippedKeys.has(key))
    if (result.count > 0) {
      const formatted = formatBibliography(result.html)
      if (formatted.count !== result.count || formatted.text === '') {
        return { ok: false, reason: 'clipboard' }
      }
      if (!await writeClipboard(formatted.text, formatted.html)) {
        return { ok: false, reason: 'clipboard' }
      }
    }
    return { ok: true, count: result.count, skipped }
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
