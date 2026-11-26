/**
 * 会话历史里的 Zotero 引用胶囊。
 *
 * 草稿里的 chip 在提交那一刻由 codec 展开成完整引用（见 reference.ts），会话历史
 * 读到的是这份展开文本，所以历史里原本是一大段引用。这里把它收回来：
 *
 * 1. {@link zoteroHistoryRule} 认领 `<zotero-ref>…</zotero-ref>` 整块，节点 id
 *    同时是 `conversation.user.text.node` 席位的 key；
 * 2. {@link createHistoryRefNode} 渲染成与草稿同款的胶囊：悬停用宿主的
 *    HoverCard 预览完整引用，点击仍可打开完整面板（触屏、键盘兜底）。
 *
 * 胶囊上的短标签直接取引用第一行（`【Zotero 摘录｜标题｜KEY】`），不额外存字段，
 * 老会话里的引用块也能显示。
 */

import { useMemo, useState, type CSSProperties, type MouseEvent } from 'react'

import { HoverCard, Modal, ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from './locales'
import { evidenceDisplayText, evidenceHref, evidenceIn, type EvidenceTarget } from './evidence'
import { digestEvidenceIn } from './digestEvidence'
import { tpl } from './locales'
import { itemKeyOf } from './historyRefKey'
import { DIGEST_CITATION_DATA, REVIEW_CITATION_DATA, type DigestCitation } from './answerEvidenceLinks'
import { displayReviewEvidence, reviewEvidenceGroups, type ReviewEvidenceRef } from './reviewEvidence'
import { CITATION_CLOSE, CITATION_OPEN } from './reference'
import { Button } from './ui'

/** 节点 id 同时是 userText 规则 id 与 `conversation.user.text.node` 的 key。 */
export const HISTORY_REF_NODE = 'zotero-ref'

/** 宿主 userText 规则中本插件实现的那部分（`context` 用不到，签名允许省略）。 */
export interface UserTextRuleLike {
  readonly id: string
  readonly order: number
  match(text: string, from: number): {
    id: string
    start: number
    end: number
    data: { label: string }
  } | undefined
}

/** 宿主 uiConversation 服务中本插件用到的部分。 */
export interface UiConversationFace {
  userText: {
    register(rule: UserTextRuleLike): () => void
  }
}

/** 历史节点席位下发的 prop（宿主 `conversation.user.text.node`）。 */
interface HistoryRefNodeProps {
  node: { data: { label?: string } }
  raw: string
  interactive?: boolean
}

/** 胶囊上的短标签：引用第一行去掉括号与 `Zotero` 前缀，过长截断。 */
function chipLabel(inner: string): string {
  const first = inner.trimStart().split('\n', 1)[0] ?? ''
  const text = first
    .replace(/[【】[\]]/gu, ' ')
    .replace(/^\s*Zotero\s+/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const chars = Array.from(text)
  if (chars.length === 0) return 'Zotero'
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : text
}

/** 去掉包裹标记，得到展示用的完整引用文本。 */
function citationBody(raw: string): string {
  const open = raw.indexOf(CITATION_OPEN)
  const close = raw.lastIndexOf(CITATION_CLOSE)
  return open < 0 || close <= open ? raw : raw.slice(open + CITATION_OPEN.length, close).trim()
}

/** 找最近一个完整的 `<zotero-ref>` 块；没有闭合标记（老消息 / 被截断）就不认领。 */
export const zoteroHistoryRule: UserTextRuleLike = {
  id: HISTORY_REF_NODE,
  order: 100,
  match(text, from) {
    const start = text.indexOf(CITATION_OPEN, from)
    if (start < 0) return undefined
    const close = text.indexOf(CITATION_CLOSE, start + CITATION_OPEN.length)
    if (close < 0) return undefined
    return {
      id: HISTORY_REF_NODE,
      start,
      end: close + CITATION_CLOSE.length,
      data: { label: chipLabel(text.slice(start + CITATION_OPEN.length, close)) },
    }
  },
}

const MODAL_BODY_STYLE: CSSProperties = {
  margin: 0,
  maxHeight: '52vh',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-primary, CanvasText)',
}

/** 悬停卡片：宽度与高度都收住，卡片内容区可停留、可滚动。 */
const HOVER_CARD_STYLE: CSSProperties = {
  maxWidth: 460,
  maxHeight: 360,
  overflow: 'auto',
}

const HOVER_BODY_STYLE: CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.6,
}

/** 打开原文按钮与正文之间留一点间距。 */
const OPEN_BUTTON_STYLE: CSSProperties = {
  marginTop: 8,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  height: 'auto',
}

function citationTitles(body: string): Map<string, string> {
  const titles = new Map<string, string>()
  // 标题来自引用头，按条目 key 匹配，多个章节可共用同一文献标题。
  for (const match of body.matchAll(/^(?:【Zotero [^｜\n]+｜|\[Zotero [^|\n]+ \| )(.+?)(?:｜| \| )([A-Z2-9]{8})(?=｜|】| \||\])/gmu)) {
    titles.set(match[2], match[1])
  }
  return titles
}

