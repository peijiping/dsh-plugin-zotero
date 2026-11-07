/**
 * Zotero 的 profile 目录解析。
 *
 * 只为一件事服务：找到 `localAPIKeys.json`，把用户早先点过「始终允许」的写权限
 * key 导进本插件（见 `key-store.ts`）。Zotero 本地 API 不报告这个路径，只能按
 * 平台约定读 `profiles.ini` 自己推。
 *
 * **不**解析数据目录：阅读位置已改成插件自己记录，不再从 Zotero 的
 * `storage/<key>/` 里读（`dataDir` 可能是用户改过的任意路径，拿不到可靠值）。
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Zotero 的 profiles.ini 所在目录（各平台固定，Zotero 未提供查询接口）。 */
export function dataRoots(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Zotero')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData === undefined ? [] : [join(appData, 'Zotero', 'Zotero')]
  }
  return [join(home, '.zotero', 'zotero')]
}

/**
 * 解析 `profiles.ini`，拿到所有 profile 目录。
 *
 * 只认 `[Profile*]` 段里的 `Path` / `IsRelative`，其余键（`Name`、`Default`…）与
 * 本用途无关；解析失败就当没有 profile。
 */
export function parseProfilesIni(text: string, root: string): string[] {
  const dirs: string[] = []
  let section = ''
  let path = ''
  let relative = true
  const flush = (): void => {
    if (section.startsWith('Profile') && path !== '') {
      dirs.push(relative ? resolve(root, path) : resolve(path))
    }
    path = ''
    relative = true
  }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      flush()
      section = line.slice(1, -1)
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (name === 'Path') path = value
    else if (name === 'IsRelative') relative = value !== '0'
  }
  flush()
  return dirs
}

/** 本机所有 Zotero profile 目录；读不到 `profiles.ini` 时为空。 */
export async function profileDirs(): Promise<string[]> {
  const dirs: string[] = []
  for (const root of dataRoots()) {
    let ini: string
    try {
      ini = await readFile(join(root, 'profiles.ini'), 'utf8')
    } catch {
      continue
    }
    dirs.push(...parseProfilesIni(ini, root))
  }
  return dirs
}
