/**
 * 文档视图外壳：选渲染器、挂工具条、把页面级状态留给渲染器。
 *
 * 这里不关心文档格式——PDF / 文本 / 将来的 Word 都从 `registry` 里挑。
 * 工具条只按渲染器的 `capabilities` 显示缩放与页码控件。
 */

import { useCallback, useState, type MutableRefObject, type ReactElement } from 'react'

import type { ZoteroAnnotation, ZoteroItemDetail } from '../../zotero/types'
import { tpl, type Translate } from '../locales'
import { pickRenderer } from './registry'
import type { DocumentSource, ViewerHandle, ZoomState } from './types'

interface Props {
  t: Translate
  detail: ZoteroItemDetail
  source: DocumentSource | null
  annotations: ZoteroAnnotation[]
  viewerRef: MutableRefObject<ViewerHandle | null>
  onReady(): void
  onInsertExcerpt(quote: string): void
  onInsertAnnotation(annotation: ZoteroAnnotation): void
  onOpenInZotero(page: number): void
  onChanged(): void
}

export function DocumentView({
  t,
  detail,
  source,
  annotations,
  viewerRef,
  onReady,
  onInsertExcerpt,
  onInsertAnnotation,
  onOpenInZotero,
  onChanged,
}: Props): ReactElement {
  const renderer = pickRenderer(source, detail)
  const Renderer = renderer.Component
  const [zoom, setZoom] = useState<ZoomState>({ percent: 100, fitWidth: true })
  const [page, setPage] = useState({ current: 1, total: 0 })

  const handleZoomChange = useCallback((state: ZoomState): void => setZoom(state), [])
  const handlePageChange = useCallback((current: number, total: number): void => {
    setPage({ current, total })
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={barStyle}>
        <span style={titleStyle} title={source?.title ?? detail.title}>{source?.title ?? detail.title}</span>
        {renderer.capabilities.pageNavigation && page.total > 0 && (
          <span style={pageStyle} title={t('viewer.page')}>
            {tpl(t('viewer.pageOf'), { n: page.current, total: page.total })}
          </span>
        )}
        {renderer.capabilities.zoom && (
          <>
            <button
              type="button"
              onClick={() => viewerRef.current?.zoomOut()}
              style={toolButtonStyle}
              aria-label={t('viewer.zoomOut')}
              title={t('viewer.zoomOut')}
            >
              −
            </button>
            <span style={zoomStyle}>{zoom.percent}%</span>
            <button
              type="button"
              onClick={() => viewerRef.current?.zoomIn()}
              style={toolButtonStyle}
              aria-label={t('viewer.zoomIn')}
              title={t('viewer.zoomIn')}
            >
              +
            </button>
            <button
              type="button"
              onClick={() => viewerRef.current?.fitToWidth()}
              style={{ ...toolButtonStyle, opacity: zoom.fitWidth ? 1 : 0.6 }}
              aria-label={t('viewer.fitWidth')}
              title={t('viewer.fitWidth')}
            >
              ⤢
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => onOpenInZotero(page.current)}
          style={toolButtonStyle}
          title={t('viewer.openInZotero')}
        >
          {t('viewer.openInZoteroShort')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Renderer
          key={source?.attachmentKey ?? 'none'}
          t={t}
          detail={detail}
          source={source}
          annotations={annotations}
          viewerRef={viewerRef}
          onReady={onReady}
          onZoomChange={handleZoomChange}
          onPageChange={handlePageChange}
          onInsertExcerpt={onInsertExcerpt}
          onInsertAnnotation={onInsertAnnotation}
          onOpenInZotero={onOpenInZotero}
          onChanged={onChanged}
        />
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
  height: 30,
  padding: '0 8px 0 40px',
  borderBottom: '1px solid rgba(127,127,127,0.2)',
  background: 'transparent',
} as const

const titleStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  opacity: 0.62,
} as const

const pageStyle = {
  flexShrink: 0,
  fontSize: 11,
  opacity: 0.72,
  fontVariantNumeric: 'tabular-nums',
} as const

const zoomStyle = {
  flexShrink: 0,
  minWidth: 34,
  textAlign: 'center',
  fontSize: 11,
  opacity: 0.72,
  fontVariantNumeric: 'tabular-nums',
} as const

const toolButtonStyle = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 22,
  minWidth: 22,
  padding: '0 5px',
  fontSize: 11.5,
  lineHeight: 1,
  borderRadius: 5,
  border: '1px solid rgba(127,127,127,0.3)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const
