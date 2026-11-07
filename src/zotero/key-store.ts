/**
 * Zotero 本地 API key 的**落盘**（「授权一次、永久可用」的那半条命）。
 *
 * `POST /api/local/authorize` 每次调用都必弹框（Zotero 内部没有「按应用名免弹」
 * 分支），所以「不再重复授权」只能靠**自己把 key 存住**。Zotero 把「始终允许」
 * 的 key 写在 profile 目录的 `localAPIKeys.json` 里，长期有效、可无限复用；本插件
 * 复制一份到 dsh 自己的数据目录，这样：
 *
 * 1. 重启 dsh / 重启 Zotero 都不用再点授权；
 * 2. 用户早先点过的「始终允许」能直接**导入**过来（升级后零点击）；
 * 3. 用户以后在 Zotero 里撤销授权 → 写请求 401 → 删掉本地副本，回到未授权态。
 *
 * 安全边界：key 等于「可写整个文库」的凭证。本文件只由 Host 进程读写，权限压到
 * `0600`（目录 `0700`），不经 HTTP 暴露、不进配置表单、不回显给模型。
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Zotero 生成的 key 是 32 位字母数字；不合形状的一律不认。 */
const KEY_PATTERN = /^[A-Za-z0-9]{32}$/u

/** 本插件在 dsh 数据目录下的落点（与其它插件同住 `storages/<plugin>`）。 */
function keyFilePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-plugin-zotero', 'local-api-key.json')
}

/** 读本地副本；没有、坏了、形状不对都当「没有」。 */
export async function loadStoredKey(): Promise<string | null> {
  try {
    const text = await readFile(keyFilePath(), 'utf8')
    const parsed: unknown = JSON.parse(text)
    const key = (parsed as { key?: unknown } | null)?.key
    return typeof key === 'string' && KEY_PATTERN.test(key) ? key : null
  } catch {
    return null
  }
}

/** 存本地副本（best-effort：存不下来不影响本次授权本身）。 */
export async function storeKey(key: string): Promise<void> {
  if (!KEY_PATTERN.test(key)) return
  const file = keyFilePath()
  try {
    await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify({ key, savedAt: new Date().toISOString() }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    // 文件已存在时 mode 不生效，补一刀。
    await chmod(file, 0o600)
  } catch (error) {
    console.warn('[dsh-plugin-zotero] 写权限凭证落盘失败：', error)
  }
}

/** 删本地副本（key 失效或用户撤销授权时调用）。 */
export async function forgetKey(): Promise<void> {
  try {
    await rm(keyFilePath(), { force: true })
  } catch (error) {
    console.warn('[dsh-plugin-zotero] 清除本机写权限凭证失败：', error)
  }
}

// ---- 从 Zotero 自己的密钥库导入 ---------------------------------------------

/** Zotero 的 profiles.ini 所在目录（各平台固定，Zotero 未提供查询接口）。 */
function dataRoots(): string[] {
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
function parseProfilesIni(text: string, root: string): string[] {
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

interface ZoteroKeyEntry {
  key?: unknown
  appName?: unknown
  remember?: unknown
  createdAt?: unknown
}

/** 一个 profile 里、本应用名下的「始终允许」key（按新→旧）。 */
async function rememberedKeysIn(dir: string, appName: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(dir, 'localAPIKeys.json'), 'utf8')
  } catch {
    return []
  }
  let entries: ZoteroKeyEntry[]
  try {
    const parsed = JSON.parse(text) as { keys?: unknown }
    entries = Array.isArray(parsed.keys) ? (parsed.keys as ZoteroKeyEntry[]) : []
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.appName === appName && entry.remember === true)
    .filter((entry): entry is ZoteroKeyEntry & { key: string } =>
      typeof entry.key === 'string' && KEY_PATTERN.test(entry.key))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .map((entry) => entry.key)
}

/**
 * 找一条 Zotero 已经发给**本插件**（按 appName 认）的「始终允许」key。
 *
 * 用于升级后首次启动：用户之前点过「始终允许」，key 一直躺在 Zotero 的密钥库里，
 * 不需要再弹一次框。找不到就返回 `null`（再点一次授权即可）。
 */
export async function readZoteroRememberedKey(appName: string): Promise<string | null> {
  for (const root of dataRoots()) {
    let ini: string
    try {
      ini = await readFile(join(root, 'profiles.ini'), 'utf8')
    } catch {
      continue
    }
    for (const dir of parseProfilesIni(ini, root)) {
      const [key] = await rememberedKeysIn(dir, appName)
      if (key !== undefined) return key
    }
  }
  return null
}
