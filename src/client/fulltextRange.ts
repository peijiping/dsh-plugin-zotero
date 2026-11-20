/**
 * 全文范围的表达式与「范围 → 正文字符切片」定位。
 *
 * `full:` chip 的 ref 只存定位（itemKey + 范围表达式），正文在提交那一刻由
 * `fulltextCitation` 经 `fetchItem()` 现取，再交给这里切成用户选中的那一段。
 * 五种表达式对应 choice 的四种模式（章节按文档类型分 `p:` / `o:` 两种）：
 *
 * - `all`：整篇；
 * - `c:<start>:<end>`：字符区间（start / end 为字符下标，非字节）；
 * - `h:<起标题>:<止标题>`：两个 Markdown 标题之间（正文无 `#` 时降级整篇）；
 * - `o:<start>:<end>`：文档标题锚点的字符偏移（快照/笔记/纯文本，由渲染器上报）；
 * - `p:<起页>:<止页>:<总页>:<标题列表>`：PDF 书签章节，标题用 `+` 分隔。
 *
 * 定位原则：能精确定位就精确（`c:` / `o:` 直取，`h:` / `p:` 标题匹配），
 * 匹配不到才按页码比例估算（`p:`）或降级整篇（`h:`），并且都返回 `estimated`
 * 标记——调用方据此在展开文本头部显式声明，绝不静默给出可能错位的切片。
 */

/** 章节定位结果。 */
export interface FulltextSlice {
  /** 切出的正文（原样，不改写）。 */
  text: string
  /** 给展开文本头部用的范围标注原文（如「字符 4000–12000」「章节 2 Method（P4）」）。 */
  scopeLabel: string
  /** 定位是否走了估算 / 降级；为真时头部必须带声明。 */
  estimated: boolean
  /** 是否因降级取了整篇（h: 标题没匹配到）。 */
  fallbackAll: boolean
}

/** 把字符串规整成便于比较标题的形式（去空白差异与汉字间空格）。 */
function tidyHeading(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '')
    .trim()
    .replace(/^#+[ \t]*/u, '')
}

/**
 * 在正文里找一个标题第一次出现的字符偏移。
 *
 * 逐行扫（而不是整段 `indexOf`）：标题独占一行，按行匹配可避免把正文里偶然
 * 出现的同样词句当成章节起点。返回的是**原始 content 的下标**（匹配用 tidy 后的
 * 副本，但偏移按原行累加），这样切出来的区间与原正文严格对齐。
 */
export function findHeadingOffset(content: string, title: string): number | null {
  const target = tidyHeading(title)
  if (target === '') return null
  let offset = 0
  for (const line of content.split('\n')) {
    if (tidyHeading(line) === target) return offset
    offset += line.length + 1 // +1 是 split 丢掉的换行符
  }
  return null
}

/** clamp 到正文范围；start > end 时交换，保证 slice 不会取到空段或负下标。 */
function clampRange(start: number, end: number, length: number): [number, number] {
  const a = Math.min(Math.max(0, Math.trunc(start)), length)
  const b = Math.min(Math.max(0, Math.trunc(end)), length)
  return a <= b ? [a, b] : [b, a]
}

/**
 * 解析范围表达式。
 *
 * 结构坏了抛错（与 `excerptCitation` 等一致：不是「对象已删除」，不该静默发一截
 * 乱码给模型）。数字段用 `Number` 解析并校验有限性，`NaN` / 空串都视为坏引用。
 */
/**
 * 范围表达式 = `<主体>|<编码后的人读标签>`，`|` 之后可选。
 *
 * 标签由选择器在插入时定格（如「章节 3 Method · 4 Experiments」），提交时原样
 * 回填到展开文本头部——因为字符切片本身丢了"第几节"的语义，只有标签留得住。
 * 标签用 `encodeURIComponent`，不会与主体的 `:` / `+` 分隔符冲突。
 */
interface LabeledRange {
  body: string
  label: string | null
}

function splitLabel(expr: string): LabeledRange {
  const bar = expr.indexOf('|')
  if (bar < 0) return { body: expr, label: null }
  const raw = expr.slice(bar + 1)
  let label: string | null = null
  try {
    label = decodeURIComponent(raw)
  } catch {
    label = null
  }
  return { body: expr.slice(0, bar), label }
}

