/**
 * PDF.js 运行时初始化与样式。
 *
 * Worker / cmaps / 标准字体 / wasm 都由 Host 的 `/dsh-zotero/static/*`
 * 提供（见 `src/host/static.ts`，资产根就是打包出的 `client/pdfjs/`），
 * 因此 workerSrc 必须是同源绝对路径。
 * 文本层的 CSS 只保留 PDF.js 6 必需的最小集合：定位、缩放变量与选区。
 */

import { GlobalWorkerOptions } from 'pdfjs-dist'

export const PDF_ASSET_BASE = '/dsh-zotero/static/'

GlobalWorkerOptions.workerSrc = `${PDF_ASSET_BASE}pdf.worker.min.mjs`

export const PDF_CSS = `
.dsh-zotero-pdf-scroll {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: rgba(127,127,127,0.10);
  overscroll-behavior: contain;
  /* 滚动位置由我们自己锚定（缩放定点、续读跳页），别让浏览器顺带再调一次。 */
  overflow-anchor: none;
}
/* 滚动中不画文本层：字本来就是透明的，它只在划选时才有用；撤掉能省下大面积
   字形光栅化，滚动就只剩搬 canvas 的像素。停手 140ms 后由 JS 摘掉标记放回来。 */
.dsh-zotero-pdf-scroll[data-zp-scrolling] .dsh-zotero-pdf-text {
  visibility: hidden;
}
.dsh-zotero-pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 12px;
  min-width: min-content;
}
.dsh-zotero-pdf-page {
  position: relative;
  flex: none;
  background: #fff;
  box-shadow: 0 1px 5px rgba(0,0,0,0.22);
  overflow: hidden;
  /* 把高亮层的混合模式关在页面内，避免合成器跨页重算整个滚动容器。 */
  isolation: isolate;
  contain: paint;
}
.dsh-zotero-pdf-canvas-host {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.dsh-zotero-pdf-canvas {
  display: block;
  background: #fff;
}
.dsh-zotero-pdf-text {
  position: absolute;
  inset: 0;
  overflow: clip;
  text-align: initial;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  z-index: 1;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.dsh-zotero-pdf-text :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text;
}
.dsh-zotero-pdf-text > :not(.markedContent),
.dsh-zotero-pdf-text .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.dsh-zotero-pdf-text .markedContent {
  display: contents;
}
.dsh-zotero-pdf-text ::selection {
  background: rgba(0, 100, 255, 0.28);
  color: transparent;
}
/* 换行占位（由 moveLineBreaksOffscreen 生成）：只提供 \n，不参与绘制。 */
.dsh-zotero-pdf-text .dsh-zotero-pdf-eol {
  left: -9999px;
  top: 0;
  font-size: 0;
  line-height: 0;
}
.dsh-zotero-pdf-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}
.dsh-zotero-ann-flash {
  outline: 2px solid transparent;
  outline-offset: 1px;
  animation: dsh-zotero-ann-flash 1.1s ease-in-out 1;
}
@keyframes dsh-zotero-ann-flash {
  0%, 100% { outline-color: transparent; }
  20%, 80% { outline-color: rgba(80,140,255,0.95); }
}
`
