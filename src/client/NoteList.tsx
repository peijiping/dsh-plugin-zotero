/**
 * 右栏：条目详情「笔记」tab 里的笔记列表。
 *
 * 笔记是 Zotero 的子条目（`itemType: "note"`），正文在 `data.note` 字段里，
 * 是带排版标签的 HTML（段落、引用、标注高亮、外链图片）。
 * Host 侧已完成清洗（剥离 `data-*` 冗余属性、脚本与事件属性、图片限宽），
 * 这里直接以 `dangerouslySetInnerHTML` 渲染。
 *
 * 每条笔记默认折叠成一行标题（正文首段摘要），点击标题展开正文；
 * 行尾「引用」往会话输入框插一个笔记 chip，正文在提交那一刻才展开成文本。
 *
 * 开了写入开关后，这里还是笔记的新建 / 编辑 / 删除入口，三条约定：
 * - 编辑取的是**原始 HTML**（`note-raw`），不是列表里那份清洗过的展示文本；
 * - 所有笔记都可编辑。含引文 / 标注锚点的（`note.anchored`）在编辑器里挂一句提醒，
 *   但不再禁掉按钮：写回是原样落库，不动那些标签，锚点就完好；
 * - 删除是硬删（不进 Zotero 回收站），因此必须点两次。
 *
 * 「新建」的入口不在这里——它挂在「笔记」区块标题行的加号上，由 {@link InfoPanel}
 * 渲染，所以开合状态用 `composing` / `onComposingChange` 受控传入。
 */

import { useEffect, useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroNote } from '../zotero/types'
import { createNote, deleteNote, fetchNoteRaw, updateNote } from './api'
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

/** 正在等 Zotero 的动作；`read` 只取正文，不落库。 */
type Pending = 'create' | 'edit' | 'delete' | 'read'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/**
 * 纯文本 → 笔记 HTML。
 *
 * 笔记正文在 Zotero 里是 HTML，裸文本的换行会被糊成一段。空行分段、段内换行转
 * `<br>`，其余一律转义：新建时用户写的是内容，不是标签。
 */
