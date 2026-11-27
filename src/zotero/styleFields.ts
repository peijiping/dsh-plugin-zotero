/**
 * Zotero Style 结果里已知字段的并集。
 *
 * 现在只用于判断 `zoterostyle.json` 的结构有没有整体变化（避免字段名改版后
 * 静默变成「查不到」）。显示范围与短标签已改由 `publicationTags.ts` 按用户的
 * Fields / Map 配置决定，这里不再承担展示白名单。
 */
export interface StyleExtraTag {
  /** Style 缓存里的原始字段名，便于排查。 */
  field: string
  /** 我们自己的短标签，不读用户的 Map 配置。 */
  label: string
  /** 展示值；布尔型收录标记为空串。 */
  value: string
}

/**
 * 字段名 → 短标签。顺序即显示顺序，尽量贴 Style 列的默认别名
 * （`SCIIF=IF` / `SCI基础版=中科院` / `北大中文核心=北核` 已由核心六枚承担）。
 */
const FIELD_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['sciif5', 'IF(5)'],
  ['sciUp', 'SCI升级版'],
  ['sciUpSmall', 'SCI小类'],
  ['sciUpTop', 'SCI Top'],
  ['sciwarn', '预警'],
  ['xrSmall', '新锐小类'],
  ['esci', 'ESCI'],
  ['ssci', 'SSCI'],
  ['ahci', 'A&HCI'],
  ['ajg', 'AJG'],
  ['jci', 'JCI'],
  ['esi', 'ESI'],
  ['ccf', 'CCF'],
  ['cssci', 'CSSCI'],
  ['cscd', 'CSCD'],
  ['ft50', 'FT50'],
  ['utd24', 'UTD24'],
  ['pku', '北核'],
  ['zhongguokejihexin', '科核'],
  ['xju', 'XJU'],
  ['cju', 'YangtzeU'],
  ['cug', 'CUG'],
  ['scu', 'SCU'],
  ['zju', 'ZJU'],
  ['nju', 'NJU'],
  ['sjtu', 'SJTU'],
  ['fdu', 'FDU'],
  ['hhu', 'HHU'],
  ['swjtu', 'SWJTU'],
  ['swufe', 'SWUFE'],
  ['uibe', 'UIBE'],
  ['cqu', 'CQU'],
  ['cpu', 'CPU'],
  ['ruc', 'RUC'],
  ['xmu', 'XMU'],
  ['xdu', 'XDU'],
  ['fms', 'FMS'],
  ['sdufe', 'SDUFE'],
  ['cufe', 'CUFE'],
  ['复合影响因子', '复合IF'],
  ['综合影响因子', '综合IF'],
]

/** 已由核心六枚（IF / SCI / 中科院 / EI检索 / 北核 / 科核）画出的字段不重复带出。 */
const CORE_FIELDS = new Set([
  'sciif', 'sci', 'sciBase', 'sciUp', 'xr', 'xrTop',
  'eii', 'pku', 'zhongguokejihexin',
])

/** 收录标记类字段只有「有没有」，Style 也只画一枚标签、不画值。 */
const FLAG_FIELDS = new Set([
  'pku', 'zhongguokejihexin', 'ft50', 'utd24', 'xmu', 'sciwarn',
])

/** Style 已知字段并集，供 journal-tags 判断文件结构是否整体变化。 */
export const KNOWN_STYLE_FIELDS: ReadonlySet<string> = new Set([
  ...FIELD_LABELS.map(([field]) => field),
  ...CORE_FIELDS,
  'sciUpSmall', 'sciUpTop', 'xrSmall', 'esci', 'ssci', 'ahci', 'ajg',
  'jci', 'esi', 'ccf', 'cssci', 'cscd', 'scu', 'xju', 'cju', 'cug', 'zju',
  'nju', 'sjtu', 'fdu', 'hhu', 'swjtu', 'swufe', 'uibe', 'cqu', 'cpu',
  'ruc', 'xdu', 'fms', 'sdufe', 'cufe', '复合影响因子', '综合影响因子',
])

function clean(raw: unknown): string {
  if (typeof raw === 'number') return String(raw)
  if (typeof raw !== 'string') return ''
  const value = raw.trim().replace(/[。.；;、\s]+$/u, '')
  return value === '' || value.length > 40 ? '' : value
}

/** Style 自己会缩短的两个 ZJU 值，跟它那列保持一致。 */
function displayValue(field: string, raw: string): string {
  if (field === 'zju') {
    if (raw === '国内核心期刊') return '国内核心'
    if (raw === '国内一级学术期刊') return '国内一级'
  }
  return raw
}

/**
 * 从 Style 的 `rank` 里取核心六枚之外的全部标签。
 *
 * 空值跳过；未知字段忽略（宁可漏，也不把备注当档次）；不做模糊匹配。
 */
export function styleExtraTags(raw: unknown): StyleExtraTag[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rank = raw as Record<string, unknown>
  const out: StyleExtraTag[] = []
  for (const [field, label] of FIELD_LABELS) {
    if (CORE_FIELDS.has(field)) continue
    const value = clean(rank[field])
    if (value === '') continue
    out.push({ field, label, value: FLAG_FIELDS.has(field) ? '' : displayValue(field, value) })
  }
  return out
}
