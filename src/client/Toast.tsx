/**
 * 会话草稿提示条（模块级 toast 的视图）。
 *
 * 主面板与每个条目 tab 各挂一份；分屏时可能同时出现两条相同提示，可接受。
 */

import type { ReactElement } from 'react'

import { useToast } from './paneStore'

export function Toast(): ReactElement | null {
  const toast = useToast()
  if (toast === null) return null
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 14,
        transform: 'translateX(-50%)',
        padding: '5px 12px',
        borderRadius: 6,
        background: 'rgba(40,40,40,0.92)',
        color: '#fff',
        fontSize: 12,
        // 压过目录 / 译文浮层（300）：「已复制」这类即时反馈不能被浮层盖住。
        zIndex: 400,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {toast}
    </div>
  )
}