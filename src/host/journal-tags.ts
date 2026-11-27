/**
 * 期刊标签归一层：三个数据源按优先级串成一条查询链。
 *
 * ① Zotero Style 算好的结果（`zoterostyle.json`）—— 只读取结果数据，不碰它的配置；
 * ② 本插件自己的缓存（`journal-ranks.json`）—— 上次 API 查询的结果；
 * ③ easyScholar API —— 前两处都没有时才查，查到后写回②。
 *
 * 边界：不写回 Zotero 条目、不读第三方插件的私钥、不复制别人的设置界面。
 * 中科院分区统一取基础版 `sciBase`（Style 列显示的就是它），与升级版差一档时
 * 以用户眼前那列为准。
 */

import { ZoteroError } from '../zotero/client.js'
import { lookupCachedTags, lookupStyleTags, rankToTags, rememberRank } from '../zotero/journal-tags.js'
import type { JournalRank, JournalRankOutcome, JournalTagsOutcome } from '../zotero/types.js'

export type { JournalRank, JournalRankOutcome, JournalTagsOutcome } from '../zotero/types.js'

type Ranker = (input: { publicationName: string }) => Promise<JournalRankOutcome>

export interface JournalTagsInput {
  publicationName: string
}

/**
 * 创建归一的查询器，由入口注入路由。
 *
 * `journalRank` 缺省时只查前两处；这让「没配密钥」的用户仍能复用 Style / 缓存，
 * 而不是整块功能不可用。
 */
export function createJournalTagsResolver(journalRank?: Ranker): (
  input: JournalTagsInput,
) => Promise<JournalTagsOutcome> {
  return async (input): Promise<JournalTagsOutcome> => {
    const name = input.publicationName.trim()
    if (name === '') throw new ZoteroError('bad_request', '缺少期刊名')
    if (name.length > 300) throw new ZoteroError('bad_request', 'publicationName 过长')

    const style = await lookupStyleTags(name)
    if (style !== null) return { status: 'ok', tags: style }

    const cached = await lookupCachedTags(name)
    if (cached !== null) return { status: 'ok', tags: cached }

    if (journalRank === undefined) return { status: 'no_key' }
    const outcome = await journalRank({ publicationName: name })
    if (outcome.status !== 'ok') return outcome

    const rank: JournalRank = outcome.rank
    await rememberRank(name, rank)
    return { status: 'ok', tags: rankToTags(rank, 'api') }
  }
}
