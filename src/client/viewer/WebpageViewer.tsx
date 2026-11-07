/**
 * 网页类型条目的兜底视图：没有保存网页快照时，只说明情况并给出原网址。
 *
 * 不尝试在线 iframe：绝大多数站点用 `X-Frame-Options` / `frame-ancestors` 拒绝被
 * 嵌入，结果只会是一个空白框 —— 不如直接交给系统浏览器。
 *
 * 有全文索引时把正文接在下面（复用 {@link TextViewer}），免得用户点开一条只能
 * 看到一句「没有快照」。
 */

import type { ReactElement } from 'react'

import type { DocumentRendererProps } from './types'
import { TextViewer } from './TextViewer'

/** 只放行 http(s)：Zotero 的 `url` 字段来自抓取，不能无条件当成安全链接。 */
function safeHttpUrl(raw: string): string | null {
  if (raw.trim() === '') return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function WebpageViewer(props: DocumentRendererProps): ReactElement {
  const { t, detail } = props
  const linked = safeHttpUrl(detail.url)
  const hasText = detail.fulltext !== null

  return (
    <div style={rootStyle}>
      <div style={hintStyle}>
        <div style={hintTextStyle}>
          <div>{hasText ? t('detail.noSnapshotHint') : t('detail.noSnapshot')}</div>
          {!hasText && detail.url !== '' && <div style={urlStyle}>{detail.url}</div>}
        </div>
        {linked !== null && (
          <a href={linked} target="_blank" rel="noreferrer noopener" style={linkStyle}>
            {t('detail.openOriginal')}
          </a>
        )}
      </div>
      {hasText && (
        <div style={bodyStyle}>
          <TextViewer {...props} />
        </div>
      )}
    </div>
  )
}

const rootStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
} as const

const hintStyle = {
  flexShrink: 0,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '8px 12px',
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  fontSize: 11.5,
  lineHeight: 1.5,
  opacity: 0.9,
} as const

const hintTextStyle = {
  flex: 1,
  minWidth: 0,
} as const

const urlStyle = {
  marginTop: 2,
  opacity: 0.6,
  wordBreak: 'break-all',
} as const

const linkStyle = {
  flexShrink: 0,
  padding: '2px 8px',
  fontSize: 11.5,
  borderRadius: 5,
  border: '1px solid rgba(127,127,127,0.35)',
  color: 'inherit',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
} as const

const bodyStyle = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
} as const
