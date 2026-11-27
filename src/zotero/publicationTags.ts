/**
 * 按 Zotero Style「期刊标签」列的有效配置生成胶囊。
 *
 * 用户拍板改成「Zotero 显示什么，我们就显示什么」：有效配置 = 本机 profile
 * `prefs.js` 的 `user_pref` 覆盖 + Style 插件包自带 `prefs.js` 的默认值。这里
 * 只读 Fields / Map / source / gardenFields 四项，不读密钥、不改第三方文件。
 *
 * 渲染口径与 Style 一致：按 Fields 顺序取非空值 → 字段自己的显示名 → 显示名和
 * 值分别过 Map → 同一枚内去重 → 拼成一枚胶囊。Map 只改名，不增加字段。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parsePrefValues } from './prefs.js'
import { profileDirs } from './profile.js'
import type { JournalRank, JournalTagEntry } from './types.js'

const PREFIX = 'extensions.zotero.zoterostyle.publicationTagsColumn.'

/** Style 插件包 prefs.js 里的默认值（本机 11-27 实测，用户未改过时即此值）。 */
export const DEFAULT_PUBLICATION_TAGS = {
  source: 'easyscholar',
  fields: 'sciif, sci, utd24, ajg, sciBase, ssci, pku, 复合影响因子',
  gardenFields: 'IF, JCI, JCR, 中科院 2025, CiteScore, 5YIF, 新锐',
  map: '北大中文核心=北核, SCIIF=IF, SCIIF(5)=IF(5), SCI基础版=中科院',
} as const

export interface PublicationTagsPrefs {
  source: string
  fields: string[]
  map: Array<[string | RegExp, string]>
}

type MapRule = [string | RegExp, string]

function parseMap(text: string): MapRule[] {
  const rules: MapRule[] = []
  for (const piece of text.split(/[,;]/u)) {
    const raw = piece.trim()
    if (raw === '') continue
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    const left = raw.slice(0, eq).trim()
    const right = raw.slice(eq + 1).trim()
    if (left === '' || right === '') continue
    const regex = /^\/(.+)\/([dgimsuvy]*)$/u.exec(left)
    if (regex !== null) {
      try {
        rules.push([new RegExp(regex[1] ?? '', regex[2] ?? ''), right])
        continue
      } catch {
        // 坏正则当没这条规则：Zotero 侧也会在 getMapString 里吞掉异常。
      }
    }
    rules.push([left, right])
  }
  return rules
}

/** 从 prefs.js 文本解析出期刊标签列配置；缺项一律用默认值。 */
export function parsePublicationTagsPrefs(text: string): PublicationTagsPrefs {
  const values = parsePrefValues(text)
  const pick = (key: string, fallback: string): string => {
    const value = values.get(PREFIX + key)
    return typeof value === 'string' && value.trim() !== '' ? value : fallback
  }
  const source = pick('source', DEFAULT_PUBLICATION_TAGS.source)
  const fieldText = source === 'garden'
    ? pick('gardenFields', DEFAULT_PUBLICATION_TAGS.gardenFields)
    : pick('fields', DEFAULT_PUBLICATION_TAGS.fields)
  return {
    source,
    fields: fieldText.split(/,\s*/u).map((field) => field.trim()).filter((field) => field !== ''),
    map: parseMap(pick('map', DEFAULT_PUBLICATION_TAGS.map)),
  }
}

let cached: { stamp: string; prefs: PublicationTagsPrefs } | null = null

/** 供测试在改过 prefs.js 后强制重读。 */
export function clearPublicationTagsPrefsCache(): void {
  cached = null
}

/** 读本机有效的 Style 标签列配置；profile 找不到时给默认值。 */
export async function readPublicationTagsPrefs(): Promise<PublicationTagsPrefs> {
  for (const dir of await profileDirs()) {
    const file = join(dir, 'prefs.js')
    let info
    try {
      info = await stat(file)
    } catch {
      continue
    }
    const stamp = `${file}:${info.mtimeMs}:${info.size}`
    if (cached !== null && cached.stamp === stamp) return cached.prefs
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const prefs = parsePublicationTagsPrefs(text)
    cached = { stamp, prefs }
    return prefs
  }
  return parsePublicationTagsPrefs('')
}

function applyMap(value: string, rules: MapRule[]): string {
  let out = value
  for (const [from, to] of rules) {
    if (typeof from === 'string') {
      if (from === out) out = to
      continue
    }
    from.lastIndex = 0
    if (from.test(out)) {
      out = out.replace(from, to)
      break
    }
  }
  return out
}

interface FieldInfo {
  key: string
  value: string
}

/**
 * Style 内建的「字段 → 显示名」。只覆盖真正改写过的字段；没列到的按 custom
 * 处理（字段名本身即显示名），与 Zotero 对未知字段的行为一致。
 */
