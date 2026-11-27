/**
 * 左上角的悬浮信息菜单：文献信息 / 摘要 / 标注 / 笔记 / 附件 / 标签 / 相关 / 参考文献。
 *
 * 文档占满整版面，元数据类内容收进这个按钮背后的浮层，每块都可折叠。
 * 「加入对话」是这一行里的独立按钮（`i` 右侧），不放浮层里：它是每次读文献都要点的
 * 主操作，藏进菜单等于每次多两次点击。独立笔记也有这枚按钮，插的是 `note:` 引用
 * （展开笔记正文），不是空壳的条目元数据；接线在 `ZoteroItemPane`。
 * 浮层用系统色 `Canvas` / `CanvasText`，盖在白色 PDF 上深浅主题都能读。
 * 点浮层外或按 Esc 关闭（统一走 {@link useDismiss}，网页快照在 iframe 里的按下也算
 * 「外」）；点标注定位后也关闭，让文档重新成为焦点。
 *
 * 与目录浮层完全一致：画在右栏外侧、可拖位置、可拖右下角改大小、标题栏有图钉，
 * **位置与尺寸按条目记一份**（见 `floatingBox` 与 `viewStateStore`），换一篇就是
 * 另一套摆法。
 *
 * 各区块的开合记在本机（同 `view-state.json`），**全局一份**：用户按自己的习惯
 * 折过一次之后，换文献、关浮层、重启都保持原样，不用每篇重新折。
 *
 * 刷新整份详情的按钮在**阅读器工具条**（页面级，见 `DocumentView`），不放在这里：
 * 它同时影响页面上的标注，浮层收着的时候也应该能点。
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'

import type { JournalTags, ZoteroAnnotation, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { isBibliographicItem, isBibliographyStyle, type BibliographyStyle } from '../zotero/bibliography'
import { AnnotationList } from './AnnotationList'
import type { AnnotationFilter } from './annotationRuns'
import { bibliographyStyles, formatBibliography } from './bibliography'
import { writeClipboard } from './clipboard'
import { useDismiss } from './dismiss'
import { makeEvidence } from './evidence'
import type { AttachmentCitation } from './cite'
import { FulltextScope, type FulltextMode } from './fulltextScope'
import { InsertMenu } from './InsertMenu'
import type { DocumentOutlineItem } from './viewer/types'
import { useFloatingBox } from './floatingBox'
import { itemFieldRows } from './itemFields'
import { itemTypeLabel } from './itemType'
import { tpl, type Translate } from './locales'
import { NoteList } from './NoteList'
import { fetchBibliography, fetchJournalTags, openJournalUrl } from './api'
import { extraChips, extraSupplementChips, journalTagChips, readJournalMetrics, type MetricChip } from './journalMetrics'
import { journalLinks } from './journalLinks'
import { showToast } from './paneStore'
import { ACCENT, journalChipStyle, SECTION_TOGGLE_CLASS, TREE_ORANGE } from './styles'
import { estimateTokens } from './tokens'
import { OpenInZoteroIcon } from './viewer/OpenInZoteroIcon'
import {
  setInfoSection,
  toggleInfoSection,
  useInfoSections,
  type InfoSectionId,
} from './viewStateStore'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  /** 当前正文展示的附件；附件块据此打勾。 */
  currentAttachmentKey: string | null
  attachmentTitle: string
  fulltextUnavailable: string
  open: boolean
  onToggle(): void
  onClose(): void
  onCite(): void
  /** 目录浮层那份章节列表：全文选择器复用它做「按章节」范围。 */
  outline: DocumentOutlineItem[] | null
  /** 确认插入全文（range 表达式 + 人读范围标注由选择器产出）。 */
  onInsertFulltext(source: AttachmentCitation, scope: string): void
  onSelectAttachment(key: string): void
  /** 打开「相关」里另一条条目的 tab；缺失时相关行只展示、不可点。 */
  onOpenItem?(key: string, title: string): void
  onLocateAnnotation(annotation: ZoteroAnnotation): void
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  onInsertNote(note: ZoteroNote): void
  /** 面板里的写操作成功后重取整份详情。 */
  onChanged(): void
  annotationFilter: AnnotationFilter
  onAnnotationFilterChange(filter: AnnotationFilter): void
  /** 启动截图（「加入对话」右边的「截图加入对话」文字按钮）。 */
  onScreenshot(): void
  /** 当前渲染器是否支持截图；不支持时按钮置灰并给出原因。 */
  screenshotAvailable: boolean
  screenshotReason: string
  /** 「汇总笔记与标注」：交给上层打开确认弹层（这一层不取数、不插 chip）。 */
  onDigest(): void
  /** 汇总项行尾提示：`12 标注 · 3 笔记`。 */
  digestHint: string
  /** 量出悬浮按钮行宽度，供工具条的 `paddingLeft` 让位（语言/文案会改变宽度）。 */
  onRowWidth?(width: number): void
}

interface BlockProps {
  t: Translate
  label: string
  hint?: string
  open: boolean
  onToggle(): void
  /**
   * 标题行右侧的独立操作（如「笔记」的加号新建）。
   *
   * 不能塞进标题按钮里：那会变成 `<button>` 套 `<button>`，点一下既触发操作又开合区块。
   */
  action?: ReactNode
  children: ReactNode
}

/**
 * 一个可折叠区块。
 *
 * 开合图标放在**标题行最右边**（计数与加号之后）：标题本身是整行可点的按钮，
 * 但点文字不像「能折」，右侧那个翻转的箭头才是通用符号。两个按钮都调
 * `onToggle`，右边的从键盘焦点里摘掉（`tabIndex={-1}` + `aria-hidden`），
 * 免得同一件事在 Tab 序列里出现两次。
 */
