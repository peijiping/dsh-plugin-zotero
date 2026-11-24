/**
 * 构造「去外部站点查这本刊」的链接。纯函数，不发请求、不读文件。
 *
 * 为什么是跳转而不是内嵌查询：影响因子（Clarivate JCR）与中科院分区表都是
 * 商业授权数据，没有可随插件分发的公开接口。让用户在自己的浏览器里看，是
 * 唯一既不侵权、也不用承担数据错误责任的做法。
 *
 * 为什么留四家而不是一家：它们提供的东西**不重叠**，少一个就少一类能力。
 *
 * - easyScholar —— 指标主入口，覆盖 IF / JCR / 中科院分区 / CCF / 北大核心 /
 *   CSSCI / CSCD / 18 所高校目录，覆盖面最广（也是 Green Frog 的数据源）。
 * - WoS MJL —— Clarivate 官方、免费免登录，唯一能权威核验「这本刊现在是否仍
 *   被 SCIE/SSCI 收录、是否被剔除、是否 On-Hold」的地方。中科院分区停更、IF
 *   多为二手转抄之后，这条核验是投稿避雷的最后一道关。
 * - LetPub —— 唯一给审稿周期、录用比例、自引率、网友投稿经验的站，投稿决策
 *   用的，不是查指标的。
 * - Scimago —— 唯一免费提供 SJR 与 CiteScore（Scopus 口径，与 JCR 不同）。
 *
 * 为什么不做「按期刊智能选站」：判断「这本刊是不是 SCI 收录 / 是不是中文核心」
 * 本身就要外部数据 —— 那又回到引入外部数据的老路。插件只按手里有的标识符
 * 降级（ISSN 优先、刊名兜底），站点选择权交给用户。
 */

export interface JournalLink {
  /** 稳定标识，用于 React key。 */
  id: 'wos' | 'letpub' | 'scimago'
  label: string
  /**
   * 用途说明的文案 key。
   *
   * 只写站名不够：四个站都能「查期刊」，但查的是不同的东西。不说明用途，
   * 用户会以为点哪个都一样。
   */
  hintKey: string
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
  // 真正的校验位算法（mod 11）不在这里做：用户库里存错的 ISSN 仍是唯一线索，
  // 直接丢掉反而更没用。
  return `${digits.slice(0, 4)}-${digits.slice(4)}`
}

/**
 * 生成外部查询入口。返回顺序即 UI 顺序：收录核验 → 投稿参考 → 另一口径。
 *
 * **不包含 easyScholar**：它有官方开放接口，指标直接在面板里查、就地显示
 * （见 `easyscholar.ts` 与 `InfoPanel` 的「查询期刊等级」），再给一个只能落到
 * 它首页的链接是纯噪音。另外三家没有可用接口，只能跳转。
 *
 * 刊名与缩写都为空时不返回任何入口 —— 书、笔记、学位论文这类没有「期刊」
 * 概念的条目不该出现这一行。
 */
export function journalLinks(input: JournalLinkInput): JournalLink[] {
  const issn = normalizeIssn(input.issn)
  const name = input.publicationTitle.trim() !== ''
    ? input.publicationTitle.trim()
    : input.journalAbbreviation.trim()

  if (issn === '' && name === '') return []

  const links: JournalLink[] = []

  // WoS Master Journal List 只支持 ISSN 检索，没有 ISSN 就没法定位。
  if (issn !== '') {
    links.push({
      id: 'wos',
      label: 'WoS MJL',
      hintKey: 'detail.site.wos',
      url: `https://mjl.clarivate.com/search-results?issn=${encodeURIComponent(issn)}`,
    })
  }

  const letpubQuery = issn !== ''
    ? `searchissn=${encodeURIComponent(issn)}`
    : `searchname=${encodeURIComponent(name)}`
  links.push({
    id: 'letpub',
    label: 'LetPub',
    hintKey: 'detail.site.letpub',
    url: `https://www.letpub.com.cn/index.php?page=journalapp&view=search&${letpubQuery}`,
  })

  const scimagoQuery = issn !== '' ? issn : name
  links.push({
    id: 'scimago',
    label: 'Scimago',
    hintKey: 'detail.site.scimago',
    url: `https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(scimagoQuery)}`,
  })

  return links
}