const EASY_FIELDS: Readonly<Record<string, string>> = {
  sci: 'SCI',
  sciif: 'SCIIF',
  sciif5: 'SCIIF(5)',
  sciBase: 'SCI基础版',
  sciUp: 'SCI升级版',
  ssci: 'SSCI',
  nju: 'NJU',
  ccf: 'CCF',
  ajg: 'AJG',
  cqu: 'CQU',
  cscd: 'CSCD',
  cufe: 'CUFE',
  cug: 'CUG',
  fdu: 'FDU',
  hhu: 'HHU',
  ruc: 'RUC',
  jci: 'JCI',
  sdufe: 'SDUFE',
  sjtu: 'SJTU',
  swjtu: 'SWJTU',
  uibe: 'UIBE',
  xdu: 'XDU',
  fms: 'FMS',
  scu: 'SCU',
  sciwarn: 'SCIWARN',
  zju: 'ZJU',
  cju: 'YangtzeU',
  CPU: 'CPU',
}

/** 这些字段只要存在就是一枚标签，值不进胶囊。 */
const EASY_FLAGS: Readonly<Record<string, string>> = {
  eii: 'EI检索',
  ahci: 'A&HCI 检索',
  pku: '北大中文核心',
}

function customInfo(field: string, raw: string): FieldInfo {
  const value = raw.replace('类', '').replace(/\[rank=\d+\]/u, '')
  return { key: field, value: value.toUpperCase() === field.toUpperCase() ? '' : value }
}

function easyFieldInfo(field: string, raw: string): FieldInfo {
  const flag = EASY_FLAGS[field]
  if (flag !== undefined) return { key: flag, value: '' }
  const key = EASY_FIELDS[field]
  if (key !== undefined) return { key, value: raw }
  switch (field) {
    case 'cssci':
      return { key: raw, value: '' }
    case 'xmu':
      return raw === 'XMU一类' ? { key: raw, value: '' } : { key: '', value: '' }
    case 'zhongguokejihexin':
      return raw === '中国科技核心期刊' ? { key: raw, value: '' } : { key: '', value: '' }
    case 'ft50':
      return raw === 'FT50' ? { key: 'FT50', value: '' } : { key: '', value: '' }
    case 'utd24':
      return raw === 'UTD24' ? { key: 'UTD24', value: '' } : { key: '', value: '' }
    default:
      return customInfo(field, raw)
  }
}

function gardenFieldInfo(field: string, raw: string): FieldInfo {
  if (field === 'WOS 子集') return { key: 'SCIE', value: '' }
  if (field === 'JCR') return { key: 'SCI', value: raw }
  if (field === 'WOS 自引率') return { key: '自引率', value: raw }
  return { key: field, value: raw }
}

/** 从一份 Style rank 生成与 Zotero 列同口径的胶囊（顺序、改名、值都一致）。 */
export function publicationTagEntries(raw: unknown, prefs: PublicationTagsPrefs): JournalTagEntry[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rank = raw as Record<string, unknown>
  const out: JournalTagEntry[] = []
  for (const field of prefs.fields) {
    const found = rank[field]
    if (found === undefined || found === null || found === '') continue
    const text = typeof found === 'string' ? found : String(found)
    const info = prefs.source === 'garden'
      ? gardenFieldInfo(field, text)
      : easyFieldInfo(field, text)
    if (info.key === '' && info.value === '') continue
    const key = applyMap(info.key, prefs.map)
    const value = applyMap(info.value, prefs.map)
    // Style 在单枚内对显示名与值做 Set 去重，跨字段不去重。
    const parts = [...new Set([key, value].filter((part) => part !== ''))]
    if (parts.length === 0) continue
    out.push({ label: parts[0] ?? '', value: parts.slice(1).join(' ') })
  }
  return out
}

/** API / 本地缓存的结构化结果没有原始 rank，按同一组键反推一份。 */
export function journalRankToRaw(rank: JournalRank): Record<string, string> {
  const raw: Record<string, string> = {}
  const put = (field: string, value: string): void => {
    if (value !== '') raw[field] = value
  }
  put('sciif', rank.impactFactor)
  put('sci', rank.jcrQuartile)
  put('sciif5', rank.fiveYearIf)
  put('sciBase', rank.casBase)
  put('sciUp', rank.casUp)
  put('xr', rank.xr)
  put('xrTop', rank.xrTop)
  put('sciwarn', rank.casWarn)
  put('eii', rank.ei)
  put('pku', rank.pku)
  put('zhongguokejihexin', rank.zhongguokejihexin)
  put('ccf', rank.ccf)
  put('cssci', rank.cssci)
  return raw
}