function Block({ t, label, hint, open, onToggle, action, children }: BlockProps): ReactElement {
  return (
    <section style={blockStyle}>
      <div style={blockHeaderRowStyle}>
        <button type="button" onClick={onToggle} aria-expanded={open} style={blockHeaderStyle}>
          <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
          {hint !== undefined && <span style={blockHintStyle}>{hint}</span>}
        </button>
        {action}
        <button
          type="button"
          onClick={onToggle}
          tabIndex={-1}
          aria-hidden="true"
          title={open ? t('detail.sectionCollapse') : t('detail.sectionExpand')}
          className={SECTION_TOGGLE_CLASS}
          style={blockToggleStyle}
        >
          <ChevronIcon open={open} />
        </button>
      </div>
      {open && <div style={blockBodyStyle}>{children}</div>}
    </section>
  )
}

/**
 * 远程查询的界面状态。
 *
 * `no_key` / `miss` 都不是错误：前者提示去设置页填密钥，后者说明这刊不在
 * easyScholar 库里 —— 静默跳过，不要制造「功能坏了」的错觉。
 */
type TagsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; tags: JournalTags }
  | { kind: 'no_key' }
  | { kind: 'miss' }
  | { kind: 'failed'; message: string }

/**
 * 文献信息里的一行。
 *
 * 普通行是「标签 + 值」；`block` 用于整块自定义内容（期刊指标卡）—— 它需要
 * 自己的浅底容器和胶囊排版，塞进两段式 label/value 里做不出来。
 */
type MetaRow = { label: string; value: ReactNode } | { block: ReactNode }

function BibliographyBlock({ t, detail, open, onToggle }: {
  t: Translate
  detail: ZoteroItemDetail
  open: boolean
  onToggle(): void
}): ReactElement {
  const [style, setStyle] = useState<BibliographyStyle>('apa')
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    detail: ZoteroItemDetail
    style: BibliographyStyle
    attempt: number
    html: string
    message?: string
  } | null>(null)
  const defaultPreview = useMemo(() => formatBibliography(detail.bib ?? ''), [detail.bib])
  const styles = bibliographyStyles(t)
  const current = result?.detail === detail && result.style === style && result.attempt === attempt ? result : null
  const useDefault = style === 'apa' && defaultPreview.count === 1
  const preview = useMemo(() => formatBibliography(current?.html ?? ''), [current?.html])
  const formatted = useDefault ? defaultPreview : preview

  useEffect(() => {
    if (!open || useDefault || current !== null) return
    const controller = new AbortController()
    void fetchBibliography([detail.key], style, controller.signal).then(({ html }) => {
      if (!controller.signal.aborted) setResult({ detail, style, attempt, html })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      setResult({ detail, style, attempt, html: '', message })
    })
    return () => controller.abort()
  }, [open, useDefault, current, detail, style, attempt])

  return (
    <Block
      t={t}
      label={t('detail.bibTitle')}
      open={open}
      onToggle={onToggle}
      action={(
        <>
          <select
            aria-label={t('bibliography.style')}
            title={styles.find(({ id }) => id === style)?.label}
            value={style}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (isBibliographyStyle(value)) {
                setStyle(value)
                if (!open) onToggle()
              }
            }}
            style={{ ...bibliographyActionStyle, maxWidth: 120 }}
          >
            {styles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          <button
            type="button"
            style={bibliographyActionStyle}
            aria-label={t('bibliography.copy')}
            disabled={formatted.count !== 1 || formatted.text === ''}
            onClick={() => {
              void writeClipboard(formatted.text, formatted.html).then((ok) => {
                showToast(t(ok ? 'toast.copied' : 'toast.copyFailed'))
              })
            }}
          >
            {t('bibliography.copyShort')}
          </button>
        </>
      )}
    >
      {formatted.count > 0 ? (
        <div style={{ ...paragraphStyle, overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: formatted.html }} />
      ) : current?.message !== undefined ? (
        <div>
          <p style={paragraphStyle} role="status">{tpl(t('bibliography.failed'), { message: current.message })}</p>
          <button type="button" style={bibliographyActionStyle} onClick={() => setAttempt((value) => value + 1)}>
            {t('action.retry')}
          </button>
        </div>
      ) : (
        <p style={paragraphStyle} role="status">
          {current === null ? t('bibliography.loading') : t('bibliography.skipUnavailable')}
        </p>
      )}
    </Block>
  )
}

