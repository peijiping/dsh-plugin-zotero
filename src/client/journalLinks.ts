/**
 * 构造「去 easyScholar 查这本刊」的链接。纯函数，不发请求、不读文件。
 *
 * 为什么只留 easyScholar 一家：它是国内这个场景下覆盖面最广的期刊等级服务
 * （JCR、中科院分区、CCF、北大核心、CSSCI、CSCD 等几十个数据集，10 万+ 用户），
 * 也是生态里用得最多的 Zotero 插件 Green Frog 的数据源。与其给三个口径不同的
 * 站点让用户自己判断，不如收敛到一个入口。
 *
 * 为什么不做内嵌查询：影响因子（Clarivate JCR）与中科院分区表都是商业授权
 * 数据，没有公开 API 可以随插件分发。让用户在自己的浏览器里看，是唯一既不
 * 侵权、也不用承担数据错误责任的做法。
 *
 * 一个必须承认的限制：easyScholar 是单页应用，实测 `/query?name=` 与
 * `/journal/search?name=` 都返回同一个入口页面，无法用 URL 参数直达某本刊的
 * 查询结果。所以这里只打开首页，刊名靠用户自己贴进去 —— 刻意不带参数，
 * 免得让用户误以为已经查好了。
 */

export interface JournalLink {
  /** 稳定标识，用于 React key。 */
  id: 'easyscholar'
  label: string
  url: string
}

export interface JournalLinkInput {
  publicationTitle: string
  journalAbbreviation: string
}

const EASYSCHOLAR_HOME = 'https://www.easyscholar.cc/'

/**
 * 生成外部查询入口。刊名与缩写都为空时返回空数组 —— 书、笔记、学位论文这类
 * 没有「期刊」概念的条目不该出现这个入口。
 */
export function journalLinks(input: JournalLinkInput): JournalLink[] {
  const name = input.publicationTitle.trim() !== ''
    ? input.publicationTitle.trim()
    : input.journalAbbreviation.trim()
  if (name === '') return []
  return [{ id: 'easyscholar', label: 'easyScholar', url: EASYSCHOLAR_HOME }]
}
