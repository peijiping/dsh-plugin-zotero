/**
 * 右栏：条目详情「笔记」tab 里的笔记列表。
 *
 * 笔记是 Zotero 的子条目（`itemType: "note"`），正文在 `data.note` 字段里，是带排版
 * 标签的 HTML（段落、标题、引用、标注高亮、外链图片）。Host 侧另做了一份清洗版供
 * 只读展示（剥掉 `data-*`、脚本与事件属性）。
 *
 * 交互与 Zotero 对齐：**正文摊开就是编辑器**，不再有「编辑」按钮把 HTML 源码塞进
 * textarea。展开时按需取一次**原始 HTML**（`note-raw`，不清洗、不截断）喂给
 * {@link NoteEditor}，改完自动写回，只有一条状态提示在正文下方。
 *
 * 几条约定：
 * - 编辑取原始 HTML、写回也原样落库，锚点（引文 / 标注反链）不做任何改写；
 * - 所有笔记都可编辑。含锚点的在编辑器下方挂一句提醒，但不禁用；
 * - 保存时机是**失焦立刻写 + 输入停 800ms 写**。失焦必须立刻：点别的条目、
 *   点「加入对话」都会让编辑器卸载，等防抖就来不及了；
 * - 412（Zotero 那边改过）会自动重取版本再写一次本地这份，用户眼前的内容优先；
 * - 删除是硬删（不进 Zotero 回收站），因此必须点两次。
 *
 * 「新建」的入口不在这里——它挂在「笔记」区块标题行的加号上，由 {@link InfoPanel}
 * 渲染，所以开合状态用 `composing` / `onComposingChange` 受控传入。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button } from './ui'

import type { ZoteroNote } from '../zotero/types'
import { ApiFailure, createNote, deleteNote, fetchNoteRaw, updateNote } from './api'
import { NoteEditor, type NoteEditorHandle } from './NoteEditor'
import { tpl, type Translate } from './locales'
import { showToast } from './paneStore'

interface Props {
  t: Translate
  notes: ZoteroNote[]
  /** 新建的笔记挂在这个条目下。 */
  itemKey: string
  /** 配置里的「允许写入 Zotero」是否打开；关着时整块保持只读。 */
  canWrite: boolean
  /** 当前详情本身就是一条独立笔记：没有可挂载的父条目，不提供新建。 */
  selfNote: boolean
  /** 新建框是否打开（入口在区块标题行的加号上，状态由父级持有）。 */
  composing: boolean
  onComposingChange(open: boolean): void
  onInsert(note: ZoteroNote): void
  /** 写成功后重取整份详情：Zotero 是唯一真相，本地不猜结果。 */
  onChanged(): void
}

/** 输入停止多久后自动写回。太短会把每次停顿都变成一次 PATCH。 */
const SAVE_DELAY = 800

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function NoteList({
  t,
  notes,
  itemKey,
  canWrite,
  selfNote,
  composing,
  onComposingChange,
  onInsert,
  onChanged,
}: Props): ReactElement {
  return (
    <div>
      <style>{NOTE_CSS}</style>

      {canWrite && !selfNote && composing && (
        <NoteComposer t={t} itemKey={itemKey} onCancel={() => onComposingChange(false)} onCreated={onChanged} />
      )}

      {notes.map((note) => (
        <NoteItem
          key={note.key}
          t={t}
          note={note}
          canWrite={canWrite}
          onInsert={onInsert}
          onChanged={onChanged}
          // 展开一条笔记就先把新建框收掉：两个编辑器同时开着只会互相打岔。
          onOpenEditor={() => onComposingChange(false)}
        />
      ))}
    </div>
  )
}