export function InfoPanel({
  t,
  detail,
  currentAttachmentKey,
  attachmentTitle,
  fulltextUnavailable,
  open,
  onToggle,
  onClose,
  onCite,
  outline,
  onInsertFulltext,
  onSelectAttachment,
  onOpenItem,
  onLocateAnnotation,
  onInsertAnnotation,
  onInsertNote,
  onChanged,
  annotationFilter,
  onAnnotationFilterChange,
  onScreenshot,
  screenshotAvailable,
  screenshotReason,
  onDigest,
  digestHint,
  onRowWidth,
}: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 分裂按钮外壳：全文选择器的 triggerRef，点它不被判成点浮层外面。 */
  const insertTriggerRef = useRef<HTMLSpanElement | null>(null)
  /** 全文范围选择器浮层是否打开（与信息浮层互斥，避免两块叠在一起）。 */
  const [fulltextOpen, setFulltextOpen] = useState(false)
  /** 从菜单哪一项进来：决定浮层打开时 select 预选哪种方式。 */
  const [fulltextMode, setFulltextMode] = useState<FulltextMode>('chapter')
  /** 无全文索引时按钮置灰，hover 给出原因。 */
  const hasFulltext = detail.fulltext?.revision !== undefined
  /** 悬浮按钮行：宽度随语言与「加入对话」文案变化，量出来给工具条让位。 */
  const rowRef = useRef<HTMLDivElement | null>(null)
  /** 各区块开合来自持久状态，不放在组件里：换条目/重开/重启都是同一份。 */
  const sections = useInfoSections()
  /** 「笔记」新建框是否打开：加号在区块标题行，编辑器在区块内，状态只能放在这里。 */
  const [composingNote, setComposingNote] = useState(false)
  /** 钉住：点浮层外 / 点正文都不收，`Esc` 与再点 `i` 仍关。 */
  const [pinned, setPinned] = useState(false)
  const [pinHovered, setPinHovered] = useState(false)

  /** 与目录浮层同一套几何：贴右栏外侧、可拖可缩、按条目记住位置。 */
  const box = useFloatingBox({
    open,
    anchorRef: rootRef,
    itemKey: detail.key,
    kind: 'info',
    width: PANEL_WIDTH,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
  })

  // 换条目 / 收起浮层时丢掉半截的新建草稿，免得带到下一条文献上；全文选择器一并收起。
  useEffect(() => {
    setComposingNote(false)
    setFulltextOpen(false)
  }, [detail.key, open, currentAttachmentKey])

  // 点浮层外 / 按 Esc 收起。根节点同时包着触发按钮与浮层，点它不会被判成
  // 「外面」，交给 `onToggle` 自己开合。
  useDismiss(open, rootRef, onClose, { pinned })

  // 「加入对话」在 zh / en 下宽度不同；写死 left 或 paddingLeft 必错。
  // 量整行宽度上报，由 ItemDetail 写成 CSS 变量给工具条。
  useLayoutEffect(() => {
    const node = rowRef.current
    if (node === null || onRowWidth === undefined) return
    const report = (): void => onRowWidth(node.getBoundingClientRect().width)
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [onRowWidth])

  function toggle(id: InfoSectionId): void {
    toggleInfoSection(id)
  }

  /** 打开全文浮层：先收起信息浮层，两块浮层不同时占住屏幕。 */
  function openFulltext(mode: FulltextMode): void {
    onClose()
    setFulltextMode(mode)
    setFulltextOpen(true)
  }

  /** 菜单展开时收起信息浮层：下拉要压在浮层上面，两者同开必然互相挡。 */
  function handleMenuOpenChange(next: boolean): void {
    if (next) onClose()
  }

  /**
   * 整篇大概要占多少 token —— 显示在插入菜单「整篇全文」那一行的第二行小字里。
   *
   * 只能从正文算，所以放在详情侧算一次并按正文串身份缓存：20 万字符跑一遍
   * `estimateTokens` 是几毫秒级，没必要每次重绘都跑。
   */
  const fulltextTokens = useMemo(
    () => estimateTokens(detail.fulltext?.content ?? ''),
    [detail.fulltext?.content],
  )

  /**
   * 期刊指标：只从条目**已有**的 extra / 标签里读，读不到就整块不出现。
   *
   * 不做在线查询也不内置数据表 —— 影响因子与分区是商业授权数据，见
   * `journalMetrics.ts` 顶部那段说明。面板上多一行错的值比少一行严重得多。
   */
  const metrics = useMemo(
    () => readJournalMetrics(detail.extra, detail.tags),
    [detail.extra, detail.tags],
  )

  /** 期刊名：远程查询与外部入口都用它，空表示这条不是期刊文献。 */
  const journalName = detail.publicationTitle.trim() !== ''
    ? detail.publicationTitle.trim()
    : detail.journalAbbreviation.trim()

  /**
   * 归一标签查询：浮层打开 + 有刊名就查。
   *
   * 优先取 Zotero Style 算好的结果；没有才用本插件缓存，最后才打 easyScholar
   * （结果写回本地缓存，供列表直接渲染）。库里 extra 的指标不再抢占这三枚胶囊，
   * 但会作为补充项留在同一张卡里，且 extra 原文仍在字段表中。
   */
  const [tags, setTags] = useState<TagsState>({ kind: 'idle' })

  /**
   * 「重查」计数：点一下 +1，让下面那个 effect 重跑。
   *
   * 不另加 force 参数去绕过 Host 的缓存 —— 缓存命中是即时的，而真正需要远端
   * 新数据的场景是「刚在设置页填好密钥」，effect 重跑本身就会读到新配置。
   */
  const [refreshNonce, setRefreshNonce] = useState(0)

  /**
   * ⓘ 的数据来源说明是否展开。
   *
   * 用点击展开而不是 hover 提示：内容区是 `overflow: auto`，任何绝对定位的
   * 浮层都会被裁掉（卡片靠底部时尤其明显），而原生 `title` 有半秒多延迟。
   * 展开在卡内，不涉及定位，长文案还能选中复制。
   */
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    if (!open || journalName === '') {
      setTags({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    setTags({ kind: 'loading' })
    void fetchJournalTags(journalName, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return
        if (outcome.status === 'ok') setTags({ kind: 'ok', tags: outcome.tags })
        else if (outcome.status === 'no_key') setTags({ kind: 'no_key' })
        else if (outcome.status === 'miss') setTags({ kind: 'miss' })
        else setTags({ kind: 'failed', message: outcome.message })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setTags({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => { controller.abort() }
  }, [open, journalName, refreshNonce])

  /**
   * 外部站点入口：四个站查的东西不重叠（指标 / 收录核验 / 投稿参考 / SJR），
   * 见 `journalLinks.ts`。ISSN 优先、刊名兜底。
   */
  const journalQueryLinks = useMemo(
    () => journalLinks({
      issn: detail.issn,
      publicationTitle: detail.publicationTitle,
      journalAbbreviation: detail.journalAbbreviation,
    }),
    [detail.issn, detail.publicationTitle, detail.journalAbbreviation],
  )

  async function handleOpenJournalLink(url: string): Promise<void> {
    try {
      await openJournalUrl(url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast(tpl(t('detail.queryFailed'), { message }))
    }
  }

  const metaRows: MetaRow[] = []
  const typeLabel = itemTypeLabel(t, detail.itemType)
  if (typeLabel !== '') metaRows.push({ label: t('detail.type'), value: typeLabel })
  if (detail.creators.length > 0) metaRows.push({ label: t('detail.creators'), value: detail.creators.join('、') })

  /*
   * 字段表：除类型 / 作者外，其余元数据一律按 Zotero 信息栏的次序铺开（见
   * `itemFields.ts`）。有值才出现 —— Zotero 里那一片空行对读者没有信息量，
   * 面板又比信息栏窄，全列出来只会把摘要与标注挤到屏幕外。
   *
   * 「出版物」在这里单独一行，不交给字段表：期刊指标卡要紧接着它（指标的
   * 主体是这本刊，不是这篇文献），让循环来排就插不进这个位置了。
   */
  const fields = detail.fields ?? {}
  if (detail.publicationTitle !== '') {
    metaRows.push({ label: t('detail.field.publicationTitle'), value: detail.publicationTitle })
  }
  // 日期缺失（手工录入的旧条目常见）才退回只显示年份：Zotero 只有「日期」一栏，
  // 两行都出现等于把同一个信息说两遍。
  if (fields.date === undefined && detail.year !== '') {
    metaRows.push({ label: t('detail.year'), value: detail.year })
  }

  /*
   * 期刊指标卡：Style 同款彩色胶囊（IF / SCI / 中科院 / EI检索 / 北核 / 科核）
   * + extra 里的补充项 + 一行操作。
   *
   * 为什么单独成块：这些数字评价的是**期刊**，不是这篇文献，跟上面的类型 / 作者 /
   * 年份不是一类信息。前 3 枚与 Zotero Style 列同款；中文期刊的知网口径、被引
   * 等 Style 不显示的信息作为补充胶囊保留，来源不同不混成一枚。
   */
  const tagChips = tags.kind === 'ok' ? journalTagChips(tags.tags) : []
  const supplements: MetricChip[] = metrics === null
    ? []
    : tagChips.length > 0 ? extraSupplementChips(metrics) : extraChips(metrics)

  // 全都没有时用一句话说明原因：没密钥 / 查不到 / 出错。查到了就只显示胶囊。
  let note: string | null = null
  let noteWarn = false
  if (tagChips.length === 0 && supplements.length === 0 && journalName !== '') {
    if (tags.kind === 'loading') note = t('detail.querying')
    else if (tags.kind === 'no_key') note = t('detail.noKeyHint')
    else if (tags.kind === 'miss') note = t('detail.missHint')
    else if (tags.kind === 'failed') {
      note = tags.message
      noteWarn = true
    }
  }

  const showRetry = tagChips.length === 0 && journalName !== '' && tags.kind !== 'loading'
  if (tagChips.length > 0 || supplements.length > 0 || note !== null || journalQueryLinks.length > 0) {
    // ⓘ 的说明随来源变化：本地读的和第三方查的，责任完全不同。
    const sourceHint = tags.kind === 'ok'
      ? t(tags.tags.source === 'style' ? 'detail.metricsSourceStyle'
        : tags.tags.source === 'cache' ? 'detail.metricsSourceCache' : 'detail.metricsSourceApi')
      : metrics !== null ? t('detail.metricsSourceExtra') : t('detail.metricsSourceRemote')
    metaRows.push({
      block: (
        <div style={metricCardStyle}>
          <div style={metricCardTitleStyle}>{t('detail.journalMetrics')}</div>
          {(tagChips.length > 0 || supplements.length > 0 || note !== null) && (
            <div style={chipGroupStyle}>
              {tagChips.map((chip, index) => (
                <span key={`${chip.label}-${String(index)}`} style={journalChipStyle(chip.tone)}>
                  <span>{chip.label}</span>
                  {chip.value !== '' && <span style={chipValueStyle}>{chip.value}</span>}
                </span>
              ))}
              {supplements.map((chip, index) => (
                <span key={`${chip.tagKey}-${String(index)}`} style={chipStyle}>
                  {chip.tagKey !== '' && <span style={chipTagStyle}>{t(chip.tagKey)}</span>}
                  {chip.value !== '' && (
                    <span style={chip.warn === true ? chipWarnStyle : chipValueStyle}>{chip.value}</span>
                  )}
                </span>
              ))}
              {note !== null && (
                <span style={noteWarn ? warnHintStyle : mutedHintStyle}>{note}</span>
              )}
            </div>
          )}
          <div style={metricActionRowStyle}>
            {journalQueryLinks.map((link) => (
              <button
                key={link.id}
                type="button"
                onClick={() => { void handleOpenJournalLink(link.url) }}
                title={t(link.hintKey)}
                style={journalLinkStyle}
              >
                {link.label}
                <OpenInZoteroIcon size={10} />
              </button>
            ))}
            {showRetry && (
              <button
                type="button"
                onClick={() => { setRefreshNonce((prev) => prev + 1) }}
                style={journalLinkStyle}
              >
                {tags.kind === 'idle' ? t('detail.queryNow') : t('detail.queryRetry')}
              </button>
            )}
            <button
              type="button"
              onClick={() => { setShowSource((prev) => !prev) }}
              aria-expanded={showSource}
              aria-label={t('detail.metricsSource')}
              style={{ ...infoIconStyle, opacity: showSource ? 0.9 : 0.45 }}
            >
              <InfoIcon />
            </button>
          </div>
          {showSource && <div style={sourceNoteStyle}>{sourceHint}</div>}
        </div>
      ),
    })
  }
  /*
   * 指标卡之后接上其余字段（出版社、地点、日期、卷期页码、DOI、网址、ISSN、
   * 语言、版权、其他、添加/修改时间…），次序照 Zotero 信息栏。
   *
   * 「其他」= extra 原文，整段照搬，和上面的指标胶囊重复也没关系：那块是给一眼
   * 看的摘要，这一行才是条目里真实存着的东西（模型插入文献信息时读的也是原文）。
   */
  for (const row of itemFieldRows(fields, t, ['publicationTitle'])) {
    metaRows.push({ label: row.label, value: row.value })
  }
  if (detail.collectionNames.length > 0) {
    metaRows.push({ label: t('detail.collections'), value: detail.collectionNames.join(' / ') })
  }
  // 标签与相关各自成块（与 Zotero 信息栏一致），不再挤进元数据行。
  const related = detail.related ?? []

  const selfNote = detail.itemType === 'note'
  const notes = detail.notes

  return (
    <div ref={rootRef} style={rootStyle}>
      {/* 目录按钮（left:8）在 OutlinePanel，这一行从 left:34 起按内容排布。 */}
      <div ref={rowRef} style={rowStyle}>
        <button
          type="button"
          onClick={() => {
            setFulltextOpen(false)
            onToggle()
          }}
          aria-expanded={open}
          aria-label={t('detail.info')}
          title={t('detail.info')}
          style={triggerStyle}
        >
          i
        </button>

        {/*
          三个并列按钮（加入对话 / 全文 / 截图加入对话）收成一枚分裂按钮：
          左半仍是「加入对话」= 插文献信息，右半下拉列出全部插入方式。
          独立笔记也走这里：主按钮插 `note:` 引用展开正文，且没有其它方式可列。
          `chapterCount` 传 `null` 而不是 0：目录还没解析出来时按「未知」处理，
          别让「按章节选择」在刚切文献那一瞬闪成置灰。
        */}
        <InsertMenu
          t={t}
          selfNote={selfNote}
          hasFulltext={hasFulltext}
          fulltextUnavailable={fulltextUnavailable}
          fulltextChars={detail.fulltext?.content.length ?? 0}
          fulltextTruncated={detail.fulltext?.truncated === true}
          fulltextTokens={fulltextTokens}
          chapterCount={outline === null ? null : outline.length}
          onCite={onCite}
          onInsertWhole={() => openFulltext('all')}
          onPickChapters={() => openFulltext('chapter')}
          onPickRanges={() => openFulltext('chars')}
          onScreenshot={onScreenshot}
          screenshotAvailable={screenshotAvailable}
          screenshotReason={screenshotReason}
          onDigest={onDigest}
          digestHint={digestHint}
          onMenuOpenChange={handleMenuOpenChange}
          triggerRef={insertTriggerRef}
        />
      </div>

      {open && box.style !== null && (
        <div
          ref={box.panelRef}
          role="dialog"
          aria-label={t('detail.info')}
          {...box.panelProps}
          style={{ ...panelStyle, ...box.style }}
        >
          <div style={panelHeaderStyle} {...box.moveProps}>
            <span style={panelTitleStyle} title={detail.title}>{detail.title}</span>
            <button
              type="button"
              aria-pressed={pinned}
              aria-label={pinned ? t('detail.unpin') : t('detail.pin')}
              title={pinned ? t('detail.unpin') : t('detail.pin')}
              onClick={() => setPinned((current) => !current)}
              onMouseEnter={() => setPinHovered(true)}
              onMouseLeave={() => setPinHovered(false)}
              style={{
                ...pinStyle,
                color: pinned ? ACCENT : 'CanvasText',
                opacity: pinned ? 1 : 0.5,
                background: pinHovered ? 'rgba(127,127,127,0.16)' : 'transparent',
              }}
            >
              <PinIcon filled={pinned} />
            </button>
          </div>

          <div style={bodyStyle}>
            <Block t={t} label={t('detail.metadata')} open={sections.metadata} onToggle={() => toggle('metadata')}>
              {metaRows.map((row, index) => (
                'block' in row
                  ? <div key={`block-${String(index)}`}>{row.block}</div>
                  : (
                    // 字段表里有两个同名的（`videoRecordingFormat` / `audioRecordingFormat`
                    // 都叫「格式」），key 不能只用标签，否则 React 会报重复键。
                    <div key={`${String(index)}-${row.label}`} style={metaRowStyle}>
                      <span style={metaLabelStyle}>{row.label}</span>
                      <span style={metaValueStyle(row.value)}>{row.value}</span>
                    </div>
                  )
              ))}
            </Block>

            {detail.abstract !== '' && (
              <Block
                t={t}
                label={t('detail.abstract')}
                open={sections.abstract}
                onToggle={() => toggle('abstract')}
              >
                <p style={paragraphStyle}>{detail.abstract}</p>
              </Block>
            )}

            {detail.annotations.length > 0 && (
              <Block
                t={t}
                label={t('detail.annotations')}
                hint={String(detail.annotations.length)}
                open={sections.annotations}
                onToggle={() => toggle('annotations')}
              >
                <AnnotationList
                  t={t}
                  annotations={detail.annotations}
                  hasFulltext={detail.fulltext !== null}
                  truncated={detail.fulltext?.truncated === true}
                  filter={annotationFilter}
                  canWrite={detail.writeEnabled}
                  onFilterChange={onAnnotationFilterChange}
                  onLocate={onLocateAnnotation}
                  onInsert={onInsertAnnotation}
                  onChanged={onChanged}
                />
              </Block>
            )}

            {(notes.length > 0 || (detail.writeEnabled && !selfNote)) && (
              <Block
                t={t}
                label={t('detail.notes')}
                hint={String(notes.length)}
                open={sections.notes}
                onToggle={() => toggle('notes')}
                action={
                  detail.writeEnabled && !selfNote ? (
                    <button
                      type="button"
                      onClick={() => {
                        // 区块收着就先摊开再出新笔记框，别让用户点了没反应。
                        if (!sections.notes) {
                          setInfoSection('notes', true)
                          setComposingNote(true)
                          return
                        }
                        setComposingNote((previous) => !previous)
                      }}
                      title={composingNote ? t('note.cancel') : t('note.new')}
                      aria-label={t('note.new')}
                      style={blockActionStyle}
                    >
                      {composingNote ? '×' : '+'}
                    </button>
                  ) : undefined
                }
              >
                <NoteList
                  t={t}
                  notes={notes}
                  itemKey={detail.key}
                  canWrite={detail.writeEnabled}
                  selfNote={selfNote}
                  composing={composingNote}
                  onComposingChange={setComposingNote}
                  onInsert={onInsertNote}
                  onChanged={onChanged}
                />
              </Block>
            )}

            {detail.attachments.length > 0 && (
              <Block
                t={t}
                label={t('detail.attachments')}
                hint={String(detail.attachments.length)}
                open={sections.attachments}
                onToggle={() => toggle('attachments')}
              >
                {detail.attachments.map((attachment) => {
                  const current = attachment.key === currentAttachmentKey
                  return (
                    <button
                      key={attachment.key}
                      type="button"
                      onClick={() => onSelectAttachment(attachment.key)}
                      style={{ ...attachmentRowStyle, opacity: current ? 1 : 0.8 }}
                      title={t('detail.attachmentOpen')}
                    >
                      <span style={{ width: 12, flexShrink: 0, color: ACCENT }}>{current ? '●' : ''}</span>
                      <span style={{ flex: 1, textAlign: 'left', wordBreak: 'break-word' }}>
                        {attachment.filename || attachment.title}
                      </span>
                      <span style={attachmentMetaStyle}>
                        {attachment.contentType}
                        {attachment.size > 0 ? ` · ${Math.round(attachment.size / 1024)} KB` : ''}
                      </span>
                    </button>
                  )
                })}
              </Block>
            )}

            {detail.tags.length > 0 && (
              <Block
                t={t}
                label={t('detail.tags')}
                hint={String(detail.tags.length)}
                open={sections.tags}
                onToggle={() => toggle('tags')}
              >
                <div style={tagRowStyle}>
                  {detail.tags.map((tag) => <span key={tag} style={tagChipStyle}>{tag}</span>)}
                </div>
              </Block>
            )}

            {related.length > 0 && (
              <Block
                t={t}
                label={t('detail.related')}
                hint={String(related.length)}
                open={sections.related}
                onToggle={() => toggle('related')}
              >
                {related.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    disabled={onOpenItem === undefined}
                    onClick={() => onOpenItem?.(entry.key, entry.title)}
                    title={onOpenItem === undefined ? undefined : t('detail.relatedOpen')}
                    style={{ ...relatedRowStyle, cursor: onOpenItem === undefined ? 'default' : 'pointer' }}
                  >
                    <span style={{ flex: 1, textAlign: 'left', wordBreak: 'break-word' }}>{entry.title}</span>
                    <span style={attachmentMetaStyle}>{itemTypeLabel(t, entry.itemType)}</span>
                  </button>
                ))}
              </Block>
            )}

            {isBibliographicItem(detail.itemType) && (
              <BibliographyBlock key={detail.key} t={t} detail={detail} open={sections.bib} onToggle={() => toggle('bib')} />
            )}
          </div>

          <span
            aria-hidden="true"
            title={t('detail.resize')}
            {...box.resizeProps}
            style={resizeHandleStyle}
          >
            <ResizeIcon />
          </span>
        </div>
      )}

      <FulltextScope
        t={t}
        open={fulltextOpen && hasFulltext}
        attachmentTitle={attachmentTitle}
        detail={detail}
        outline={outline}
        anchorRef={rootRef}
        triggerRef={insertTriggerRef}
        initialMode={fulltextMode}
        onClose={() => setFulltextOpen(false)}
        onConfirm={(range, scope, quote, target) => {
          const fulltext = detail.fulltext
          if (fulltext?.revision === undefined || fulltext.attachmentKey !== currentAttachmentKey) return
          onInsertFulltext({
            key: detail.key,
            title: detail.title,
            attachmentKey: fulltext.attachmentKey,
            attachmentTitle,
            revision: fulltext.revision,
            evidence: makeEvidence(detail.key, {
              attachmentKey: fulltext.attachmentKey,
              page: target?.kind === 'page' ? target.page : undefined,
              chapterStart: target?.kind === 'page' || undefined,
              anchor: target?.kind === 'anchor' ? target.id : undefined,
              quote: quote || undefined,
            }),
            range,
          }, scope)
          setFulltextOpen(false)
        }}
      />
    </div>
  )
}

/**
 * 区块开合箭头：展开时朝下，收起时朝右（`rotate(-90deg)`）。
 *
 * 用 SVG 而不是 `▾` / `▸` 文字：字形在不同字体下大小与基线都不一样，和右边的
 * 计数、加号排在一行会高低不齐；旋转动画也只有图形元素做得干净。
 */
function ChevronIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{
        flexShrink: 0,
        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 140ms ease',
      }}
    >
      <path d="M4 6.25 8 10.25 12 6.25" />
    </svg>
  )
}

/** 图钉：帽 + 针。钉住时实心（`ACCENT`），未钉住只描边。 */
function PinIcon({ filled }: { filled: boolean }): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M4.5 1.6h3l-.55 3.05L8.5 6.2v1.15h-5V6.2L5.05 4.65z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
      <path d="M6 7.55v2.9" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
    </svg>
  )
}

