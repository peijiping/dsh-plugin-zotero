/**
 * 笔记正文的内联编辑器（contenteditable）。
 *
 * 目标只有一个：像 Zotero 一样，**阅读和编辑是同一个框**——正文摊开就能改，
 * 不再有「编辑」按钮把 HTML 源码塞进 textarea。
 *
 * 三条设计约束：
 *
 * 1. **正文是 HTML，不是 Markdown**。Zotero 存的就是 `data.note` 里的 HTML，引文
 *    （`class="citation"` / `data-citation`）与「添加至笔记」的标注反链
 *    （`data-annotation`）靠属性回指库里的对象。Markdown 编辑器要做 HTML ⇄ MD
 *    双向转换，这些结构一律退化成纯文本，写回去就是数据损坏。所以这里做富文本。
 * 2. **零依赖**。粗体/斜体/下划线/标题/列表/引用/高亮这一套 `document.execCommand`
 *    全都有；引一个 ProseMirror 系（Tiptap）要 +200KB 且得自建与 Zotero 对齐的
 *    schema，规范化过程反而更容易打散锚点。`execCommand` 虽被标 deprecated，但浏览器
 *    已承诺长期保留，且 contenteditable 本身没有替代品——Zotero 也是自己写 schema。
 * 3. **锚点不可拆**。挂载后把引文 / 标注 / 图片 / figure 标成
 *    `contenteditable="false"`：光标进不去内部，只能整块选中、整块删除，与 Zotero
 *    编辑器里这些节点的行为一致。这些装饰属性在取值时剥离，不落进文库。
 *
 * 粘贴一律降级成纯文本：外部富文本（尤其是从别处复制的伪引文）粘进来会带一堆
 * Zotero 认不出的结构，与其清洗不如只要文字。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from 'react'

import { type Translate } from './locales'

/** 高亮色：与 {@link NOTE_CSS} 里 `.highlight` 的底色一致，取值时按 rgb 认回来。 */
const HIGHLIGHT = '#ffd54f'

/** 从编辑器取正文、聚焦与判空。 */
export interface NoteEditorHandle {
  /**
   * 当前正文 HTML。
   *
   * 走 clone 再序列化：编辑期为了不让引文 / 标注锚点被拆开，给它们挂了
   * `contenteditable="false"` 与 `draggable="false"`，这些装饰不能落进 Zotero。
   * 顺手把 execCommand 的产物归一成 Zotero 自己的写法（见 {@link normalizeHtml}）。
   */
  getHtml(): string
  focus(): void
  /** 只有空白、没有任何文字与图片时算空。 */
  isEmpty(): boolean
}

interface Props {
  /** 初始正文（未清洗的原始 HTML）。只在挂载时注入一次，之后由 DOM 自己持有。 */
  html: string
  /** 内容变动。不给值：父级保存时再 {@link NoteEditorHandle.getHtml}，省下每次按键的序列化。 */
  onDirty(): void
  /**
   * 失焦：父级应当**立刻**写盘，不要等防抖。
   *
   * 点别的条目、点「加入对话」都会让这个编辑器卸载，DOM 一没就再也取不到正文了。
   */
  onCommit?(): void
  /** 工具条与占位符的文案来源。 */
  t: Translate
  placeholder?: string
  ariaLabel?: string
  /** 正文最小高度，内容少时也别只剩一条线。 */
  minHeight?: number
  /** 挂载后自动聚焦（新建笔记用）。 */
  autoFocus?: boolean
}

/**
 * execCommand 的产物 → Zotero 的写法。
 *
 * `styleWithCSS=false` 时加粗产出 `<b>`、斜体 `<i>`，而 Zotero 自己用
 * `<strong>` / `<em>`；高亮则被写成内联 `background-color`，而 Zotero 用
 * `.highlight` 类（主题切换时它能跟着调色）。两种写法在 Zotero 里都显示得出，
 * 但结构一致才不会有「在插件里加粗、到 Zotero 里却认成别的标记」这种漂移。
 */
export function normalizeHtml(html: string): string {
  return html
    .replace(/<b(\s[^>]*?)?>/giu, (_match, attrs: string | undefined) => `<strong${attrs ?? ''}>`)
    .replace(/<\/b>/giu, '</strong>')
    .replace(/<i(\s[^>]*?)?>/giu, (_match, attrs: string | undefined) => `<em${attrs ?? ''}>`)
    .replace(/<\/i>/giu, '</em>')
    .replace(/<span\s+style="[^"]*background-color:\s*rgb\(255,\s*213,\s*79\)[^"]*">/giu, '<span class="highlight">')
}

/** 顶层块级标签：除此之外的节点都要收进段落里。 */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'TABLE', 'DIV', 'SECTION', 'HR',
])

