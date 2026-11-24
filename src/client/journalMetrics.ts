/**
 * 从 Zotero 条目已有的文本里**读**期刊指标，不查询、不推断、不回写。
 *
 * 为什么只能读：Zotero 官方 schema 没有任何评价性字段（影响因子、JCR 分区、
 * 中科院分区、被引次数）。Clarivate 的 JCR 与中科院分区表都是商业授权数据，
 * 既没有公开 API，也不允许随插件再分发 —— 所以本插件不内置任何指标表，
 * 也不发网络请求去取。
 *
 * 唯一的合法来源是用户自己库里**已经存在**的内容：
 *
 * - `extra` 的 `键: 值` 行。Zotero Citation Counts Manager 的 README 写明
 *   「Zotero doesn't have any special field for the number of citations,
 *   so they are stored in the Extra field」，社区插件普遍照这个路子写。
 * - `tags`。有些工作流把分区做成标签（`Q1` / `2区`）。
 *
 * 设计取向：**宁可漏识别，也不误识别**。值必须过格式校验才算数 —— 面板上多
 * 一行错的「影响因子 5.2」比少一行严重得多，用户会拿它去投稿和填表。
 */

import type { JournalRank } from './api'

/** 解析出的指标。所有值都是原样字符串：用户写了什么就显示什么。 */
export interface JournalMetrics {
  /** 影响因子，如 `5.2`。 */
  impactFactor: string
  /** JCR 分区，`Q1`–`Q4`。 */
  jcrQuartile: string
  /** 中科院分区，如 `2区`。 */
  casQuartile: string
  /** 被引次数，如 `128`。 */
  citations: string
}

const EMPTY: JournalMetrics = {
  impactFactor: '',
  jcrQuartile: '',
  casQuartile: '',
  citations: '',
}

/**
 * 键名 → 指标。键在比较前会归一化（小写、去首尾空白、空白折叠），
 * 所以这里只写归一化后的形态。
 *
 * `if` 这种两字母键只看整键相等，不做前缀匹配：否则 `if-issued` 之类
 * 的 CSL 变量会被误认成影响因子。
 *
 * 中文键名对齐 Green Frog（绿青蛙）写进 `extra` 的实际格式 —— 它是 Zotero
 * 生态里用得最多的期刊指标插件（下载量与 star 数都远超同类），适配它就等于
 * 覆盖了绝大多数中文用户的库。
 */
const KEY_MAP: Record<string, keyof JournalMetrics> = {
  'impact factor': 'impactFactor',
  'impactfactor': 'impactFactor',
  'if': 'impactFactor',
  'sciif': 'impactFactor',
  '影响因子': 'impactFactor',
  'jcr': 'jcrQuartile',
  'jcr quartile': 'jcrQuartile',
  'jcr分区': 'jcrQuartile',
  'quartile': 'jcrQuartile',
  'sci': 'jcrQuartile',
  'sci分区': 'jcrQuartile',
  'cas': 'casQuartile',
  'cas quartile': 'casQuartile',
  '中科院': 'casQuartile',
  '中科院分区': 'casQuartile',
  '中科院分区基础版': 'casQuartile',
  '中科院分区升级版': 'casQuartile',
  '分区': 'casQuartile',
  'sciup': 'casQuartile',
  'scibase': 'casQuartile',
  'citations': 'citations',
  'citation': 'citations',
  'citation count': 'citations',
  '被引': 'citations',
  '被引次数': 'citations',
}

/**
 * 中科院分区三个键的优先级：升级版 > 通用 > 基础版。
 *
 * 2022 年起官方只发升级版（基础版已停），所以两个键同时存在时取升级版才符合
 * 用户的预期。旧的 Green Frog 会把两版都写进 extra，先到先得会取错。
 */
const CAS_RANK: Record<string, number> = {
  '中科院分区基础版': 1,
  '中科院分区': 2,
  '中科院分区升级版': 3,
}

/** 单行 `键: 值`；中英文冒号都认，键长上限防止把整段话当键。 */
const LINE = /^\s*([^:：]{1,40})[:：]\s*(.+?)\s*$/u

/** 影响因子：纯数值。`5.2` 认，`约 5` / `5 左右` 不认。 */
const IF_VALUE = /^\d{1,3}(?:\.\d{1,3})?$/u