/** 新建笔记：同样是正文即编辑器的富文本，保存时直接落 HTML。 */
function NoteComposer({
  t,
  itemKey,
  onCancel,
  onCreated,
}: {
  t: Translate
  itemKey: string
  onCancel(): void
  onCreated(): void
}): ReactElement {
  const editor = useRef<NoteEditorHandle | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  async function save(): Promise<void> {
    const handle = editor.current
    if (handle === null) return
    if (handle.isEmpty()) {
      setNotice(t('note.emptyBody'))
      return
    }
    const html = handle.getHtml()
    setBusy(true)
    setNotice(null)
    try {
      await createNote({ parentItem: itemKey, note: html })
      showToast(t('note.created'))
      onCreated()
      onCancel()
    } catch (error) {
      setNotice(tpl(t('note.writeFailed'), { message: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={composerStyle}>
      <NoteEditor
        ref={editor}
        html=""
        t={t}
        autoFocus
        placeholder={t('note.bodyPlaceholder')}
        ariaLabel={t('note.new')}
        onDirty={() => setNotice(null)}
      />
      <div style={editorFootStyle}>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? t('note.saving') : t('note.save')}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t('note.cancel')}
        </Button>
      </div>
      {notice !== null && <div role="alert" style={noticeStyle}>{notice}</div>}
    </div>
  )
}

/** 一条笔记：折叠成一行标题，展开即编辑器（只读模式下降级为 HTML 展示）。 */
function NoteItem({
  t,
  note,
  canWrite,
  onInsert,
  onChanged,
  onOpenEditor,
}: {
  t: Translate
  note: ZoteroNote
  canWrite: boolean
  onInsert(note: ZoteroNote): void
  onChanged(): void
  onOpenEditor(): void
}): ReactElement {
  const [open, setOpen] = useState(false)
  /** 原始 HTML：只在展开且可写时按需取一次，之后由编辑器持有。 */
  const [raw, setRaw] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [notice, setNotice] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [removing, setRemoving] = useState(false)

  const editor = useRef<NoteEditorHandle | null>(null)
  /** 有未落库的改动。用 ref 而不是 state：保存链路上要同步读到。 */
  const dirty = useRef(false)
  const timer = useRef<number | null>(null)
  const inflight = useRef(false)
  const queued = useRef(false)
  /** 最新版本号：Zotero 的 PATCH 前置条件。props 的更新落后于写请求，本地先追。 */
  const version = useRef(note.version)
  /** 卸载后不再 setState；PATCH 还是继续发完（内容已经取出来了）。 */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  // 保存成功后 `onChanged()` 会带回新版本，本地版本号只涨不退。
  useEffect(() => {
    if (note.version > version.current) version.current = note.version
  }, [note.version])

  async function load(): Promise<void> {
    setLoading(true)
    setNotice(null)
    try {
      const fresh = await fetchNoteRaw(note.key)
      if (fresh.version > version.current) version.current = fresh.version
      if (alive.current) setRaw(fresh.html)
    } catch (error) {
      if (alive.current) setNotice(tpl(t('note.readFailed'), { message: errorMessage(error) }))
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  function toggle(): void {
    if (!open) {
      setOpen(true)
      onOpenEditor()
      if (canWrite && raw === null && !loading) void load()
      return
    }
    // 收起前必须冲一次：编辑器马上卸载，DOM 一没就再也取不到内容了。
    void flush()
    setOpen(false)
  }

  function markDirty(): void {
    dirty.current = true
    setStatus('idle')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      void flush()
    }, SAVE_DELAY)
  }

  /**
   * 把本地这份写回 Zotero。
   *
   * 串行：同一时刻只飞一条 PATCH（版本号会打架）。飞行期间的新改动记在 `queued`，
   * 落地后再冲一次。412 说明 Zotero 那边改过了，重取版本再写本地这份——用户眼前
   * 的内容优先，不做合并。
   */
  async function flush(): Promise<void> {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    const handle = editor.current
    if (handle === null) return
    if (handle.isEmpty()) {
      if (alive.current) setNotice(t('note.emptyBody'))
      return
    }
    const html = handle.getHtml()
    if (inflight.current) {
      queued.current = true
      return
    }

    inflight.current = true
    if (alive.current) {
      setStatus('saving')
      setNotice(null)
    }
    try {
      await write(html)
      dirty.current = false
      if (alive.current) setStatus('saved')
      onChanged()
    } catch (error) {
      if (alive.current) {
        setStatus('idle')
        setNotice(tpl(t('note.writeFailed'), { message: errorMessage(error) }))
      }
    } finally {
      inflight.current = false
      if (queued.current) {
        queued.current = false
        void flush()
      }
    }
  }

  async function write(html: string): Promise<void> {
    try {
      await updateNote({ key: note.key, version: version.current, note: html })
    } catch (error) {
      if (!(error instanceof ApiFailure) || error.code !== 'zotero_stale') throw error
      const fresh = await fetchNoteRaw(note.key)
      version.current = fresh.version
      await updateNote({ key: note.key, version: fresh.version, note: html })
    }
  }

  async function remove(): Promise<void> {
    setArmed(false)
    setRemoving(true)
    setNotice(null)
    try {
      await deleteNote({ key: note.key, version: version.current })
      showToast(t('note.deleted'))
      onChanged()
    } catch (error) {
      setNotice(tpl(t('note.writeFailed'), { message: errorMessage(error) }))
    } finally {
      if (alive.current) setRemoving(false)
    }
  }

  const busy = removing || status === 'saving'
  const editable = canWrite && open
  const editorVisible = editable && raw !== null

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={noteRowStyle}>
        <button type="button" onClick={toggle} style={noteHeaderStyle} aria-expanded={open}>
          <span style={{ flexShrink: 0, opacity: 0.55 }}>{open ? '▾' : '▸'}</span>
          <span style={{ flex: 1, textAlign: 'left', wordBreak: 'break-word' }}>{note.title}</span>
          {note.truncated && <span style={{ opacity: 0.55, flexShrink: 0 }}>{t('detail.noteTruncated')}</span>}
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onInsert(note)}
          title={t('action.insertToChat')}
          style={insertButtonStyle}
        >
          {t('action.insertItemShort')}
        </Button>
        {canWrite &&
          (armed ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              title={t('note.deleteWarn')}
              style={insertButtonStyle}
            >
              {t('note.confirmDelete')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setArmed(true)}
              title={t('note.deleteWarn')}
              style={insertButtonStyle}
            >
              {t('note.delete')}
            </Button>
          ))}
      </div>

      {open && loading && <div style={hintStyle}>{t('note.loading')}</div>}

      {/* 不可写时退回原来的只读渲染：清洗版 HTML 已经把 data-* 剥掉了，不适合回写。 */}
      {open && !canWrite && (
        <div
          className="dsh-zotero-note"
          dangerouslySetInnerHTML={{ __html: note.html }}
          style={noteBodyStyle}
        />
      )}

      {editorVisible && (
        <>
          <NoteEditor
            // 换条目才重建编辑器：光靠 `open` 切换会让同一份 DOM 留着上一条的内容。
            key={note.key}
            ref={editor}
            html={raw}
            t={t}
            minHeight={140}
            placeholder={t('note.bodyPlaceholder')}
            ariaLabel={note.title}
            onDirty={markDirty}
            // 失焦立刻写：点别处、点「加入对话」、切换条目都是这条路径。
            onCommit={() => void flush()}
          />
          <div style={editorFootStyle}>
            <span style={note.anchored ? anchorHintStyle : editorHintStyle}>
              {note.anchored
                ? t('note.anchorWarn')
                : status === 'saving'
                  ? t('note.saving')
                  : status === 'saved'
                    ? t('note.savedShort')
                    : t('note.autosaveHint')}
            </span>
          </div>
        </>
      )}

      {notice !== null && (
        <div role="alert" style={noticeStyle}>
          {notice}
        </div>
      )}
    </div>
  )
}