function textToHtml(text: string): string {
  const blocks = text
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}/u)
    .map((block) => block.replace(/^\n+|\n+$/gu, ''))
    .filter((block) => block !== '')
  return blocks.map((block) => `<p>${escapeHtml(block).replace(/\n/gu, '<br>')}</p>`).join('')
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
  // 展开的笔记 key 集合；默认全部折叠。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** 正在编辑的笔记：原始 HTML 与其草稿。 */
  const [editing, setEditing] = useState<{ key: string; html: string } | null>(null)
  /** 新建草稿（纯文本）；是否显示由 `composing` 决定。 */
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 已点过一次「删除」、正在等第二次确认的笔记 key。 */
  const [armed, setArmed] = useState<string | null>(null)

  const busy = pending !== null

  // 关掉新建框就把草稿清掉，下次点加号是干净的一张白纸。
  useEffect(() => {
    if (!composing) setDraft('')
  }, [composing])

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /**
   * 跑一次与 Zotero 的往返。
   *
   * 写成功只报一句就交给 {@link onChanged} 重取：版本号、日期、标题摘要都得以库里
   * 那份为准，本地不拼。失败把 Host 的中文文案原样摊出来，里面已写明去哪点授权。
   */
  async function run(kind: Pending, action: () => Promise<unknown>): Promise<boolean> {
    setNotice(null)
    setPending(kind)
    try {
      await action()
      if (kind !== 'read') {
        showToast(kind === 'delete' ? t('note.deleted') : kind === 'edit' ? t('note.saved') : t('note.created'))
        onChanged()
      }
      return true
    } catch (error) {
      setNotice(tpl(t(kind === 'read' ? 'note.readFailed' : 'note.writeFailed'), { message: errorMessage(error) }))
      return false
    } finally {
      setPending(null)
    }
  }

  function startEdit(note: ZoteroNote): void {
    setArmed(null)
    onComposingChange(false)
    if (editing?.key === note.key) {
      setEditing(null)
      return
    }
    void run('read', async () => {
      const raw = await fetchNoteRaw(note.key)
      setEditing({ key: raw.key, html: raw.html })
    })
  }

  function rowButtons(note: ZoteroNote): ReactElement | null {
    if (!canWrite) return null
    const editingThis = editing?.key === note.key
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => startEdit(note)}
          title={note.anchored ? t('note.anchorWarn') : t('note.edit')}
          style={insertButtonStyle}
        >
          {editingThis ? t('note.cancel') : t('note.edit')}
        </Button>
        {armed === note.key ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setArmed(null)
              void run('delete', () => deleteNote({ key: note.key, version: note.version }))
            }}
            title={t('note.deleteWarn')}
            style={insertButtonStyle}
          >
            {t('note.confirmDelete')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || editingThis}
            onClick={() => {
              setEditing(null)
              setArmed(note.key)
            }}
            title={t('note.deleteWarn')}
            style={insertButtonStyle}
          >
            {t('note.delete')}
          </Button>
        )}
      </>
    )
  }

  return (
    <div>
      <style>{NOTE_CSS}</style>

      {canWrite && !selfNote && composing && (
        <div style={editorStyle}>
          <textarea
            value={draft}
            placeholder={t('note.bodyPlaceholder')}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            style={textareaStyle}
            aria-label={t('note.new')}
          />
          <div style={editorFootStyle}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || draft.trim() === ''}
              onClick={() => {
                const body = draft
                void run('create', () => createNote({ parentItem: itemKey, note: textToHtml(body) })).then((done) => {
                  if (done) onComposingChange(false)
                })
              }}
            >
              {pending === 'create' ? t('note.saving') : t('note.save')}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onComposingChange(false)}>
              {t('note.cancel')}
            </Button>
          </div>
        </div>
      )}

      {notes.map((note) => {
        const editor = editing?.key === note.key ? editing : null
        const open = editor === null && expanded.has(note.key)
        return (
          <div key={note.key} style={{ marginBottom: 10 }}>
            <div style={noteRowStyle}>
              <button type="button" onClick={() => toggle(note.key)} style={noteHeaderStyle}>
                <span style={{ flexShrink: 0, opacity: 0.55 }}>{open || editor !== null ? '▾' : '▸'}</span>
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
              {rowButtons(note)}
            </div>

            {open && (
              <div
                className="dsh-zotero-note"
                dangerouslySetInnerHTML={{ __html: note.html }}
                style={noteBodyStyle}
              />
            )}

            {editor !== null && (
              <div style={editorStyle}>
                <textarea
                  value={editor.html}
                  disabled={busy}
                  onChange={(event) => setEditing({ key: note.key, html: event.target.value })}
                  style={textareaStyle}
                  aria-label={t('note.htmlHint')}
                />
                <div style={editorFootStyle}>
                  <span style={note.anchored ? anchorHintStyle : editorHintStyle}>
                    {note.anchored ? t('note.anchorWarn') : t('note.htmlHint')}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || editor.html.trim() === ''}
                    onClick={() => {
                      const draft = editor.html
                      void run('edit', () =>
                        updateNote({ key: note.key, version: note.version, note: draft }),
                      ).then((done) => {
                        if (done) setEditing(null)
                      })
                    }}
                  >
                    {pending === 'edit' ? t('note.saving') : t('note.save')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>
                    {t('note.cancel')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}

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
 * 笔记 HTML 由 Zotero 生成，段落/引用/高亮标记都是默认样式，这里补一套
 * 贴合右栏密度的排版（引用块、标注高亮、图片、表格）。
 *
 * 独立笔记（条目本身就是 note）在详情「全文」位置渲染，那里也引这份样式，
 * 因此导出。
 */
export const NOTE_CSS = `
.dsh-zotero-note p { margin: 0 0 6px; }
.dsh-zotero-note p:last-child { margin-bottom: 0; }
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
.dsh-zotero-note img { max-width: 100%; height: auto; border-radius: 4px; }
.dsh-zotero-note figure { margin: 6px 0; }
.dsh-zotero-note table { border-collapse: collapse; max-width: 100%; }
.dsh-zotero-note td, .dsh-zotero-note th { border: 1px solid rgba(127,127,127,0.25); padding: 3px 6px; }
`

const noteRowStyle = {
  display: 'flex',
  // 三个短按钮（引用 / 编辑 / 删除）在右栏宽度下放不下时换行，而不是把标题挤没。
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

const editorStyle = {
  marginTop: 6,
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

const textareaStyle = {
  width: '100%',
  minHeight: 110,
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontSize: 12.5,
  lineHeight: 1.6,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'rgba(127,127,127,0.06)',
  color: 'inherit',
  fontFamily: 'inherit',
  resize: 'vertical',
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