/** JCR 分区：`Q1`–`Q4`，允许小写。 */
const QUARTILE_VALUE = /^[Qq]([1-4])$/u

/**
 * 中科院分区。要收的写法比想象中多：
 * `2区`、`二区`（Green Frog 中文版）、`大类二区` / `小类1区`（升级版分大类小类）、
 * `2区Top`（Top 期刊标记）。
 */
const CAS_VALUE = /^(?:(?:大|小)类)?[一二三四1-4]区(?:[Tt][Oo][Pp])?$/u

/** 裸数字 `3`，补成 `3区`。 */
const CAS_BARE = /^([1-4])$/u

/** 被引次数：允许千分位逗号。 */
const COUNT_VALUE = /^\d{1,3}(?:,\d{3})*$|^\d+$/u

/** 值太长一定不是指标本身（多半是用户写了句话）。 */
const MAX_VALUE_LEN = 24

function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/** 校验并规整值；不合格返回空串。 */
function accept(field: keyof JournalMetrics, raw: string): string {
  const value = raw.trim()
  if (value === '' || value.length > MAX_VALUE_LEN) return ''
  switch (field) {
    case 'impactFactor':
      return IF_VALUE.test(value) ? value : ''
    case 'jcrQuartile': {
      const match = QUARTILE_VALUE.exec(value)
      return match === null ? '' : `Q${match[1]}`
    }
    case 'casQuartile': {
      // 空格只在中英混排时出现（`大类 二区`），去掉再判断，显示时也去掉。
      const tight = value.replace(/\s+/gu, '')
      if (CAS_VALUE.test(tight)) return tight
      const bare = CAS_BARE.exec(tight)
      return bare === null ? '' : `${bare[1]}区`
    }
    case 'citations':
      return COUNT_VALUE.test(value) ? value : ''
  }
}

/**
 * 从标签里认分区。只认整个标签就是 `Q1` 或 `2区` 的，不做子串匹配 ——
 * `Q1-投稿中` 这种工作流标签不该被当成指标。
 */
const TAG_QUARTILE = /^Q([1-4])$/iu
const TAG_CAS = /^(?:中科院)?\s*([1-4])\s*区$/u

/**
 * 解析一条文献的指标。两处输入都没有可识别内容时返回 `null`，
 * 调用方据此整块隐藏，不留「—」这种占位噪音。
 */
export function readJournalMetrics(extra: string, tags: readonly string[]): JournalMetrics | null {
  const found: JournalMetrics = { ...EMPTY }

  // 先按行扫 extra。同一指标出现多次时**先到先得**：用户在文件头写的那条
  // 通常是他自己核对过的，后面追加的多半是插件批量刷的。中科院分区是唯一
  // 例外 —— 按 CAS_RANK 取优先级最高的那档（升级版压过基础版）。
  let casRank = 0
  for (const line of extra.split(/\r?\n/u)) {
    const match = LINE.exec(line)
    if (match === null) continue
    const key = normalizeKey(match[1])
    const field = KEY_MAP[key]
    if (field === undefined) continue
    const rank = CAS_RANK[key] ?? 0
    if (rank !== 0) {
      if (rank <= casRank) continue
      const value = accept(field, match[2])
      if (value === '') continue
      found.casQuartile = value
      casRank = rank
      continue
    }
    if (found[field] !== '') continue
    found[field] = accept(field, match[2])
  }

  // tags 只补 extra 里缺的，且优先认 JCR 分区标签（`Q1` 是国际通用写法），
  // 中科院分区再兜。
  for (const tag of tags) {
    const value = tag.trim()
    if (found.jcrQuartile === '') {
      const match = TAG_QUARTILE.exec(value)
      if (match !== null) {
        found.jcrQuartile = `Q${match[1]}`
        continue
      }
    }
    if (found.casQuartile === '') {
      const match = TAG_CAS.exec(value)
      if (match !== null) found.casQuartile = `${match[1]}区`
    }
  }

  const hit = (Object.keys(found) as (keyof JournalMetrics)[]).some((key) => found[key] !== '')
  return hit ? found : null
}

