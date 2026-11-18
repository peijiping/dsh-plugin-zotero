/**
 * PDF.js 运行时初始化与样式。
 *
 * Worker / cmaps / 标准字体 / wasm / `pdf_viewer.css` 都由 Host 的
 * `/dsh-zotero/static/*` 提供（见 `src/host/static.ts`，资产根就是打包出的
 * `client/pdfjs/`），因此 workerSrc 必须是同源绝对路径。
 *
 * 页面几何、文本层与缩放变量都由 pdf.js 的 `pdf_viewer.css` 负责；它由客户端
 * 取回后包进 `@scope (.dsh-zotero-pdf-scroll)` 注入（避免 `.page` / `.dialog` 这类
 * 通用类名影响 DSH 界面）。这里只补阅读器外壳的滚动区域、页面间距和自定义标注层，
 * 不重复实现文本层样式。
 *
 * 运行时走 pdf.js 的 legacy 构建：它内置 core-js polyfill，覆盖
 * `Map.prototype.getOrInsertComputed`、`Math.sumPrecise` 这类尚未在所有浏览器
 * 落地的提案 API；否则打开 PDF 会在 Worker 里直接抛
 * `this._requestsByChunk.getOrInsertComputed is not a function`。
 */

import { GlobalWorkerOptions, version } from 'pdfjs-dist/legacy/build/pdf.mjs'

export const PDF_ASSET_BASE = '/dsh-zotero/static/'

// 带版本号：静态资源响应有 24h 缓存，升级 pdf.js 后不能继续用旧 Worker。
GlobalWorkerOptions.workerSrc = `${PDF_ASSET_BASE}pdf.worker.min.mjs?v=${version}`

export const PDF_CSS = `
.dsh-zotero-pdf-scroll {
  /* pdf.js 的 PDFViewer 要求滚动容器绝对定位（它要自己接管 container 的尺寸）。 */
  position: absolute;
  inset: 0;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: rgba(127,127,127,0.10);
  overscroll-behavior: contain;
  /* 滚动位置由我们自己锚定（缩放定点、续读跳页），别让浏览器顺带再调一次。 */
  overflow-anchor: none;
}
/* pdf.js 的页面尺寸由它自己算；这里只调页间距、阴影，并让标注层有定位基准。 */
.dsh-zotero-pdf-scroll .pdfViewer {
  --page-margin: 12px auto 0;
  --page-border: 0;
  --pdfViewer-padding-bottom: 24px;
  position: relative;
  /* 标注层与页面是兄弟节点，高亮的 multiply 混合要有一个共同的合成边界。 */
  isolation: isolate;
}
.dsh-zotero-pdf-scroll .pdfViewer .page {
  border: 0;
  box-shadow: 0 1px 5px rgba(0,0,0,0.22);
}
/* 单页标注层：挂在 .pdfViewer 上，按每页 DOM 的 offset* 定位。 */
.dsh-zotero-pdf-ann-page {
  position: absolute;
  z-index: 2;
  pointer-events: none;
}
.dsh-zotero-pdf-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}
/* 换行占位（由 moveLineBreaksOffscreen 生成）：只提供 \n，不参与绘制。 */
.dsh-zotero-pdf-scroll .textLayer .dsh-zotero-pdf-eol {
  left: -9999px;
  top: 0;
  font-size: 0;
  line-height: 0;
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
