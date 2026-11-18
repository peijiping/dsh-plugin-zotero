/**
 * 文本渲染器：独立笔记 / Markdown 页面、PDF 全文或其它附件的纯文本兜底视图。
 *
 * PDF.js 不可用（非 PDF 附件、浏览器拒绝渲染、文件缺失）时由注册表回退到这里。
 * 标注只有 `range`（全文区间）能落到文字上；点标注列表仍会滚动定位并闪烁。
 * 该渲染器没有分页与缩放，工具条据 `capabilities` 自动隐藏对应控件。
 *
 * 目录：笔记按 HTML 标题（`<h1>`–`<h6>`，或写成 Markdown 的 `<p># 标题</p>`）解析，
 * 纯文本按 `#` 标题行解析，都上报给左上角那一份统一目录浮层。笔记用元素锚点定位，
 * 纯文本用字符偏移定位——后者不能往正文里插锚点，否则按同样偏移切分的标注会错位。
 */

import {
  Fragment,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react'

import type { ZoteroAnnotation } from '../../zotero/types'
import { buildSegments, type Segment } from '../annotationRuns'
import type { Translate } from '../locales'
import { NOTE_CSS } from '../NoteList'
import { AnnotationCommentIcon } from './AnnotationCommentIcon'
import { OUTLINE_ANCHOR_ATTR, offsetIndexAt, parseHtmlHeadings, parseMarkdownHeadings } from './outline'
import { SelectionBar } from './SelectionBar'
import { TranslationCard, isInsideTranslation } from './TranslationCard'
import { useTranslation } from './useTranslation'
import type { DocumentRendererProps, OutlineTarget } from './types'

const FLASH_CLASS = 'dsh-zotero-ann-flash'
const FLASH_MS = 1200
const OUTLINE_FLASH_CLASS = 'dsh-zp-outline-flash'
/** 目录跟随的判定线：标题落到视口顶端往下这么多，就算「读到这里了」。 */
const ACTIVE_LINE = 12
/** 跳转后滚动停稳多久恢复跟随（平滑滚动期间不抢用户点中的那一条）。 */
const JUMP_QUIET_MS = 180
const TEXT_TYPES = new Set(['highlight', 'underline'])

/** 把视口里的某个 y 坐标滚到滚动容器顶部偏下一点的位置。 */
function scrollBoxTo(box: HTMLElement, viewportTop: number): void {
  const boxTop = box.getBoundingClientRect().top
  box.scrollTo({
    top: Math.max(0, box.scrollTop + viewportTop - boxTop - 8),
    behavior: 'smooth',
  })
}

/**
 * 全文字符偏移 → 文字节点内偏移。
 *
 * 正文被标注切片包成 `<mark>` / `<span>`，但 `textContent` 与 `fulltext.content`
 * 完全一致，所以按文档顺序累加文字节点长度就能换回去。只遍历 `contentRef` 这一层，
 * 不含「全文索引兜底」等提示文字。
 */
function textNodeAtOffset(root: HTMLElement, offset: number): { node: Text; local: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let consumed = 0
  let current = walker.nextNode() as Text | null
  while (current !== null) {
    const length = current.nodeValue?.length ?? 0
    if (offset <= consumed + length) return { node: current, local: offset - consumed }
    consumed += length
    current = walker.nextNode() as Text | null
  }
  return null
}

/**
 * 段首便签角标。用 absolute + 零尺寸容器贴在行首左上角：既压住高亮的起点，
 * 又不占字符宽度、不产生文本节点——`textNodeAtOffset` / 目录偏移按 textContent
 * 数字符，插一个带文字的元素会让后面所有标注与标题整体错位。
 */
const badgeStyle: CSSProperties = {
  position: 'absolute',
  left: -3,
  top: -9,
  pointerEvents: 'none',
  zIndex: 1,
}

const AnnotatedText = memo(function AnnotatedText({ segments }: { segments: Segment[] }): ReactElement {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return <Fragment key={index}>{segment.text}</Fragment>
        const style: CSSProperties = {}
        if (segment.background !== null) style.background = segment.background
        if (segment.underline !== null) {
          style.textDecorationLine = 'underline'
          style.textDecorationColor = segment.underline
          style.textDecorationThickness = 2
          style.textUnderlineOffset = 2
        }
        // 角标相对段首定位，段本身要成为包含块。
        if (segment.badge !== null) style.position = 'relative'
        const owners = segment.owners.join(' ')
        const badge = segment.badge !== null && (
          <span className="dsh-zotero-ann-badge" style={badgeStyle}>
            <AnnotationCommentIcon color={segment.badge} />
          </span>
        )
        return segment.background !== null ? (
          <mark key={index} className="dsh-zotero-ann" data-ann={owners} style={style}>
            {badge}{segment.text}
          </mark>
        ) : (
          <span key={index} className="dsh-zotero-ann" data-ann={owners} style={style}>
            {badge}{segment.text}
          </span>
        )
      })}
    </>
  )
})

