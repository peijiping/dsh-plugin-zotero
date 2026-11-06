/**
 * 全文选区浮动菜单：复制 / 加入对话。
 *
 * PDF 与文本渲染器共用。两者传入的 x/y 都已经换算成各自内容根节点的坐标。
 * 按钮在 mousedown 时 preventDefault，避免浏览器先清掉选区导致后续取值失败。
 */

import type { ReactElement } from 'react'

import { showToast } from '../paneStore'
import type { Translate } from '../locales'

interface Props {
  t: Translate
  text: string
  x: number
  y: number
  onInsert(text: string): void
  onDismiss(): void
}

export function SelectionBar({ t, text, x, y, onInsert, onDismiss }: Props): ReactElement {
  function finish(): void {
    window.getSelection()?.removeAllRanges()
    onDismiss()
  }

  function copy(): void {
    void writeClipboard(text).then((ok) => {
      showToast(t(ok ? 'toast.copied' : 'toast.copyFailed'))
    })
    finish()
  }

  return (
    <div style={{ ...barStyle, left: x, top: y }}>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={copy}
        style={buttonStyle}
      >
        {t('action.copy')}
      </button>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onInsert(text)
          finish()
        }}
        style={{ ...buttonStyle, borderLeft: '1px solid rgba(127,127,127,0.25)' }}
      >
        {t('action.insertExcerpt')}
      </button>
    </div>
  )
}

const barStyle = {
  position: 'absolute',
  transform: 'translate(-50%, -130%)',
  display: 'flex',
  alignItems: 'stretch',
  overflow: 'hidden',
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.35)',
  background: 'Canvas',
  color: 'CanvasText',
  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
  fontSize: 12,
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
  zIndex: 8,
} as const

const buttonStyle = {
  padding: '3px 8px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

/**
 * 宿主 webview 里 navigator.clipboard 可能因焦点/权限被拒（DSH 实测会 reject），
 * 再用一个临时 textarea + execCommand 兜底。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return legacyCopy(text)
  }
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}
