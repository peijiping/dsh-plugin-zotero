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
  '分区': 'casQuartile',
  'sciup': 'casQuartile',
  'scibase': 'casQuartile',
  'citations': 'citations',
  'citation': 'citations',
  'citation count': 'citations',
  '被引': 'citations',
  '被引次数': 'citations',
}

/** 单行 `键: 值`；中英文冒号都认，键长上限防止把整段话当键。 */
const LINE = /^\s*([^:：]{1,40})[:：]\s*(.+?)\s*$/u

/** 影响因子：纯数值。`5.2` 认，`约 5` / `5 左右` 不认。 */
const IF_VALUE = /^\d{1,3}(?:\.\d{1,3})?$/u

/** JCR 分区：`Q1`–`Q4`，允许小写。 */
const QUARTILE_VALUE = /^[Qq]([1-4])$/u

/** 中科院分区：`1区`–`4区`，也接受纯数字 1–4（便于 `CAS: 2` 这种写法）。 */
const CAS_VALUE = /^(?:([1-4])\s*区|([1-4]))$/u

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
      const match = CAS_VALUE.exec(value)
      if (match === null) return ''
      return `${match[1] ?? match[2]}区`
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
  // 通常是他自己核对过的，后面追加的多半是插件批量刷的。
  for (const line of extra.split(/\r?\n/u)) {
    const match = LINE.exec(line)
    if (match === null) continue
    const field = KEY_MAP[normalizeKey(match[1])]
    if (field === undefined || found[field] !== '') continue
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