/** 右下角的缩放把手：两条 45° 短线。 */
function ResizeIcon(): ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M4.2 9 9 4.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M7.4 9 9 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 覆盖整个阅读区的透明层：只提供测量基准和浮层的层叠上下文。
 *
 * `zIndex` 与目录浮层一致抬到 300 —— 浮层画到右栏外面（聊天区）时，得压过聊天
 * 消息与粘性输入区；又不该高过宿主的对话框（那类通常 ≥ 1000）。这一层不画东西、
 * `pointerEvents:none`，抬高层级不会挡任何点击。
 */
const rootStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 300,
  pointerEvents: 'none',
} as const

/** 左上角按钮行：目录（8）单独在 OutlinePanel，这里从 34 起按内容排布。 */
const rowStyle = {
  position: 'absolute',
  pointerEvents: 'none',
  top: 4,
  left: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  height: 22,
} as const

const triggerStyle = {
  position: 'relative',
  flexShrink: 0,
  pointerEvents: 'auto',
  width: 22,
  height: 22,
  padding: 0,
  fontSize: 13,
  fontStyle: 'italic',
  fontWeight: 700,
  lineHeight: 1,
  borderRadius: '50%',
  border: '1px solid rgba(127,127,127,0.4)',
  background: 'Canvas',
  color: 'CanvasText',
  cursor: 'pointer',
  boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
  zIndex: 21,
} as const

