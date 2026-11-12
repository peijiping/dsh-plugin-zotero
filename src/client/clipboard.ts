/**
 * 剪贴板写入（宿主 webview 专用兜底）。
 *
 * `navigator.clipboard` 在 DSH 的 webview 里可能因焦点/权限被拒（实测会 reject），
 * 所以失败后退回一个临时 textarea + `execCommand('copy')`。
 */

export async function writeClipboard(text: string): Promise<boolean> {
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
