/**
 * 文案字典（zh / en）。
 *
 * `t()` 只接受 key、返回字符串本身，不带插值；需要插值处用 {@link tpl}。
 * namespace 与 client 注册时使用的 NS 保持一致。
 */

export const NS = 'dsh-plugin-zotero'

export type Translate = (key: string) => string

/** 极简占位符替换：`{name}` → 变量值。 */
export function tpl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (_, key: string) => {
    const value = vars[key]
    return value === undefined ? '' : String(value)
  })
}

const zh: Record<string, string> = {
  'tab.title': 'Zotero 文献库',
  'guide.title': 'Zotero 文献库',
  'guide.desc': '浏览本地 Zotero 文库，把条目、摘录或整个目录加入当前会话',

  'action.refresh': '刷新',
  'action.insertItem': '添加条目引用',
  'action.insertExcerpt': '添加摘录',
  'action.insertCollection': '添加整目录引用',

  'status.zoteroOn': 'Zotero 已连接',
  'status.zoteroOff': 'Zotero 未连接',
  'status.mcpOn': '模型工具可用',
  'status.mcpOff': '模型工具不可用',
  'status.loading': '加载中…',

  'tree.library': '我的文库',
  'tree.searchPlaceholder': '搜索标题 / 摘要',
  'tree.count': '{n} 条',
  'tree.empty': '这个分类下没有条目',

  'detail.empty': '从左侧选择分类或条目',
  'detail.creators': '作者',
  'detail.year': '年份',
  'detail.source': '出处',
  'detail.doi': 'DOI',
  'detail.url': '链接',
  'detail.abstract': '摘要',
  'detail.tags': '标签',
  'detail.attachments': '附件',
  'detail.fulltext': '全文',
  'detail.noFulltext': '该附件没有可用的全文索引',
  'detail.fulltextTruncated': '（已按长度截断）',
  'detail.collectionSummary': '分类：{name}',
  'detail.collectionCount': '共 {n} 条条目',
  'detail.bibTitle': '参考文献（APA）',
  'detail.noBib': '该分类没有可导出的引用条目（裸 PDF 附件不产生引用）',

  'error.noEditor': '当前面板不在会话上下文中，无法插入到输入框',
  'error.draftChanged': '输入框草稿已变化，未插入；请避免在插入期间编辑草稿',
  'error.empty': '没有可插入的内容',

  'toast.inserted': '已添加到会话草稿',

  'cmp.item.header': '【Zotero 条目｜{key}】{title}',
  'cmp.item.creators': '作者：{value}',
  'cmp.item.year': '年份：{value}',
  'cmp.item.source': '出处：{value}',
  'cmp.item.doi': 'DOI：{value}',
  'cmp.item.url': '链接：{value}',
  'cmp.item.tags': '标签：{value}',
  'cmp.item.abstract': '摘要：{value}',
  'cmp.excerpt.header': '【Zotero 摘录｜{title}｜{key}】',
  'cmp.excerpt.quote': '“{value}”',
  'cmp.collection.header': '【Zotero 目录｜{name}｜{key}】共 {n} 条',
  'cmp.collection.line': '- {title}（{meta}）',
  'cmp.collection.more': '……（仅列出前 {n} 条；完整清单可用 mcp__zotero__get_collection_items 获取）',
}

const en: Record<string, string> = {
  'tab.title': 'Zotero Library',
  'guide.title': 'Zotero Library',
  'guide.desc': 'Browse the local Zotero library and add items, excerpts or whole collections to this conversation',

  'action.refresh': 'Refresh',
  'action.insertItem': 'Add item citation',
  'action.insertExcerpt': 'Add excerpt',
  'action.insertCollection': 'Add collection citations',

  'status.zoteroOn': 'Zotero connected',
  'status.zoteroOff': 'Zotero not connected',
  'status.mcpOn': 'Model tools available',
  'status.mcpOff': 'Model tools unavailable',
  'status.loading': 'Loading…',

  'tree.library': 'My Library',
  'tree.searchPlaceholder': 'Search title / abstract',
  'tree.count': '{n} items',
  'tree.empty': 'No items in this collection',

  'detail.empty': 'Select a collection or item on the left',
  'detail.creators': 'Creators',
  'detail.year': 'Year',
  'detail.source': 'Source',
  'detail.doi': 'DOI',
  'detail.url': 'URL',
  'detail.abstract': 'Abstract',
  'detail.tags': 'Tags',
  'detail.attachments': 'Attachments',
  'detail.fulltext': 'Full text',
  'detail.noFulltext': 'No full-text index available for this attachment',
  'detail.fulltextTruncated': '(truncated by length)',
  'detail.collectionSummary': 'Collection: {name}',
  'detail.collectionCount': '{n} items',
  'detail.bibTitle': 'Bibliography (APA)',
  'detail.noBib': 'Nothing citable here (bare PDF attachments produce no citation)',

  'error.noEditor': 'This panel is not in a conversation context; cannot insert into the composer',
  'error.draftChanged': 'The draft changed; nothing was inserted. Avoid editing while inserting.',
  'error.empty': 'Nothing to insert',

  'toast.inserted': 'Added to the conversation draft',

  'cmp.item.header': '[Zotero item | {key}] {title}',
  'cmp.item.creators': 'Creators: {value}',
  'cmp.item.year': 'Year: {value}',
  'cmp.item.source': 'Source: {value}',
  'cmp.item.doi': 'DOI: {value}',
  'cmp.item.url': 'URL: {value}',
  'cmp.item.tags': 'Tags: {value}',
  'cmp.item.abstract': 'Abstract: {value}',
  'cmp.excerpt.header': '[Zotero excerpt | {title} | {key}]',
  'cmp.excerpt.quote': '“{value}”',
  'cmp.collection.header': '[Zotero collection | {name} | {key}] {n} items',
  'cmp.collection.line': '- {title} ({meta})',
  'cmp.collection.more': '… (first {n} only; use mcp__zotero__get_collection_items for the full list)',
}

export const dicts = { zh, en }
