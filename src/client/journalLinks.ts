/**
 * 构造「去外部站点查这本刊」的链接。纯函数，不发请求、不读文件。
 *
 * 为什么是跳转而不是内嵌查询：影响因子（Clarivate JCR）和中科院分区表都是
 * 商业授权数据，没有公开 API，也不允许随插件分发。让用户在自己的浏览器里
 * 看这些站点，是唯一既不侵权、又不用承担数据错误责任的做法。
 *
 * 为什么不按期刊智能选站：判断「这本刊是不是 SCI 收录 / 是不是中文核心」
 * 本身就要外部数据 —— 那又回到引入外部数据的老路。插件只按**手里有的标识符**
 * 降级（ISSN 优先、刊名兜底），站点选择权交给用户。
 */

export interface JournalLink {
  /** 稳定标识，用于 React key 与埋点。 */
  id: 'letpub' | 'wos' | 'scimago'
  label: string
  url: string
}

export interface JournalLinkInput {
  issn: string
  publicationTitle: string
  journalAbbreviation: string
}

/**
 * 取第一个 ISSN 并规范成 `XXXX-XXXX`。
 *
 * Zotero 的多值字段以空格分隔（`0028-0836 1432-0746`），也常见用户直接粘
 * 八位数字。两个都收；格式不合规就返回空串，让调用方回落到刊名。
 */
export function normalizeIssn(raw: string): string {
  const first = raw.split(/[\s,;，；]+/u).find((part) => part !== '')
  if (first === undefined) return ''
  const digits = first.replace(/[^0-9Xx]/gu, '').toUpperCase()
  if (digits.length !== 8) return ''
  // ISSN 首位不可能是 0 位以外的怪值，但真正的校验位算法（mod 11）不在这里做：
  // 用户库里存错的 ISSN 仍是唯一线索，直接丢掉反而更没用。
  return `${digits.slice(0, 4)}-${digits.slice(4)}`
}

/** 刊名是否含中日韩字符：中文期刊在 LetPub 里基本查不到，UI 据此给提示。 */
export function isCjkTitle(title: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(title)
}

/**
 * 生成外部查询入口。ISSN 存在时全部按 ISSN 检索 —— 刊名会缩写、会改名、
 * 会有同名刊，ISSN 才是唯一可靠的键。
 *
 * 返回顺序即 UI 顺序：LetPub 当主入口（中文、免登录、一次给全 IF + 两种分区），
 * 后两个是口径不同的一手来源，供交叉核验。
 */
export function journalLinks(input: JournalLinkInput): JournalLink[] {
  const issn = normalizeIssn(input.issn)
  const name = input.publicationTitle.trim() !== ''
    ? input.publicationTitle.trim()
    : input.journalAbbreviation.trim()

  const links: JournalLink[] = []

  if (issn !== '' || name !== '') {
    const query = issn !== ''
      ? `searchissn=${encodeURIComponent(issn)}`
      : `searchname=${encodeURIComponent(name)}`
    links.push({
      id: 'letpub',
      label: 'LetPub',
      url: `https://www.letpub.com.cn/index.php?page=journalapp&view=search&${query}`,
    })
  }

  // WoS Master Journal List 只支持按 ISSN 检索，且只回答「是否收录 / 是否被剔除」，
  // 不给影响因子数值 —— 它是核验收录状态的一手依据，不是查 IF 的地方。
  if (issn !== '') {
    links.push({
      id: 'wos',
      label: 'WoS MJL',
      url: `https://mjl.clarivate.com/search-results?issn=${encodeURIComponent(issn)}`,
    })
  }

  if (issn !== '' || name !== '') {
    const query = issn !== '' ? issn : name
    links.push({
      id: 'scimago',
      label: 'Scimago',
      url: `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(query)}`,
    })
  }

  return links
}