export type ParsedFulltextRange =
  | { mode: 'all'; label: string | null }
  | { mode: 'chars' | 'offsets'; start: number; end: number; label: string | null }
  | { mode: 'headings'; from: string; to: string; label: string | null }
  | { mode: 'pages'; start: number; end: number; total: number; titles: string[]; label: string | null }

export function parseFulltextRange(expr: string): ParsedFulltextRange {
  const { body, label } = splitLabel(expr)
  if (body === 'all') return { mode: 'all', label }

  const parts = body.split(':')
  const head = parts[0] ?? ''

  if ((head === 'c' || head === 'o') && parts.length === 3) {
    const start = Number(parts[1])
    const end = Number(parts[2])
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`无法识别的全文范围：${expr}`)
    }
    return { mode: head === 'c' ? 'chars' : 'offsets', start, end, label }
  }

  if (head === 'h' && parts.length === 3) {
    return { mode: 'headings', from: decodeURIComponent(parts[1] ?? ''), to: decodeURIComponent(parts[2] ?? ''), label }
  }

  if (head === 'p' && parts.length === 5) {
    const start = Number(parts[1])
    const end = Number(parts[2])
    const total = Number(parts[3])
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(total) || total <= 0) {
      throw new Error(`无法识别的全文范围：${expr}`)
    }
    const titles = (parts[4] ?? '').split('+').filter((part) => part !== '').map(decodeURIComponent)
    if (titles.length === 0) throw new Error(`无法识别的全文范围：${expr}`)
    return { mode: 'pages', start, end, total, titles, label }
  }

  throw new Error(`无法识别的全文范围：${expr}`)
}

/**
 * 把正文按范围切片。
 *
 * @param content 现取到的全文（未截断前的原样正文）
 * @param expr    范围表达式
 */
export function sliceFulltext(content: string, expr: string): FulltextSlice {
  const range = parseFulltextRange(expr)
  const length = content.length
  /** 有人读标签就用它（章节模式定格），否则退回自动生成的范围描述。 */
  const labelOf = (fallback: string): string => range.label ?? fallback

  switch (range.mode) {
    case 'all':
      return { text: content, scopeLabel: labelOf('全文'), estimated: false, fallbackAll: false }

    case 'chars':
    case 'offsets': {
      const [start, end] = clampRange(range.start, range.end, length)
      return {
        text: content.slice(start, end),
        scopeLabel: labelOf(`字符 ${start}–${end}`),
        estimated: false,
        fallbackAll: false,
      }
    }

    case 'headings': {
      const from = findHeadingOffset(content, range.from)
      const to = findHeadingOffset(content, range.to)
      if (from === null || to === null || to <= from) {
        return { text: content, scopeLabel: labelOf('全文（标题未匹配）'), estimated: true, fallbackAll: true }
      }
      return {
        text: content.slice(from, to),
        scopeLabel: labelOf(`标题 ${range.from} – ${range.to}`),
        estimated: false,
        fallbackAll: false,
      }
    }

    case 'pages': {
      const titles = range.titles
      const total = range.total
      const startPage = Math.min(Math.max(1, range.start), total)
      const endPage = Math.min(Math.max(startPage, range.end), total)
      const approxStart = Math.floor((startPage - 1) / total * length)
      const approxEnd = Math.floor(endPage / total * length)

      // 起点优先用第一个书签标题的精确匹配，修正页码估算的偏差；终点仍按页码
      // 比例取，且与标题起点取较大者——宁可多带一点下文，也别把章节开头切掉。
      const headingStart = findHeadingOffset(content, titles[0] ?? '')
      const [safeStart, safeEnd] = clampRange(
        headingStart !== null ? headingStart : approxStart,
        Math.max(approxEnd, (headingStart ?? approxStart) + 1),
        length,
      )
      return {
        text: content.slice(safeStart, safeEnd),
        scopeLabel: labelOf(`章节 ${titles.join('、')}（P${startPage}–P${endPage}）`),
        // 终点是页码估算，即使起点匹配成功也仍需声明，避免给出精确的假象。
        estimated: true,
        fallbackAll: false,
      }
    }
  }
}
