/**
 * 信息浮层里各区块的开合状态（文献信息 / 摘要 / 标注 / 笔记 / 附件 / 参考文献）。
 *
 * 每个人看文献的偏好几十年不变：常看标注、从不开摘要、参考文献只在写论文时才摊开。
 * 所以这里的开合必须记住——收起浮层、切到别的文献、重启 IDE 之后都保持原样。
 *
 * 状态是**全局一份**，不按条目 key 分开存：换一篇文献还是同一个人在看，
 * 按 key 存等于每篇都得重新折一遍。存在模块级单例里让所有条目 tab 共享同一份，
 * 再落 localStorage 跨会话留存。
 */

import { useEffect, useState } from 'react'

/** 区块 id；与 InfoPanel 里的渲染顺序一致。 */
export type InfoSectionId =
  | 'metadata'
  | 'abstract'
  | 'annotations'
  | 'notes'
  | 'attachments'
  | 'bib'

export type InfoSections = Record<InfoSectionId, boolean>

const STORAGE_KEY = 'dsh-plugin-zotero.info-sections.v1'

/** 首次使用（或读取失败）的默认开合：把次要的两块收起来，免得浮层一开就过长。 */
const DEFAULTS: InfoSections = {
  metadata: true,
  abstract: true,
  annotations: true,
  notes: false,
  attachments: true,
  bib: false,
}

function isSectionId(value: string): value is InfoSectionId {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, value)
}

/** 读存下的状态；缺失的字段用默认值补齐（将来加新区块时老存档也能用）。 */
function load(): InfoSections {
  const fallback: InfoSections = { ...DEFAULTS }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSectionId(key) && typeof value === 'boolean') fallback[key] = value
    }
    return fallback
  } catch {
    // 隐私模式禁用 localStorage / 存档是坏 JSON：都退回默认，不影响使用。
    return fallback
  }
}

let sections: InfoSections = load()
const listeners = new Set<() => void>()

function persist(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sections))
  } catch {
    // 写不进去就只在本会话内生效，下次启动回到默认。
  }
}

function patch(next: InfoSections): void {
  sections = next
  persist()
  for (const listener of listeners) listener()
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

export function toggleInfoSection(id: InfoSectionId): void {
  patch({ ...sections, [id]: !sections[id] })
}

/** 显式设置开合（如点「笔记」加号时先把区块摊开）。 */
export function setInfoSection(id: InfoSectionId, open: boolean): void {
  if (sections[id] === open) return
  patch({ ...sections, [id]: open })
}