export function TextViewer({
  t,
  detail,
  annotations,
  viewerRef,
  onReady,
  onInsertExcerpt,
  onInsertTranslation,
  onOutlineChange,
  onOutlineActiveChange,
}: DocumentRendererProps): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 纯文本正文的内层：字符偏移只在这层里数，排除上下两条提示文字。 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  const flashTimer = useRef<number | null>(null)
  const outlineTimer = useRef<number | null>(null)
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  /** 划词翻译浮层。这里是滚动容器本身，浮层坐标按内容算，随正文一起滚。 */
  const translation = useTranslation(t)

  const selfNote = detail.itemType === 'note'
    ? detail.notes.find((note) => note.key === detail.key) ?? null
    : null
  const fulltext = detail.fulltext

  const marked = useMemo(
    () => (selfNote === null ? annotations.filter((annotation) => TEXT_TYPES.has(annotation.type)) : []),
    [annotations, selfNote],
  )
  const segments = useMemo(
    () => buildSegments(fulltext?.content ?? '', marked),
    [fulltext, marked],
  )

  /** 笔记 HTML 加好标题锚点后再交给 `dangerouslySetInnerHTML`。 */
  const noteParsed = useMemo(
    () => selfNote === null ? null : parseHtmlHeadings(selfNote.html),
    [selfNote],
  )
  const textOutline = useMemo(
    () => fulltext === null ? [] : parseMarkdownHeadings(fulltext.content),
    [fulltext],
  )

  /** 目录回调走 ref：上报 effect 不该因父级重渲染换了回调身份就重跑。 */
  const outlineRef = useRef(onOutlineChange)
  outlineRef.current = onOutlineChange
  /** 目录跟随的上报通道：同理走 ref，滚动监听只该挂一次。 */
  const activeRef = useRef(onOutlineActiveChange)
  activeRef.current = onOutlineActiveChange
  /** 上一次报出去的下标：只在变化时上报，滚动时不逐帧刷父级。 */
  const activeIndexRef = useRef<number | null>(null)
  /** 跳转后的静默窗口：平滑滚动这几百毫秒里别把用户点中的那一条改掉。 */
  const jumpQuietRef = useRef(false)
  const jumpTimerRef = useRef<number | null>(null)
  /** 停稳后补判一次；跟随 effect 卸掉时置空。 */
  const outlineTickRef = useRef<(() => void) | null>(null)

  /** 重新起算静默窗口（滚动还在继续就一直往后推）。 */
  function rearmJumpQuiet(): void {
    if (jumpTimerRef.current !== null) window.clearTimeout(jumpTimerRef.current)
    jumpTimerRef.current = window.setTimeout(() => {
      jumpTimerRef.current = null
      jumpQuietRef.current = false
      outlineTickRef.current?.()
    }, JUMP_QUIET_MS)
  }

  function beginJumpQuiet(): void {
    jumpQuietRef.current = true
    rearmJumpQuiet()
  }

  useEffect(() => {
    outlineRef.current?.(noteParsed?.items ?? textOutline)
  }, [noteParsed, textOutline])

  /**
   * 目录反向跟随（滚动 → 高亮）：视口顶端之上最后一个标题就是「正在读的那一节」。
   *
   * 位置在内容变化时量一次（标题的 y 坐标缓存成数组），滚动帧里只做一次比较 ——
   * 每帧都调 `getBoundingClientRect` 会在滚动时反复强制同步布局。
   * 笔记按锚点元素量，纯文本按字符偏移找到文字节点再量（正文不能被插锚点，
   * 否则按同样偏移切分的标注会错位），两路的结论都收敛成「下标」。
   */
  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const items = noteParsed?.items ?? textOutline
    // 目录换了（换文档 / 改了笔记正文）：先把上一条结论作废，下面会重新报一次。
    activeIndexRef.current = null
    if (items.length === 0) {
      activeRef.current?.(null)
      return
    }

    let tops: number[] | null = null
    let frame = 0

    const measure = (): number[] | null => {
      const boxRect = box.getBoundingClientRect()
      const scrolled = box.scrollTop

      if (noteParsed !== null) {
        const elements = Array.from(box.querySelectorAll<HTMLElement>(`[${OUTLINE_ANCHOR_ATTR}]`))
        // 条目与锚点一一对应（`parseHtmlHeadings` 按序号打属性）；对不上就是还没提交布局。
        if (elements.length !== items.length) return null
        return elements.map((element) => element.getBoundingClientRect().top - boxRect.top + scrolled)
      }

      const root = contentRef.current
      if (root === null) return null
      const nodes: { node: Text; start: number }[] = []
      let total = 0
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let current = walker.nextNode() as Text | null
      while (current !== null) {
        nodes.push({ node: current, start: total })
        total += current.nodeValue?.length ?? 0
        current = walker.nextNode() as Text | null
      }
      if (nodes.length === 0) return null

      const out: number[] = []
      let cursor = 0
      for (const item of items) {
        const offset = item.target?.kind === 'anchor' ? Number.parseInt(item.target.id, 10) : Number.NaN
        // 偏移是升序的（按正文顺序解析），从上一个命中的节点往后找就够了。
        while (cursor + 1 < nodes.length && nodes[cursor + 1].start <= offset) cursor += 1
        const hit = nodes[cursor]
        if (!Number.isFinite(offset) || hit === undefined) {
          out.push(Number.NaN)
          continue
        }
        const range = document.createRange()
        range.setStart(hit.node, Math.min(Math.max(offset - hit.start, 0), hit.node.nodeValue?.length ?? 0))
        range.collapse(true)
        out.push(range.getBoundingClientRect().top - boxRect.top + scrolled)
      }
      return out
    }

    const tick = (): void => {
      frame = 0
      if (jumpQuietRef.current) return
      const measured = tops ?? (tops = measure())
      if (measured === null) return
      // 文档顶端还没到第一个标题时也算第一节在读（与 Zotero 大纲的行为一致）。
      const index = offsetIndexAt(measured, box.scrollTop + ACTIVE_LINE) ?? 0
      if (activeIndexRef.current === index) return
      activeIndexRef.current = index
      activeRef.current?.(index)
    }
    outlineTickRef.current = tick

    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(tick)
    }
    const onScroll = (): void => {
      // 跳转引起的滚动：一直把静默窗口往后推，停稳 JUMP_QUIET_MS 后才恢复跟随。
      if (jumpQuietRef.current) rearmJumpQuiet()
      schedule()
    }

    box.addEventListener('scroll', onScroll, { passive: true })
    // 宽度变了会重排（图片、缩放、分栏），缓存的 y 坐标要重新量。
    const observer = new ResizeObserver(() => {
      tops = null
      schedule()
    })
    observer.observe(box)
    // 图片加载完高度会变（笔记里的图是 data: 内联的，加载时机不好预判）。
    const onLoad = (): void => {
      tops = null
      schedule()
    }
    box.addEventListener('load', onLoad, true)
    tick()

    return () => {
      box.removeEventListener('scroll', onScroll)
      box.removeEventListener('load', onLoad, true)
      observer.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
      outlineTickRef.current = null
    }
  }, [noteParsed, textOutline])

  useEffect(() => {
    const timer = window.setTimeout(onReady, 0)
    return () => window.clearTimeout(timer)
  }, [onReady, detail.key, fulltext?.attachmentKey])

  useEffect(() => () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current)
    if (jumpTimerRef.current !== null) window.clearTimeout(jumpTimerRef.current)
  }, [])

  function locate(annotationKey: string): boolean {
    const box = boxRef.current
    if (box === null) return false
    const target = box.querySelector<HTMLElement>(`[data-ann~="${CSS.escape(annotationKey)}"]`)
    if (target === null) return false
    const boxRect = box.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    box.scrollTo({
      top: box.scrollTop + rect.top - boxRect.top - box.clientHeight / 2 + rect.height / 2,
      behavior: 'smooth',
    })
    target.classList.remove(FLASH_CLASS)
    void target.offsetWidth
    target.classList.add(FLASH_CLASS)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      target.classList.remove(FLASH_CLASS)
      flashTimer.current = null
    }, FLASH_MS)
    return true
  }

  function flashHeading(element: HTMLElement): void {
    if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current)
    element.classList.remove(OUTLINE_FLASH_CLASS)
    void element.offsetWidth
    element.classList.add(OUTLINE_FLASH_CLASS)
    outlineTimer.current = window.setTimeout(() => {
      element.classList.remove(OUTLINE_FLASH_CLASS)
      outlineTimer.current = null
    }, FLASH_MS)
  }

  function goToOutline(target: OutlineTarget | null): void {
    const box = boxRef.current
    if (target === null || target.kind !== 'anchor' || box === null) return
    beginJumpQuiet()

    // 笔记 / HTML：id 是标题锚点的序号，由 parseHtmlHeadings 打进正文。
    if (noteParsed !== null) {
      // 锚点都是十进制序号，先校验再拼属性选择器（CSS.escape 会把首位数字转义掉）。
      if (!/^\d+$/u.test(target.id)) return
      const element = box.querySelector<HTMLElement>(`[${OUTLINE_ANCHOR_ATTR}="${target.id}"]`)
      if (element === null) return
      scrollBoxTo(box, element.getBoundingClientRect().top)
      flashHeading(element)
      return
    }

    // 纯文本：id 是标题行在全文里的字符偏移，用 Range 找回那一行再滚过去。
    const offset = Number.parseInt(target.id, 10)
    if (!Number.isFinite(offset) || contentRef.current === null) return
    const hit = textNodeAtOffset(contentRef.current, offset)
    if (hit === null) return
    const range = document.createRange()
    range.setStart(hit.node, Math.min(Math.max(hit.local, 0), hit.node.nodeValue?.length ?? 0))
    range.collapse(true)
    scrollBoxTo(box, range.getBoundingClientRect().top)
  }

  useImperativeHandle(viewerRef, () => ({
    locate,
    currentPage: () => 1,
    goToPage: () => undefined,
    goToOutline,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    setZoom: () => undefined,
    fitToWidth: () => undefined,
  }))

  function handleMouseUp(): void {
    const sel = window.getSelection()
    const box = boxRef.current
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || box === null) {
      setSelection(null)
      return
    }
    const text = sel.toString().trim()
    const range = sel.getRangeAt(0)
    // 在译文浮层里拖选复制不算正文选区，否则又会弹一条工具条。
    if (text === '' || !box.contains(range.commonAncestorContainer) || isInsideTranslation(range.commonAncestorContainer)) {
      setSelection(null)
      return
    }
    const rect = range.getBoundingClientRect()
    const boxRect = box.getBoundingClientRect()
    setSelection({
      text,
      x: rect.left - boxRect.left + box.scrollLeft + rect.width / 2,
      y: rect.top - boxRect.top + box.scrollTop,
    })
  }

  const hasContent = selfNote !== null || fulltext !== null

  return (
    <div ref={boxRef} onMouseUp={handleMouseUp} style={rootStyle}>
      <style>{TEXT_CSS + NOTE_CSS}</style>
      {!hasContent ? (
        <p style={emptyStyle}>{t('detail.noFulltext')}</p>
      ) : selfNote !== null ? (
        <div style={noteStyle}>
          <div className="dsh-zotero-note" dangerouslySetInnerHTML={{ __html: noteParsed?.html ?? selfNote.html }} />
          {selfNote.truncated && <div style={truncatedStyle}>{t('detail.noteTruncated')}</div>}
        </div>
      ) : (
        <div style={textStyle}>
          {fulltext?.fallback === true && (
            <p style={fallbackStyle}>{t('detail.fulltextFallback')}</p>
          )}
          <div ref={contentRef}>
            <AnnotatedText segments={segments} />
          </div>
          {fulltext?.truncated === true && (
            <div style={truncatedStyle}>{t('detail.fulltextTruncated')}</div>
          )}
        </div>
      )}
      {selection !== null && (
        <SelectionBar
          t={t}
          text={selection.text}
          x={selection.x}
          y={selection.y}
          onInsert={onInsertExcerpt}
          onDismiss={() => setSelection(null)}
          translate={{ onTranslate: translation.open }}
        />
      )}
      {translation.view !== null && (
        <TranslationCard
          t={t}
          view={translation.view}
          // 浮层挂在滚动容器里，可放范围要按内容高度算，否则贴底的选区会被夹回去。
          bounds={{
            width: boxRef.current?.clientWidth ?? 320,
            height: Math.max(boxRef.current?.clientHeight ?? 400, boxRef.current?.scrollHeight ?? 400),
          }}
          engine={translation.engine}
          onEngineChange={translation.setEngine}
          onClose={translation.close}
          onRetry={translation.retry}
          onInsert={onInsertTranslation}
        />
      )}
    </div>
  )
}

