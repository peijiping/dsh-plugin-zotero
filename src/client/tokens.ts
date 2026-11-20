/**
 * token 数量粗估。
 *
 * 用途只有一个：在插入前告诉用户「这段正文大概要占多少上下文」。**不是**给计费
 * 或硬性预算用的，所以按字符类别估就够了，不引 tokenizer（几十 KB 的 BPE 词表
 * 塞进 client bundle 不划算，而且各家模型的分词器并不一样）。
 *
 * 系数取自 DeepSeek / GPT 系 BPE 的实测均值：英文与数字约 3.5–4 字符一个 token，
 * 汉字约 1.5 字符一个 token（全角标点接近汉字）。中英混排落在两者之间，按字符
 * 分类线性叠加即可，误差通常在 ±15% 以内。
 */

/** 汉字 / 假名 / 谚文 / 全角标点：一个字符的 token 成本高一个量级。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/gu

/** 一个 CJK 字符平均占多少 token（1/0.65）。 */
const CHARS_PER_TOKEN_CJK = 1.55

/** 一个拉丁字符平均占多少 token（1/0.27）。 */
const CHARS_PER_TOKEN_LATIN = 3.7

/**
 * 估算 token 数。
 *
 * `replace` 数剩余长度而不是 `match` 出数组：20 万字符的正文能匹配出十几万个
 * 元素，逐个建对象比多分配一个字符串贵得多，而这个函数在浮层里每次改范围都会跑。
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  const cjk = text.length - text.replace(CJK, '').length
  const latin = text.length - cjk
  return Math.round(cjk / CHARS_PER_TOKEN_CJK + latin / CHARS_PER_TOKEN_LATIN)
}
