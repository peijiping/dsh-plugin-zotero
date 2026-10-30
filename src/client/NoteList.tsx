/**
 * 右栏：条目详情「笔记」tab 里的笔记列表。
 *
 * 笔记是 Zotero 的子条目（`itemType: "note"`），正文在 `data.note` 字段里，
 * 是带排版标签的 HTML（段落、引用、标注高亮、外链图片）。
 * Host 侧已完成清洗（剥离 `data-*` 冗余属性、脚本与事件属性、图片限宽），
 * 这里直接以 `dangerouslySetInnerHTML` 渲染。
 *
 * 每条笔记默认折叠成一行标题（正文首段摘要），点击标题展开正文；
 * 行尾「引用」把该条笔记（正文纯文本）写进会话草稿。
 */

import { useState, type ReactElement } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ZoteroNote } from '../zotero/types'
import type { Translate } from './locales'

interface Props {
  t: Translate
  notes: ZoteroNote[]
  onInsert(note: ZoteroNote): void
}

export function NoteList({ t, notes, onInsert }: Props): ReactElement | null {
  // 展开的笔记 key 集合；默认全部折叠。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  if (notes.length === 0) return null

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div>
      <style>{NOTE_CSS}</style>
      {notes.map((note) => {
        const open = expanded.has(note.key)
        return (
          <div key={note.key} style={{ marginBottom: 10 }}>
            <div style={noteRowStyle}>
              <button type="button" onClick={() => toggle(note.key)} style={noteHeaderStyle}>
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
            </div>
            {open && (
              <div
                className="dsh-zotero-note"
                dangerouslySetInnerHTML={{ __html: note.html }}
                style={noteBodyStyle}
              />
            )}
          </div>
        )
      })}
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
  minWidth: 0,
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