/** 面板用于判断「有没有任何指标可显示」。 */
export function hasMetrics(metrics: JournalMetrics | null): metrics is JournalMetrics {
  return metrics !== null
}

/* ── 展示用的胶囊 ────────────────────────────────────────────────── */

/**
 * 一枚指标胶囊。`tagKey` 是小标签的文案 key（IF / JCR / 中科院 …），`value`
 * 是数值本身。
 *
 * 拆成两段是因为值必须裁短：接口给的是 `综合性期刊1区`、`综合性期刊1区。`
 * 这种「大类名 + 分区」的拼串，直接塞进胶囊会宽到挤行，而大类名在这里是
 * 冗余信息（胶囊前的「中科院」已经说明了是哪套体系）。
 */
export interface MetricChip {
  tagKey: string
  value: string
  /** 需要提示风险（中科院预警）。 */
  warn?: boolean
}

/**
 * 把 `综合性期刊1区。` / `大类二区` / `2区Top` 之类的值裁成 `1区` / `二区` / `2区`。
 *
 * 认不出分区形态就原样返回，不做猜测 —— 宁可显示得长一点，也不能把一个
 * 看不懂的值悄悄改成别的。
 */
export function trimCas(raw: string): string {
  const value = raw.trim().replace(/[。.；;、\s]+$/u, '')
  const match = /([1-4一二三四]\s*区)\s*(?:top)?$/iu.exec(value)
  return match === null ? value : match[1].replace(/\s+/gu, '')
}

/** 值里有没有 Top 标记（`2区Top`、`综合性期刊TOP` 两种写法都有）。 */
function hasTop(raw: string): boolean {
  return /top/iu.test(raw)
}

/** 条目 `extra` 里的指标 → 胶囊。被引次数在末尾，它不属于期刊档次而是这篇的。 */
export function extraChips(metrics: JournalMetrics): MetricChip[] {
  const chips: MetricChip[] = []
  if (metrics.impactFactor !== '') chips.push({ tagKey: 'chip.if', value: metrics.impactFactor })
  if (metrics.jcrQuartile !== '') chips.push({ tagKey: 'chip.jcr', value: metrics.jcrQuartile })
  if (metrics.casQuartile !== '') {
    chips.push({ tagKey: 'chip.cas', value: trimCas(metrics.casQuartile) })
    if (hasTop(metrics.casQuartile)) chips.push({ tagKey: 'chip.top', value: '' })
  }
  if (metrics.citations !== '') chips.push({ tagKey: 'chip.cited', value: metrics.citations })
  return chips
}

/**
 * easyScholar 远程结果 → 胶囊。
 *
 * 只取与「这刊什么档次」直接相关的项：CCF、北大核心、CSSCI 是中文语境的分类，
 * 有才显示；5 年 IF 和小类分区不单独占位（信息价值低、还挤宽度）。
 */
export function rankChips(rank: JournalRank): MetricChip[] {
  const chips: MetricChip[] = []
  if (rank.impactFactor !== '') chips.push({ tagKey: 'chip.if', value: rank.impactFactor })
  if (rank.jcrQuartile !== '') chips.push({ tagKey: 'chip.jcr', value: rank.jcrQuartile })
  if (rank.casUp !== '') {
    chips.push({ tagKey: 'chip.cas', value: trimCas(rank.casUp) })
    if (hasTop(rank.casUp) || hasTop(rank.casUpTop)) chips.push({ tagKey: 'chip.top', value: '' })
  }
  if (rank.xr !== '') {
    chips.push({ tagKey: 'chip.xr', value: trimCas(rank.xr) })
    if (hasTop(rank.xr) && !hasTop(rank.casUp)) chips.push({ tagKey: 'chip.top', value: '' })
  }
  if (rank.ccf !== '') chips.push({ tagKey: 'chip.ccf', value: rank.ccf })
  if (rank.pku !== '') chips.push({ tagKey: 'chip.pku', value: rank.pku })
  if (rank.cssci !== '') chips.push({ tagKey: 'chip.cssci', value: rank.cssci })
  // 预警放最后且带警示色：它说明的是投稿风险，不该混在档次里。
  if (rank.casWarn !== '') chips.push({ tagKey: 'chip.warn', value: rank.casWarn, warn: true })
  return chips
}