/**
 * 笔记正文里的样式。
 *
 * 笔记 HTML 由 Zotero 生成，段落/标题/引用/高亮都是语义标签，这里补一套贴合右栏
 * 密度的排版。编辑器（`.dsh-zpn-body`）复用同一份 class，所以**在插件里看到的排版
 * 就是写回 Zotero 后的排版**。
 *
 * 独立笔记（条目本身就是 note）在详情「全文」处渲染，那里也引这份样式，因此导出。
 */
export const NOTE_CSS = `
.dsh-zotero-note p { margin: 0 0 6px; }
.dsh-zotero-note p:last-child { margin-bottom: 0; }
.dsh-zotero-note h1 { font-size: 16px; line-height: 1.5; margin: 10px 0 6px; }
.dsh-zotero-note h2 { font-size: 14.5px; line-height: 1.5; margin: 9px 0 5px; }
.dsh-zotero-note h3 { font-size: 13.5px; line-height: 1.5; margin: 8px 0 4px; }
.dsh-zotero-note h4 { font-size: 13px; line-height: 1.5; margin: 6px 0 4px; }
.dsh-zotero-note h1:first-child, .dsh-zotero-note h2:first-child { margin-top: 0; }
.dsh-zotero-note ul, .dsh-zotero-note ol { margin: 4px 0 6px; padding-left: 20px; }
.dsh-zotero-note li { margin: 2px 0; }
.dsh-zotero-note blockquote {
  margin: 6px 0;
  padding-left: 8px;
  border-left: 3px solid rgba(127,127,127,0.3);
  opacity: 0.85;
}
.dsh-zotero-note .highlight {
  background: rgba(255, 213, 79, 0.28);
  border-radius: 2px;
}
.dsh-zotero-note .citation { opacity: 0.75; font-style: italic; }
.dsh-zotero-note a { color: #3b7de0; text-decoration: none; }
.dsh-zotero-note a:hover { text-decoration: underline; }
.dsh-zotero-note img { max-width: 100%; height: auto; border-radius: 4px; }
.dsh-zotero-note figure { margin: 6px 0; }
.dsh-zotero-note table { border-collapse: collapse; max-width: 100%; }
.dsh-zotero-note td, .dsh-zotero-note th { border: 1px solid rgba(127,127,127,0.25); padding: 3px 6px; }
.dsh-zotero-note hr { border: none; border-top: 1px solid rgba(127,127,127,0.25); margin: 8px 0; }
.dsh-zotero-note pre {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(127,127,127,0.1);
  overflow-x: auto;
  font-size: 12px;
}
.dsh-zotero-note code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`