/** 生成历史节点渲染器：`t` 与 `openItem` 在 apply 时绑定，组件只拿席位下发的 prop。 */
export function createHistoryRefNode(
  t: Translate,
  onOpenItem: (key: string) => void,
  onOpenEvidence: (evidence: EvidenceTarget) => void,
  onOpenReviewEvidence: (ref: ReviewEvidenceRef) => void,
) {
  return function ZoteroHistoryRef({ node, raw, interactive }: HistoryRefNodeProps) {
    const [open, setOpen] = useState(false)
    const label = node.data.label ?? chipLabel(citationBody(raw))
    // 悬停卡片会展示全文，原生 title 气泡会与其重叠。
    const chip = <ReferenceChip appearance="file" label={label} title="" />

    function openChip(event: MouseEvent<HTMLButtonElement>): void {
      if (event.detail > 1) return
      const button = event.currentTarget
      const selection = button.ownerDocument.getSelection()
      // 阅读器定位证据时会保留选区。只有划选经过当前胶囊才拦截鼠标点击。
      if (event.detail !== 0 && selection !== null && !selection.isCollapsed) {
        for (let i = 0; i < selection.rangeCount; i += 1) {
          if (selection.getRangeAt(i).intersectsNode(button)) return
        }
      }
      setOpen(true)
    }

    const body = citationBody(raw)
    const itemKey = itemKeyOf(body)
    const digest = useMemo(() => digestEvidenceIn(t, body), [t, body])
    const evidence = digest?.map(({ target }) => target) ?? evidenceIn(body)
    const titles = digest === null && evidence.length > 0 ? citationTitles(body) : undefined
    const digestCitations = useMemo(() => digest?.map(({ target, label, paperKey }): DigestCitation =>
      [target.id, evidenceHref(target), label, paperKey]), [digest])
    const groups = useMemo(() => reviewEvidenceGroups(body), [body])
    const displayText = groups.length === 0 ? evidenceDisplayText(body) : displayReviewEvidence(body)
    const references = groups.flatMap(({ links }) => links)
    const run = references[0]?.run
    const reviewActions = groups.length === 0 ? null : (
      <details>
        <summary>{t('review.evidenceList')}</summary>
        {groups.map(({ title, links }) => (
          <details key={links[0].id}>
            <summary>{title}</summary>
            {links.map((ref) => (
              <Button
                key={ref.id}
                variant="outline"
                size="sm"
                style={OPEN_BUTTON_STYLE}
                onClick={() => { setOpen(false); onOpenReviewEvidence(ref) }}
              >
                {ref.id}
              </Button>
            ))}
          </details>
        ))}
      </details>
    )
    // 点击胶囊原有的「看完整引用」行为不抢；回溯入口放在悬停卡片与 Modal 里。
    const openOriginal = evidence.length > 0 ? evidence.map((target, index) => {
      const quote = target.quote?.replace(/\s+/gu, ' ').trim()
      const title = titles?.get(target.key) || (quote && (quote.length > 64 ? `${quote.slice(0, 64)}…` : quote))
      const page = target.pageLabel || target.page
      const location = page === undefined ? '' : tpl(t(target.chapterStart ? 'evidence.chapterPage' : 'evidence.page'), { page })
      const name = title || tpl(t('evidence.number'), { number: index + 1 })
      return (
        <Button
          key={target.id}
          variant="outline"
          size="sm"
          style={digest === null ? OPEN_BUTTON_STYLE : { ...OPEN_BUTTON_STYLE, marginTop: 0 }}
          onClick={() => { setOpen(false); onOpenEvidence(target) }}
        >
          {digest?.[index].label ?? tpl(t('evidence.open'), { name: name + location })}
        </Button>
      )
    }) : itemKey === null ? null : (
      <Button
        variant="outline"
        size="sm"
        style={OPEN_BUTTON_STYLE}
        onClick={() => { setOpen(false); onOpenItem(itemKey) }}
      >
        {t('history.openItem')}
      </Button>
    )
    const actions = reviewActions ?? openOriginal
    const actionList = digest !== null && actions !== null
      ? <div className="dsh-zp-digest-evidence-actions">{actions}</div>
      : actions
    return (
      <>
        {digestCitations !== undefined && digestCitations.length > 0 && (
          <span hidden {...{ [DIGEST_CITATION_DATA]: JSON.stringify(digestCitations) }} />
        )}
        {run !== undefined && (
          <span hidden {...{
            [REVIEW_CITATION_DATA]: [run, ...references.filter((ref) => ref.run === run).map((ref) => ref.id)].join(' '),
          }} />
        )}
        <HoverCard
          inline
          grouped
          openDelayMs={350}
          anchor={interactive === true ? (
            <button type="button" className="dsh-zp-history-chip" onClick={openChip}>
              {chip}
            </button>
          ) : chip}
          content={(
            <div style={HOVER_CARD_STYLE}>
              <div style={HOVER_BODY_STYLE}>{displayText}</div>
              {actionList}
            </div>
          )}
        />
        {open && (
          <Modal
            open
            className="dsh-zp-history-modal"
            onClose={() => setOpen(false)}
            title={t('history.title')}
            closeLabel={t('action.close')}
          >
            <pre style={MODAL_BODY_STYLE}>{displayText}</pre>
            {actionList && (
              <div className="dsh-zp-history-actions">{actionList}</div>
            )}
          </Modal>
        )}
      </>
    )
  }
}
