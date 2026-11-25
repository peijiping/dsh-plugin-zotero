/**
 * Client 侧「当前文库」。
 *
 * Host 用查询参数 `library` 决定读写哪个文库（缺省 / `user` = 用户文库，
 * `group:<id>` = 群组文库）。这里维护两份记忆：
 * - 正在浏览的文库：列表、树、标签都跟着它走，并存进 localStorage（刷新后仍对齐）；
 * - 「条目 key → 文库」：条目详情开在独立 tab 里，用户中途切回用户文库后，
 *   那两个 tab 仍要按原文库取详情 / 文件 / 笔记。
 */

const LIBRARY_KEY = 'dsh-plugin-zotero.library'

function normalize(raw: string | null): string {
  if (raw === null || raw === '' || raw === 'user') return ''
  return /^group:\d{1,15}$/u.test(raw) ? raw : ''
}

function readActive(): string {
  try {
    return normalize(window.localStorage.getItem(LIBRARY_KEY))
  } catch {
    return ''
  }
}

let active: string = readActive()

const itemLibraries = new Map<string, string>()

/** 当前正在浏览的文库标识。 */
export function getActiveLibrary(): string {
  return active
}

/** 切换正在浏览的文库（选中群组文库的节点时调用）。 */
export function setActiveLibrary(library: string): void {
  const next = normalize(library)
  if (next === active) return
  active = next
  try {
    if (next === '') window.localStorage.removeItem(LIBRARY_KEY)
    else window.localStorage.setItem(LIBRARY_KEY, next)
  } catch {
    // 隐私模式等禁用 localStorage 时忽略，本次会话内仍然生效。
  }
}

/** 记住条目 / 附件 key 属于哪个文库（用户文库不记，省一份内存）。 */
export function rememberItemLibrary(key: string, library: string): void {
  if (library === '') itemLibraries.delete(key)
  else itemLibraries.set(key, library)
}

/**
 * 查询参数片段：条目 key 所在文库。
 *
 * 用户文库返回空对象（不传参数），群组返回 `{ library: 'group:<id>' }`。
 */
export function itemLibraryQuery(key: string): { library?: string } {
  const library = libraryOfItem(key)
  return library === '' ? {} : { library }
}

/** 条目 key 所在文库；没记过时按当前文库。 */
export function libraryOfItem(key: string): string {
  return itemLibraries.get(key) ?? active
}