/** 初始宽度；比原来浮在正文里的 320 宽一点，长标题与元数据少折行。 */
const PANEL_WIDTH = 360
const PANEL_MIN_WIDTH = 280
const PANEL_MIN_HEIGHT = 240

/**
 * 面板本体：`fixed`，几何由 `floatingBox` 注入（`...box.style` 覆盖在最后）。
 *
 * 纵向 flex：标题栏固定、区块区滚动，右下角把手才不会被内容带着跑。
 */
const panelStyle = {
  position: 'fixed',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  padding: '8px 10px 10px',
  borderRadius: 8,
  border: '1px solid rgba(127,127,127,0.32)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 10px 30px rgba(0,0,0,0.3)',
  fontSize: 12,
  lineHeight: 1.6,
  overscrollBehavior: 'contain',
  zIndex: 300,
} as const

/** 区块区：自己滚，别把标题栏与把手一起卷走。 */
const bodyStyle = {
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  overscrollBehavior: 'contain',
  /** 给右下角的缩放把手让位。 */
  paddingBottom: 6,
} as const

/** 标题栏兼拖动把手。 */
const panelHeaderStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  flexShrink: 0,
  paddingBottom: 6,
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  cursor: 'move',
  userSelect: 'none',
  touchAction: 'none',
} as const

const pinStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 20,
  height: 20,
  marginTop: -2,
  padding: 0,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  transition: 'background-color 120ms ease',
} as const

/** 缩放把手：贴在右下角，盖在滚动区之上。 */
const resizeHandleStyle = {
  position: 'absolute',
  right: 2,
  bottom: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  color: 'rgba(127,127,127,0.7)',
  cursor: 'nwse-resize',
  touchAction: 'none',
  userSelect: 'none',
} as const

const panelTitleStyle = {
  flex: 1,
  minWidth: 0,
  fontWeight: 700,
  fontSize: 12.5,
  lineHeight: 1.45,
  wordBreak: 'break-word',
} as const

/**
 * 分裂按钮（加入对话 ▾）在 `InsertMenu` 里自带样式：这一行只剩 `i` 与它两个控件，
 * 宽度交给 `rowRef` 的 ResizeObserver 量出来给工具条让位，不用在这里写死。
 */

const blockStyle = {
  borderBottom: '1px solid rgba(127,127,127,0.18)',
  padding: '4px 0',
} as const

const blockHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  flex: 1,
  minWidth: 0,
  padding: '3px 0',
  fontSize: 12.5,
  fontWeight: 700,
  color: ACCENT,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
} as const

const blockHeaderRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
} as const

const bibliographyActionStyle = {
  flexShrink: 0,
  padding: '2px 5px',
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.45)',
  background: 'Canvas',
  color: 'CanvasText',
  fontSize: 11,
  whiteSpace: 'nowrap',
} as const