/**
 * 把顶层的裸文本包进 `<p>`。
 *
 * contenteditable 的第一行是不带标签的裸文本，第二行起才是 `<p>`（或回车时由
 * `defaultParagraphSeparator` 决定）。裸文本落进 Zotero 虽然也显示，但和它自己的
 * 段落流不一致，后续在 Zotero 里编辑容易错位，所以出库前补齐。
 */
function wrapLoose(root: HTMLElement): void {
  let group: ChildNode[] = []
  const flush = (): void => {
    if (group.length === 0) return
    const paragraph = root.ownerDocument.createElement('p')
    root.insertBefore(paragraph, group[0])
    for (const node of group) paragraph.appendChild(node)
    group = []
  }
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName)) {
      flush()
      continue
    }
    // 缩进用的空白文本不单独成段。
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') continue
    group.push(node)
  }
  flush()
}

/** 取正文：剥掉编辑期装饰、补齐段落，再序列化。 */
function readHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement
  for (const node of clone.querySelectorAll('[contenteditable]')) node.removeAttribute('contenteditable')
  for (const node of clone.querySelectorAll('[draggable]')) node.removeAttribute('draggable')
  wrapLoose(clone)
  return normalizeHtml(clone.innerHTML)
}

/** 锚点 / 图片这类节点整体不可编辑：光标进不去，只能整块选中或删除。 */
const ATOMIC = '[data-citation], [data-annotation], .citation, figure, img'

function decorate(root: HTMLElement): void {
  for (const node of root.querySelectorAll(ATOMIC)) {
    node.setAttribute('contenteditable', 'false')
    if (node instanceof HTMLElement) node.draggable = false
  }
}

/** 查询命令当前状态；没聚焦或命令不支持时安静地返回 false。 */
function commandOn(command: string): boolean {
  try {
    return document.queryCommandState(command)
  } catch {
    return false
  }
}

interface Tool {
  id: string
  /** 按钮上显示的字（B / I / U 这类单字最省横向空间）。 */
  label: ReactElement | string
  hint: string
  run(): void
}

/**
 * 有激活态的工具（按钮 id → `queryCommandState` 的命令名）。
 *
 * 与 {@link NoteEditor} 里那份 `tools` 分开列，是因为这份要喂给 `selectionchange`
 * 监听：它会随每次光标移动触发，依赖必须稳定。
 */