const noteRowStyle = {
  display: 'flex',
  // 三个短按钮（引用 / 删除 + 可能出现的「确认删除」）在右栏宽度下放不下时换行，
  // 而不是把标题挤没。
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  padding: '4px 2px',
  borderBottom: '1px solid rgba(127,127,127,0.18)',
} as const

const noteHeaderStyle = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  flex: 1,
  minWidth: 120,
  padding: 0,
  fontSize: 12.5,
  lineHeight: 1.6,
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
} as const

const insertButtonStyle = {
  flexShrink: 0,
  height: 20,
  padding: '0 6px',
  fontSize: 11,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
} as const

/** 不可写时的只读正文（清洗版 HTML）。 */
const noteBodyStyle = {
  marginTop: 6,
  padding: '6px 8px',
  border: '1px solid rgba(127,127,127,0.25)',
  borderRadius: 6,
  fontSize: 12.5,
  lineHeight: 1.75,
  opacity: 0.9,
  overflowWrap: 'break-word',
} as const

const composerStyle = {
  marginBottom: 10,
} as const

const editorFootStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
} as const

const editorHintStyle = {
  flex: 1,
  fontSize: 11,
  opacity: 0.6,
} as const

/** 锚点提示：比普通提示更显眼，但别做成错误色——它只是「别手改这些标签」。 */
const anchorHintStyle = {
  flex: 1,
  fontSize: 11,
  lineHeight: 1.5,
  color: '#d29922',
} as const

const hintStyle = {
  marginTop: 6,
  fontSize: 11.5,
  opacity: 0.6,
} as const

const noticeStyle = {
  marginTop: 6,
  padding: '6px 8px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.6,
  color: '#d29922',
  background: 'rgba(210,153,34,0.1)',
  overflowWrap: 'break-word',
} as const
