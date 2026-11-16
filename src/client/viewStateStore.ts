/**
 * 视图状态：**信息浮层六块的开合** + **每个条目上目录 / 信息浮层被拖到哪、拉多大**。
 *
 * 这两样和「读到第几页」一起存在 Host 的 `<dsh 数据目录>/storages/dsh-plugin-zotero/
 * view-state.json` 里（见 `src/zotero/view-state.ts`）：换台机器、清了浏览器存储都还在，
 * 也能直接打开文件看一眼。
 *
 * 为什么要分两个粒度：
 *
 * - **开合全局一份**：常看标注、从不开摘要，换哪篇文献都一样，按条目存等于每篇都
 *   得重新折一遍；
 * - **几何按条目一份**：这篇的目录窗口摆在左边，下一篇可能就得挪到别处。
 *
 * 读取是**一次拿全量**（文件几十 KB），之后同步读模块级缓存 —— 浮层打开时不用等
 * 网络，几何在首帧就是对的位置，不会先画到初始位再跳过去。写入按 500ms 防抖合并
 * 成一次请求；Host 不可达时静默退回默认值，不影响阅读。
 */

import { useEffect, useState } from 'react'

import type { ZoteroItemBoxes, ZoteroPanelKind, ZoteroPanelPos, ZoteroPanelSize } from '../zotero/types'
import { fetchViewState, saveViewState, type PanelBoxPatch } from './api'

/** 区块 id；与 InfoPanel 里的渲染顺序一致。 */
export type InfoSectionId =
  | 'metadata'
  | 'abstract'
  | 'annotations'
  | 'notes'
  | 'attachments'
  | 'bib'

export type InfoSections = Record<InfoSectionId, boolean>

/** 首次使用（或读取失败）的默认开合：把次要的两块收起来，免得浮层一开就过长。 */
const DEFAULTS: InfoSections = {
  metadata: true,
  abstract: true,
  annotations: true,
  notes: false,
  attachments: true,
  bib: false,
}

/** 一类浮层在某条目上记住的几何。两项独立：只拖过位置就没有 `size`。 */
export interface PanelGeometry {
  pos?: ZoteroPanelPos
  size?: ZoteroPanelSize
}

/** 写请求合并窗口：拖完手一松就到点，感觉像即时保存。 */
const SAVE_DELAY_MS = 500

let sections: InfoSections = { ...DEFAULTS }
let boxes: Record<string, ZoteroItemBoxes> = {}
const listeners = new Set<() => void>()

/** 首屏拉取只发一次；`null` 表示还没试过或正在试。 */
let loading: Promise<void> | null = null
let loaded = false
/** 本地先动过手：此时不能被慢半拍回来的存档覆盖。 */
let touched = false

function isSectionId(value: string): value is InfoSectionId {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, value)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** 只认已知区块 + 布尔值，缺的用默认补齐（将来加新区块时老存档也能用）。 */
function normalizeSections(raw: Record<string, unknown> | undefined): InfoSections {
  const result: InfoSections = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (isSectionId(key) && typeof value === 'boolean') result[key] = value
  }
  return result
}

function normalizeBoxes(raw: Record<string, ZoteroItemBoxes> | undefined): Record<string, ZoteroItemBoxes> {
  const result: Record<string, ZoteroItemBoxes> = {}
  for (const [itemKey, entry] of Object.entries(raw ?? {})) {
    if (typeof entry !== 'object' || entry === null) continue
    const next: ZoteroItemBoxes = {}
    for (const kind of ['outline', 'info'] as const) {
      const box = entry[kind]
      if (box === undefined) continue
      const pos = box.pos === undefined ? undefined : { left: box.pos.left, top: box.pos.top }
      const size = box.size === undefined ? undefined : { width: box.size.width, height: box.size.height }
      if (pos === undefined && size === undefined) continue
      next[kind] = { ...(pos === undefined ? {} : { pos }), ...(size === undefined ? {} : { size }), at: box.at }
    }
    if (next.outline !== undefined || next.info !== undefined) result[itemKey] = next
  }
  return result
}

// ---- 从 localStorage 迁移 ---------------------------------------------------

/**
 * 0.8.1 及更早版本的折叠状态存在这里。
 *
 * 那时候没有 Host 侧存档，六块开合只落在浏览器 Local Storage（LevelDB 里），
 * 换个客户端 / 清了站点数据就没了。现在搬进 `view-state.json`。
 */
const LEGACY_SECTIONS_KEY = 'dsh-plugin-zotero.info-sections.v1'

/** 读旧键：没有、坏 JSON、一个认识的区块都没有，都返回 `null`。 */
function readLegacySections(): InfoSections | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LEGACY_SECTIONS_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const result: InfoSections = { ...DEFAULTS }
    let found = false
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isSectionId(key) || typeof value !== 'boolean') continue
      result[key] = value
      found = true
    }
    return found ? result : null
  } catch {
    return null
  }
}

/**
 * 把 0.8.1 留在 localStorage 的折叠状态搬进 Host 存档，**只跑一次**。
 *
 * 只在存档里还没有 `sections` 时动手：用户已经在新版里折过就别再搬，否则旧偏好
 * 会盖掉刚折好的新偏好。写成功才删旧键 —— Host 不可达（典型是更新完没重启 DSH）
 * 时旧键留着，本会话仍按迁过来的值显示，下次启动再迁一次。整个迁移是幂等的。
 */