const STATE_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['bold', 'bold'],
  ['italic', 'italic'],
  ['underline', 'underline'],
  ['strike', 'strikeThrough'],
  ['ul', 'insertUnorderedList'],
  ['ol', 'insertOrderedList'],
]

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor(
  { html, onDirty, onCommit, t, placeholder, ariaLabel, minHeight = 96, autoFocus = false },
  ref,
): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const initialized = useRef(false)
  const [active, setActive] = useState<Record<string, boolean>>({})
  /** 与 `active` 同步的镜像：`selectionchange` 里比对用，避免闭包读到旧值。 */
  const activeRef = useRef<Record<string, boolean>>({})

  // 只注入一次：每次 render 覆盖 innerHTML 会把光标顶回开头，这是不受控
  // contenteditable 的老坑。换笔记靠父级给新 key 重建整个编辑器。
  useEffect(() => {
    const element = rootRef.current
    if (element === null || initialized.current) return
    element.innerHTML = html
    decorate(element)
    initialized.current = true
    // 回车产 <p> 而不是 <div>：Zotero 的笔记正文是段落流。
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p')
    } catch {
      /* 老引擎不支持就算了，影响只是回车多套一层 div。 */
    }
    if (autoFocus) element.focus()
  }, [html, autoFocus])

  const exec = useCallback(
    (command: string, value?: string) => {
      const element = rootRef.current
      if (element === null) return
      element.focus()
      try {
        // false = 用语义标签而不是内联 style，见 normalizeHtml 的说明。
        document.execCommand('styleWithCSS', false, 'false')
        document.execCommand(command, false, value)
      } catch {
        /* 命令不被支持时什么也不做，别把异常抛到 React 的渲染栈里。 */
      }
      onDirty()
    },
    [onDirty],
  )

  const tools: Tool[] = [
    { id: 'bold', label: <b>B</b>, hint: t('note.bold'), run: () => exec('bold') },
    { id: 'italic', label: <i>I</i>, hint: t('note.italic'), run: () => exec('italic') },
    { id: 'underline', label: <u>U</u>, hint: t('note.underline'), run: () => exec('underline') },
    { id: 'strike', label: <s>S</s>, hint: t('note.strike'), run: () => exec('strikeThrough') },
    { id: 'h2', label: 'H2', hint: t('note.heading2'), run: () => exec('formatBlock', 'h2') },
    { id: 'h3', label: 'H3', hint: t('note.heading3'), run: () => exec('formatBlock', 'h3') },
    { id: 'quote', label: '❝', hint: t('note.quote'), run: () => exec('formatBlock', 'blockquote') },
    { id: 'ul', label: '•', hint: t('note.bulletList'), run: () => exec('insertUnorderedList') },
    { id: 'ol', label: '1.', hint: t('note.numberedList'), run: () => exec('insertOrderedList') },
    {
      id: 'highlight',
      label: <span style={highlightLabelStyle}>A</span>,
      hint: t('note.highlight'),
      run: () => exec('hiliteColor', HIGHLIGHT),
    },
    { id: 'undo', label: '↶', hint: t('note.undo'), run: () => exec('undo') },
    { id: 'redo', label: '↷', hint: t('note.redo'), run: () => exec('redo') },
  ]

  // 工具条激活态：只在选区落在本编辑器内时读，避免多个编辑器抢同一份状态。
  // 依赖留空：状态的命令表是常量，不随渲染变；`selectionchange` 在打字时非常密集，
  // 每次 render 重绑监听会让输入路径白跑一圈。
  useEffect(() => {
    function sync(): void {
      const element = rootRef.current
      const selection = document.getSelection()
      if (element === null || selection === null || selection.rangeCount === 0) return
      if (!element.contains(selection.anchorNode)) return
      const next: Record<string, boolean> = {}
      let changed = false
      for (const [id, command] of STATE_COMMANDS) {
        next[id] = commandOn(command)
        if (next[id] !== activeRef.current[id]) changed = true
      }
      activeRef.current = next
      // 状态没变就别 setState：否则每次光标移动都会多一轮 render。
      if (changed) setActive(next)
    }
    document.addEventListener('selectionchange', sync)
    return () => document.removeEventListener('selectionchange', sync)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      getHtml: () => {
        const element = rootRef.current
        return element === null ? '' : readHtml(element)
      },
      focus: () => rootRef.current?.focus(),
      isEmpty: () => {
        const element = rootRef.current
        if (element === null) return true
        return (element.textContent ?? '').trim() === '' && element.querySelector('img, figure') === null
      },
    }),
    [],
  )

  return (
    <div style={shellStyle}>
      <style>{EDITOR_CSS}</style>
      <div style={toolbarStyle} role="toolbar" aria-label={ariaLabel ?? t('note.new')}>
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            title={tool.hint}
            aria-label={tool.hint}
            // 按下时别让按钮抢走焦点：一失焦选区就没了，命令会落在错误的范围上。
            onMouseDown={(event) => event.preventDefault()}
            onClick={tool.run}
            className="dsh-zpn-tool"
            data-on={active[tool.id] === true ? '1' : '0'}
          >
            {tool.label}
          </button>
        ))}
      </div>
      <div
        ref={rootRef}
        className="dsh-zotero-note dsh-zpn-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel ?? t('note.new')}
        data-placeholder={placeholder ?? ''}
        style={{ ...bodyStyle, minHeight }}
        onInput={onDirty}
        onBlur={() => {
          onDirty()
          onCommit?.()
        }}
        onPaste={(event) => {
          // 只收纯文本：外部富文本会带进 Zotero 认不出的结构，伪引文尤其危险。
          const text = event.clipboardData.getData('text/plain')
          if (text === '') return
          event.preventDefault()
          try {
            document.execCommand('insertText', false, text)
          } catch {
            /* 插不进去就保持原样，至少没把脏 HTML 写进正文。 */
          }
          onDirty()
        }}
      />
    </div>
  )
})

const EDITOR_CSS = `
.dsh-zpn-tool {
  min-width: 22px;
  height: 22px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11.5px;
  line-height: 1;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-family: inherit;
  opacity: 0.72;
}
.dsh-zpn-tool:hover { background: rgba(80,140,255,0.14); opacity: 1; }
.dsh-zpn-tool[data-on="1"] { background: rgba(80,140,255,0.18); color: #2f6fe0; opacity: 1; }
.dsh-zpn-body:empty::before,
.dsh-zpn-body:has(> p:only-child:empty)::before {
  content: attr(data-placeholder);
  opacity: 0.45;
  pointer-events: none;
}
.dsh-zpn-body:focus { outline: none; }
/* 编辑期的锚点节点：看起来像原文，但不让光标进去。 */
.dsh-zpn-body [contenteditable="false"] { cursor: default; }
`

const shellStyle = {
  marginTop: 6,
  border: '1px solid rgba(127,127,127,0.3)',
  borderRadius: 6,
  background: 'rgba(127,127,127,0.04)',
  overflow: 'hidden',
} as const

const toolbarStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 1,
  padding: '2px 4px',
  borderBottom: '1px solid rgba(127,127,127,0.2)',
} as const

const bodyStyle = {
  padding: '6px 8px',
  fontSize: 12.5,
  lineHeight: 1.75,
  overflowWrap: 'break-word',
  resize: 'vertical',
  overflow: 'auto',
  maxHeight: 520,
} as const

/** 工具条上的高亮按钮：小黄块比任何图标都直观。 */
const highlightLabelStyle = {
  background: 'rgba(255,213,79,0.62)',
  borderRadius: 2,
  padding: '0 2px',
} as const
