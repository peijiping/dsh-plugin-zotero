/**
 * 「添加到会话」的共享动作集。
 *
 * 主面板与条目 tab 都挂一份，行为必须一致：所有引用（包括划选摘录）都插 chip，
 * 输入框里只有胶囊，完整文本在提交时由 codec 展开；结果统一走 toast。
 * `inputActions` 缺失表示当前面板不在会话上下文。
 */

import { useCallback } from 'react'

import type { ZoteroAnnotation, ZoteroCollection, ZoteroItemDetail, ZoteroNote } from '../zotero/types'
import { annotationChipLabel, excerptChipLabel, tagSetChipLabel, translationChipLabel } from './compose'
import type { InputActions, InsertOutcome } from './inline'
import type { Translate } from './locales'
import { tpl } from './locales'
import { showToast } from './paneStore'
import type { ReferenceInsert, SessionsFace } from './reference'
import {
  annotationReference,
  collectionReference,
  excerptReference,
  insertChip,
  MAX_EXCERPT_CHARS,
  MAX_TAG_REFERENCE,
  itemReference,
  noteReference,
  tagReference,
  tagSetReference,
  translationReference,
} from './reference'

export interface InsertionActions {
  report(outcome: InsertOutcome): void
  insertReference(reference: ReferenceInsert): void
  insertItem(key: string, title: string): void
  /** 一段划选摘录：插一枚自带原文的 chip，不再是灌进草稿的一大段纯文本。 */
  insertExcerpt(target: ZoteroItemDetail, quote: string): void
  /** 一段划词翻译：原文与译文一起定格进 chip，提交时展开成对照文本。 */
  insertTranslation(target: ZoteroItemDetail, quote: string, translated: string): void
  insertAnnotation(target: ZoteroItemDetail, annotation: ZoteroAnnotation): void
  insertNote(target: ZoteroItemDetail, note: ZoteroNote): void
  insertCollection(collection: ZoteroCollection): void
  /** 选中几条插几个条目 chip（每条一个胶囊）；草稿中途变化就停在已插入的那条。 */
  insertItems(items: readonly { key: string; title: string }[]): void
  /** 单个标签 chip。 */
  insertTag(name: string): void
  /** 多个标签合并成一个 chip；超过 {@link MAX_TAG_REFERENCE} 时提示并不插入。 */
  insertTagSet(names: readonly string[], mode: 'all' | 'any'): void
}

export function useInsertion(
  t: Translate,
  sessions: SessionsFace,
  sessionId: string | undefined,
  inputActions: InputActions | undefined,
): InsertionActions {
  const report = useCallback((outcome: InsertOutcome): void => {
    if (outcome === 'inserted') showToast(t('toast.inserted'))
    else if (outcome === 'no-editor') showToast(t('error.noEditor'))
    else showToast(t('error.draftChanged'))
  }, [t])

  /** 插一个引用 chip：草稿里只留 key，完整文本在提交那一刻由引用源的 codec 现取。 */
  const insertReference = useCallback((reference: ReferenceInsert): void => {
    if (!inputActions) {
      report('no-editor')
      return
    }
    report(insertChip(sessions, sessionId, reference, inputActions.captureInsertion()) ? 'inserted' : 'draft-changed')
  }, [inputActions, report, sessionId, sessions])

  const insertItem = useCallback((key: string, title: string): void => {
    insertReference(itemReference(key, title))
  }, [insertReference])

  /**
   * 批量引用选中条目。
   *
   * 每条单独 capture → insert：插完一个 chip 草稿版本就变了，复用第一次的 span
   * 会被宿主的 rev 校验挡掉。宿主每次插入都是同步落盘的编辑器事务，所以循环里
   * 连续 capture 拿到的始终是最新位置。
   */
  const insertItems = useCallback((items: readonly { key: string; title: string }[]): void => {
    if (!inputActions) {
      report('no-editor')
      return
    }
    if (items.length === 0) {
      showToast(t('error.empty'))
      return
    }
    let inserted = 0
    for (const item of items) {
      const ref = itemReference(item.key, item.title)
      if (!insertChip(sessions, sessionId, ref, inputActions.captureInsertion())) break
      inserted += 1
    }
    if (inserted === 0) {
      report('draft-changed')
      return
    }
    showToast(inserted === items.length
      ? tpl(t('toast.insertedItems'), { n: inserted })
      : tpl(t('error.partialInsert'), { n: inserted }))
  }, [inputActions, report, sessionId, sessions, t])

  const insertExcerpt = useCallback((target: ZoteroItemDetail, quote: string): void => {
    if (quote.trim() === '') {
      showToast(t('error.empty'))
      return
    }
    if (Array.from(quote).length > MAX_EXCERPT_CHARS) {
      showToast(tpl(t('error.excerptTooLong'), { n: MAX_EXCERPT_CHARS }))
      return
    }
    insertReference(excerptReference(
      target.key,
      target.title,
      quote,
      excerptChipLabel(t, quote),
    ))
  }, [insertReference, t])

  /**
   * 插入一段「原文 + 译文」。
   *
   * 上限按两段合计算：ref 里存的是双份文本，单看原文会低估草稿体积。
   */
  const insertTranslation = useCallback((
    target: ZoteroItemDetail,
    quote: string,
    translated: string,
  ): void => {
    if (quote.trim() === '' || translated.trim() === '') {
      showToast(t('error.empty'))
      return
    }
    if (Array.from(quote).length + Array.from(translated).length > MAX_EXCERPT_CHARS) {
      showToast(tpl(t('error.excerptTooLong'), { n: MAX_EXCERPT_CHARS }))
      return
    }
    insertReference(translationReference(
      target.key,
      target.title,
      quote,
      translated,
      translationChipLabel(t, translated),
    ))
  }, [insertReference, t])

  const insertAnnotation = useCallback((
    target: ZoteroItemDetail,
    annotation: ZoteroAnnotation,
  ): void => {
    insertReference(annotationReference(target.key, annotation.key, annotationChipLabel(t, annotation)))
  }, [insertReference, t])

  const insertNote = useCallback((target: ZoteroItemDetail, note: ZoteroNote): void => {
    insertReference(noteReference(target.key, note.key, note.title))
  }, [insertReference])

  const insertCollection = useCallback((collection: ZoteroCollection): void => {
    insertReference(collectionReference(collection.key, collection.name))
  }, [insertReference])

  const insertTag = useCallback((name: string): void => {
    insertReference(tagReference(name))
  }, [insertReference])

  const insertTagSet = useCallback((names: readonly string[], mode: 'all' | 'any'): void => {
    const unique = [...new Set(names.filter((name) => name.trim() !== ''))]
    if (unique.length === 0) {
      showToast(t('error.empty'))
      return
    }
    if (unique.length > MAX_TAG_REFERENCE) {
      showToast(tpl(t('error.tooManyTags'), { n: MAX_TAG_REFERENCE }))
      return
    }
    if (unique.length === 1) {
      insertReference(tagReference(unique[0]))
      return
    }
    insertReference(tagSetReference(unique, mode, tagSetChipLabel(t, unique, mode)))
  }, [insertReference, t])

  return {
    report,
    insertReference,
    insertItem,
    insertExcerpt,
    insertTranslation,
    insertAnnotation,
    insertNote,
    insertCollection,
    insertItems,
    insertTag,
    insertTagSet,
  }
}