function migrateLegacySections(saved: Record<string, boolean> | undefined): void {
  if (Object.keys(saved ?? {}).length > 0) return
  const legacy = readLegacySections()
  if (legacy === null) return
  sections = legacy
  void saveViewState({ sections: { ...legacy } })
    .then(() => {
      try {
        window.localStorage.removeItem(LEGACY_SECTIONS_KEY)
      } catch {
        // 删不掉无所谓：Host 里已有 sections，下次启动看到非空就不会再迁。
      }
    })
    .catch(() => {
      // 存不上就留旧键，下次启动重试；本会话已经用上迁过来的值。
    })
}

// ---- 读 ---------------------------------------------------------------------

/** 拉一次全量视图状态。重复调用只会发一次请求。 */
export function bootstrapViewState(): void {
  if (loaded || loading !== null) return
  loading = fetchViewState()
    .then((state) => {
      if (!touched) {
        sections = normalizeSections(state.sections)
        // 老用户从 0.8.1 升上来：折叠状态原先只在浏览器里，搬进 Host 存档。
        migrateLegacySections(state.sections)
      }
      // 拉回来之前用户可能已经拖过某个窗口：本地那条优先，别被存档盖掉。
      for (const [itemKey, entry] of Object.entries(normalizeBoxes(state.boxes))) {
        if (boxes[itemKey] === undefined) boxes[itemKey] = entry
      }
      loaded = true
      notify()
    })
    .catch(() => {
      // Host 不可达 / 本地 API 没开：用默认值，下次打开面板再试一遍。
      //
      // 但旧版留在浏览器里的折叠状态是本地读得到的 —— 先照着它显示，避免
      // 「更新完没重启 DSH」时看起来像偏好丢了。这里**不删键**：写不进 Host
      // 就留着，等哪次真写成功再由迁移删。
      const legacy = readLegacySections()
      if (legacy === null || touched) return
      sections = legacy
      notify()
    })
    .finally(() => {
      loading = null
    })
}

export function getInfoSections(): InfoSections {
  return sections
}

/** 订阅开合状态；任一区块变化都会触发重渲染。 */
export function useInfoSections(): InfoSections {
  const [snapshot, setSnapshot] = useState(getInfoSections)
  useEffect(() => {
    const listener = (): void => setSnapshot(getInfoSections())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return snapshot
}

/**
 * 取某条目某类浮层记住的几何；没记过返回 `null`（调用方用初始位置）。
 *
 * 同步读缓存 —— 所以浮层打开的那一帧就是记住的位置，不会闪一下初始位。
 */
export function readPanelBox(itemKey: string, kind: ZoteroPanelKind): PanelGeometry | null {
  const box = boxes[itemKey]?.[kind]
  if (box === undefined) return null
  return {
    ...(box.pos === undefined ? {} : { pos: box.pos }),
    ...(box.size === undefined ? {} : { size: box.size }),
  }
}

// ---- 写 ---------------------------------------------------------------------

let pendingSections: InfoSections | null = null
const pendingBoxes = new Map<string, PanelBoxPatch>()
let timer: number | null = null

/** 立刻把攒着的改动发出去（防抖到点、切条目、页面要卸载时都会调）。 */
export function flushViewState(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  const sectionsPatch = pendingSections
  const boxesPatch = [...pendingBoxes.values()]
  pendingSections = null
  pendingBoxes.clear()
  if (sectionsPatch === null && boxesPatch.length === 0) return
  void saveViewState({
    ...(sectionsPatch === null ? {} : { sections: { ...sectionsPatch } }),
    ...(boxesPatch.length === 0 ? {} : { boxes: boxesPatch }),
  }).catch((error: unknown) => {
    // 存不上就只影响「下次打开还在原位」，不该打断阅读，也不重试（下次动手会重写）。
    console.warn('[dsh-plugin-zotero] 保存视图状态失败：', error)
  })
}

function schedule(): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(flushViewState, SAVE_DELAY_MS)
}

export function toggleInfoSection(id: InfoSectionId): void {
  setInfoSection(id, !sections[id])
}

/** 显式设置开合（如点「笔记」加号时先把区块摊开）。 */
export function setInfoSection(id: InfoSectionId, open: boolean): void {
  if (sections[id] === open) return
  touched = true
  sections = { ...sections, [id]: open }
  pendingSections = sections
  notify()
  schedule()
}

/**
 * 记下某条目某类浮层的几何。
 *
 * 只传这次动过的那一项：拖位置就只传 `pos`，拉大小就只传 `size`，另一项保持原样
 * （没有就仍然没有，下次打开继续自适应）。缓存与请求都按项合并。
 */
export function writePanelBox(itemKey: string, kind: ZoteroPanelKind, patch: PanelGeometry): void {
  if (patch.pos === undefined && patch.size === undefined) return
  touched = true
  const prev = boxes[itemKey]?.[kind]
  const pos = patch.pos ?? prev?.pos
  const size = patch.size ?? prev?.size
  boxes = {
    ...boxes,
    [itemKey]: {
      ...boxes[itemKey],
      [kind]: { ...(pos === undefined ? {} : { pos }), ...(size === undefined ? {} : { size }), at: Date.now() },
    },
  }
  // 同一窗口连续拖，后一次已经包含前一次的结果，直接覆盖。
  pendingBoxes.set(`${itemKey}:${kind}`, {
    itemKey,
    kind,
    ...(pos === undefined ? {} : { pos }),
    ...(size === undefined ? {} : { size }),
  })
  schedule()
}

/** 页面要走了：把关在防抖里的改动补上（关标签页也丢不了刚拖的位置）。 */
let pageHookInstalled = false
function installPageHook(): void {
  if (pageHookInstalled || typeof window === 'undefined') return
  pageHookInstalled = true
  window.addEventListener('pagehide', flushViewState)
}

installPageHook()