/** 标题行上的图标按钮（当前只有「笔记」的加号 / 取消）。 */
const blockActionStyle = {
  flexShrink: 0,
  width: 16,
  height: 16,
  padding: 0,
  marginRight: 2,
  borderRadius: 4,
  border: '1px solid rgba(127,127,127,0.45)',
  background: 'transparent',
  color: ACCENT,
  fontSize: 12,
  lineHeight: 1,
  cursor: 'pointer',
} as const

/**
 * 区块标题行最右的开合按钮。
 *
 * 20×20 的点击区比箭头本身大，贴着浮层右内边距放（`marginRight: -4` 抵掉面板
 * 的 10px padding 里那点空隙，视觉上和其他行的内容右缘对齐）。颜色跟标题一致，
 * 常态压到 0.6 不抢标题；hover 底色来自 `.dsh-zp-section-toggle`。
 */
const blockToggleStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 20,
  height: 20,
  marginRight: -4,
  padding: 0,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: ACCENT,
  opacity: 0.6,
  cursor: 'pointer',
} as const

const blockHintStyle = {
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 400,
  opacity: 0.65,
} as const

const blockBodyStyle = {
  padding: '2px 0 4px',
} as const

const metaRowStyle = {
  display: 'flex',
  gap: 6,
  marginBottom: 2,
  lineHeight: 1.55,
} as const