const rootStyle = {
  position: 'relative',
  height: '100%',
  minHeight: 0,
  overflow: 'auto',
  padding: '10px 14px 14px',
  overscrollBehavior: 'contain',
} as const

const baseTextStyle = {
  fontSize: 12.5,
  lineHeight: 1.7,
  opacity: 0.9,
} as const

const textStyle = { ...baseTextStyle, whiteSpace: 'pre-wrap' } as const

const noteStyle = { ...baseTextStyle, lineHeight: 1.75, overflowWrap: 'break-word' } as const

const emptyStyle = {
  margin: 0,
  padding: '14px 2px',
  fontSize: 12.5,
  opacity: 0.6,
} as const

const truncatedStyle = { marginTop: 6, opacity: 0.6 } as const

const fallbackStyle = { margin: '0 0 6px', opacity: 0.6, fontSize: 12 } as const

const TEXT_CSS = `
.dsh-zotero-ann { color: inherit; padding: 0; border-radius: 2px; }
.dsh-zotero-ann-flash {
  outline: 2px solid transparent;
  outline-offset: 1px;
  animation: dsh-zotero-ann-flash 1.1s ease-in-out 1;
}
@keyframes dsh-zotero-ann-flash {
  0%, 100% { outline-color: transparent; }
  20%, 80% { outline-color: rgba(80,140,255,0.95); }
}
.dsh-zp-outline-flash {
  border-radius: 3px;
  outline: 2px solid transparent;
  outline-offset: 2px;
  animation: dsh-zp-outline-flash 1.1s ease-in-out 1;
}
@keyframes dsh-zp-outline-flash {
  0%, 100% { outline-color: transparent; }
  20%, 80% { outline-color: rgba(80,140,255,0.95); }
}
`
