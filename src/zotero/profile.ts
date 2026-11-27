/**
 * Zotero 的 profile 目录解析。
 *
 * 只为一件事服务：找到 Zotero 的 profile 目录，再顺着它读 `prefs.js`
 * （`localAPIKeys.json` 的写权限 key、`extensions.zotero.dataDir`）。Zotero
 * 本地 API 不报告这些路径，只能按平台约定读 `profiles.ini` 自己推。
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
 * 只认 `[Profile*]` 段里的 `Path` / `IsRelative` / `Default`，其余键与用途无关；
 * 解析失败就当没有 profile。
 *
 * `Default=1` 的段排在**最前**：多 profile 的机器上（旧版本残留、测试用档），
 * 按文件顺序取第一个会拿到早就没在用的那个，进而读到它的 `dataDir`。
 */
export function parseProfilesIni(text: string, root: string): string[] {
  const dirs: string[] = []
  let section = ''
  let path = ''
  let relative = true
  let isDefault = false
  let defaultDir = ''
  const flush = (): void => {
    if (section.startsWith('Profile') && path !== '') {
      const full = relative ? resolve(root, path) : resolve(path)
      dirs.push(full)
      if (isDefault) defaultDir = full
    }
    path = ''
    relative = true
    isDefault = false
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
    else if (name === 'Default') isDefault = value === '1'
  }
  flush()
  if (defaultDir === '') return dirs
  return [defaultDir, ...dirs.filter((dir) => dir !== defaultDir)]
}

/** 进程内缓存：一次会话里 profile 布局不会变，列表摘要不该反复读 `profiles.ini`。 */
let cachedDirs: string[] | null = null

/**
 * 丢弃缓存。两种场景：用户刚装/刚启动 Zotero（之前读到空），以及验收脚本要在
 * 同一进程里换一套 profile 布局。
 */
export function clearProfileDirsCache(): void {
  cachedDirs = null
}

/** 本机所有 Zotero profile 目录；读不到 `profiles.ini` 时为空（空结果不缓存）。 */
export async function profileDirs(): Promise<string[]> {
  if (cachedDirs !== null) return [...cachedDirs]
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
  if (dirs.length > 0) cachedDirs = dirs
  return [...dirs]
}