const metaLabelStyle = {
  flexShrink: 0,
  marginRight: 4,
  whiteSpace: 'nowrap',
  opacity: 0.6,
} as const

/**
 * 值那一侧：长 URL / DOI 必须能在任意位置断行，否则会把浮层撑宽。
 *
 * 多行值（「其他」里剩下的 extra 行）要保留换行 —— 那是「键: 值」一行一条的
 * 结构，折成一串逗号分隔后就没法读了。
 */
function metaValueStyle(value: ReactNode): CSSProperties {
  const multiline = typeof value === 'string' && value.includes('\n')
  return { wordBreak: 'break-word', whiteSpace: multiline ? 'pre-wrap' : undefined }
}

/** 期刊指标卡：浅底容器，把它从上面的元数据行里拎出来。 */
const metricCardStyle = {
  background: 'rgba(127,127,127,0.09)',
  borderRadius: 8,
  padding: '8px 10px 7px',
  margin: '7px 0 5px',
} as const

/** 卡内小标题：11px 足够，别跟元数据 label 抢层级。 */
const metricCardTitleStyle = {
  fontSize: 11,
  opacity: 0.55,
  marginBottom: 5,
} as const

/** 胶囊组：横向排开，浮层拖窄时折行。 */
const chipGroupStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 5,
  alignItems: 'center',
} as const

/**
 * 一枚胶囊。浅底卡已经有底色，胶囊用纯 `Canvas` 提亮一层，形成「卡中有物」的
 * 层次；描边 0.3 透明度，别抢过卡片本身。
 */
const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '1px 7px',
  border: '1px solid rgba(127,127,127,0.3)',
  borderRadius: 5,
  background: 'Canvas',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'nowrap',
} as const

/** 胶囊里的小标签（IF / JCR / 中科院）。 */
const chipTagStyle = { opacity: 0.55 } as const

/** 胶囊里的数值。 */
const chipValueStyle = { fontWeight: 500 } as const

/** 预警项单独用橙色：它说的是投稿风险，不是档次。 */
const chipWarnStyle = { fontWeight: 500, color: TREE_ORANGE } as const

/** 卡内操作行：外部站点 + 重查 + 说明图标。 */
const metricActionRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  marginTop: 7,
} as const

/** ⓘ 按钮：纯图标，去掉按钮默认外观；透明度由调用处按展开状态覆盖。 */
const infoIconStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'inherit',
  cursor: 'pointer',
} as const

/** 展开后的来源说明：比正文再弱一级，但要保证能读清、能选中复制。 */
const sourceNoteStyle = {
  marginTop: 6,
  fontSize: 11.5,
  lineHeight: 1.55,
  opacity: 0.72,
} as const

/** 灰色小字：用于「未配置密钥」这类提示，不抢指标本身的注意力。 */
const mutedHintStyle = {
  fontSize: 11.5,
  opacity: 0.7,
  lineHeight: 1.5,
} as const

/** 橙色小字：查询失败（多半是密钥错），需要用户动手。用色板里的橙，不另起炉灶。 */
const warnHintStyle = {
  fontSize: 11.5,
  color: TREE_ORANGE,
  lineHeight: 1.5,
} as const

/**
 * 站点按钮做成文字链接形态，刻意不用 `SOFT_BUTTON_STYLE`。
 *
 * 这一行是「离开插件」的出口，不是浮层里的操作按钮；做成按钮会跟「加入对话」
 * 抢视觉权重，也容易被误读成「点了就在面板里查」。下划线 + 外链箭头才是
 * 「跳出去」的通用符号。
 */
const journalLinkStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  padding: 0,
  border: 'none',
  background: 'none',
  color: ACCENT,
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 'inherit',
  lineHeight: 1.4,
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: 2,
} as const

const paragraphStyle = {
  margin: 0,
  opacity: 0.88,
  fontSize: 12,
} as const

const attachmentRowStyle = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  width: '100%',
  padding: '4px 0',
  fontSize: 12,
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid rgba(127,127,127,0.14)',
  color: 'inherit',
  cursor: 'pointer',
} as const

const attachmentMetaStyle = {
  flexShrink: 0,
  fontSize: 10.5,
  opacity: 0.55,
} as const

/** 标签块：横向胶囊，浮层拖窄时折行（与期刊指标卡同一套形态）。 */
const tagRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  padding: '2px 0',
} as const

const tagChipStyle = {
  padding: '1px 7px',
  border: '1px solid rgba(127,127,127,0.3)',
  borderRadius: 5,
  fontSize: 12,
  lineHeight: 1.5,
  wordBreak: 'break-word',
} as const

/** 相关条目：一行一条，点开就是那条的详情 tab。 */
const relatedRowStyle = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  width: '100%',
  padding: '4px 0',
  fontSize: 12,
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid rgba(127,127,127,0.14)',
  color: 'inherit',
  textAlign: 'left',
} as const

/**
 * 说明图标（ⓘ）：圈里一个 i，用细描边跟其它图标同一套笔画。
 *
 * 说明走原生 `title`，不做自绘浮层 —— 这段文字是「数据从哪来、要不要配密钥」
 * 这种一次性告知，原生 tooltip 够用，而在这个已经有三种浮层的面板里再叠一层
 * 只会互相抢层级。
 */
function InfoIcon(): ReactElement {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 7.3v3.9" strokeLinecap="round" />
      <circle cx="8" cy="4.8" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}
