/**
 * 左上角的悬浮信息菜单：文献信息 / 摘要 / 标注 / 笔记 / 附件 / 参考文献。
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

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { AnnotationList } from './AnnotationList'
import type { AnnotationFilter } from './annotationRuns'
import { useDismiss } from './dismiss'
import { makeEvidence } from './evidence'
import type { AttachmentCitation } from './cite'
import { FulltextScope, type FulltextMode } from './fulltextScope'
import { InsertMenu } from './InsertMenu'
import type { DocumentOutlineItem } from './viewer/types'
import { useFloatingBox } from './floatingBox'
import { itemTypeLabel } from './itemType'
import { tpl, type Translate } from './locales'
import { NoteList } from './NoteList'
import { fetchJournalRank, openJournalUrl, type JournalRank } from './api'
import { extraChips, rankChips, readJournalMetrics, type MetricChip } from './journalMetrics'
import { journalLinks } from './journalLinks'
import { showToast } from './paneStore'
import { ACCENT, TREE_ORANGE } from './styles'
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
  /** 量出悬浮按钮行宽度，供工具条的 `paddingLeft` 让位（语言/文案会改变宽度）。 */
  onRowWidth?(width: number): void
}

interface BlockProps {
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

function Block({ label, hint, open, onToggle, action, children }: BlockProps): ReactElement {
  return (
    <section style={blockStyle}>
      <div style={blockHeaderRowStyle}>
        <button type="button" onClick={onToggle} aria-expanded={open} style={blockHeaderStyle}>
          <span style={blockChevronStyle}>{open ? '▾' : '▸'}</span>
          <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
          {hint !== undefined && <span style={blockHintStyle}>{hint}</span>}
        </button>
        {action}
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
type RemoteRank =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; rank: JournalRank }
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

/** 去掉 CSL HTML 标签，只留可见文本。 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim()
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
  onLocateAnnotation,
  onInsertAnnotation,
  onInsertNote,
  onChanged,
  annotationFilter,
  onAnnotationFilterChange,
  onScreenshot,
  screenshotAvailable,
  screenshotReason,
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
   * 远程查询：仅在「浮层打开 + 库里没有指标 + 有刊名」时发起。
   *
   * 三个条件缺一不可 —— 收起浮层不该消耗查询额度；用户库里已有数据时也不该用
   * 第三方结果盖掉他自己核对过的值（`extra` 优先，远程只做兜底）。
   */
  const [remote, setRemote] = useState<RemoteRank>({ kind: 'idle' })

  /**
   * 「重查」计数：点一下 +1，让下面那个 effect 重跑。
   *
   * 不另加 force 参数去绕过 Host 的 6 小时缓存 —— 缓存命中是即时的，而真正
   * 需要远端新数据的场景是「刚在设置页填好密钥」，那种情况 effect 重跑本身
   * 就会重新读配置（`getSettings()` 是 volatile 的），不需要重启 DSH。
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
    if (!open || metrics !== null || journalName === '') {
      setRemote({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    setRemote({ kind: 'loading' })
    void fetchJournalRank(journalName, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return
        if (outcome.status === 'ok') setRemote({ kind: 'ok', rank: outcome.rank })
        else if (outcome.status === 'no_key') setRemote({ kind: 'no_key' })
        else if (outcome.status === 'miss') setRemote({ kind: 'miss' })
        else setRemote({ kind: 'failed', message: outcome.message })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setRemote({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => { controller.abort() }
  }, [open, metrics, journalName, refreshNonce])

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
  if (detail.year !== '') metaRows.push({ label: t('detail.year'), value: detail.year })
  if (detail.publicationTitle !== '') metaRows.push({ label: t('detail.source'), value: detail.publicationTitle })

  /*
   * 期刊指标卡：胶囊 + 一行操作。
   *
   * 为什么单独成块：这些数字评价的是**期刊**，不是这篇文献，跟上面的类型 / 作者 /
   * 年份不是一类信息。浅底容器把它从元数据里拎出来，值改用胶囊 —— 形态本身就在
   * 说「这是另一类东西」，而不是靠颜色暗示（绿色红色会被读成「好刊 / 烂刊」）。
   *
   * 来源优先级：条目 extra（用户自己库里、可能核对过）> easyScholar 远程查询。
   */
  const chips: MetricChip[] = metrics !== null
    ? extraChips(metrics)
    : remote.kind === 'ok' ? rankChips(remote.rank) : []

  // 没有指标时用一句话说明原因：没密钥 / 查不到 / 出错。查到了就只显示胶囊。
  let note: string | null = null
  let noteWarn = false
  if (metrics === null && journalName !== '') {
    if (remote.kind === 'loading') note = t('detail.querying')
    else if (remote.kind === 'no_key') note = t('detail.noKeyHint')
    else if (remote.kind === 'miss') note = t('detail.missHint')
    else if (remote.kind === 'failed') {
      note = remote.message
      noteWarn = true
    }
  }

  const showRetry = metrics === null && journalName !== '' && remote.kind !== 'loading'
  if (chips.length > 0 || note !== null || journalQueryLinks.length > 0) {
    // ⓘ 的说明随来源变化：本地读的和第三方查的，责任完全不同。
    const sourceHint = metrics !== null
      ? t('detail.metricsSourceExtra')
      : t('detail.metricsSourceRemote')
    metaRows.push({
      block: (
        <div style={metricCardStyle}>
          <div style={metricCardTitleStyle}>{t('detail.journalMetrics')}</div>
          {(chips.length > 0 || note !== null) && (
            <div style={chipGroupStyle}>
              {chips.map((chip, index) => (
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
                {remote.kind === 'idle' ? t('detail.queryNow') : t('detail.queryRetry')}
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
  if (detail.doi !== '') metaRows.push({ label: t('detail.doi'), value: detail.doi })
  if (detail.url !== '') metaRows.push({ label: t('detail.url'), value: detail.url })
  if (detail.collectionNames.length > 0) {
    metaRows.push({ label: t('detail.collections'), value: detail.collectionNames.join(' / ') })
  }
  if (detail.tags.length > 0) metaRows.push({ label: t('detail.tags'), value: detail.tags.join('、') })

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
            <Block label={t('detail.metadata')} open={sections.metadata} onToggle={() => toggle('metadata')}>
              {metaRows.map((row, index) => (
                'block' in row
                  ? <div key={`block-${String(index)}`}>{row.block}</div>
                  : (
                    <div key={row.label} style={metaRowStyle}>
                      <span style={metaLabelStyle}>{row.label}</span>
                      <span style={{ wordBreak: 'break-word' }}>{row.value}</span>
                    </div>
                  )
              ))}
            </Block>

            {detail.abstract !== '' && (
              <Block
                label={t('detail.abstract')}
                open={sections.abstract}
                onToggle={() => toggle('abstract')}
              >
                <p style={paragraphStyle}>{detail.abstract}</p>
              </Block>
            )}

            {detail.annotations.length > 0 && (
              <Block
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

            {detail.bib !== null && (
              <Block label={t('detail.bibTitle')} open={sections.bib} onToggle={() => toggle('bib')}>
                <p style={paragraphStyle}>{stripTags(detail.bib)}</p>
              </Block>
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

const blockChevronStyle = {
  flexShrink: 0,
  fontSize: 10,
  opacity: 0.8,
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
