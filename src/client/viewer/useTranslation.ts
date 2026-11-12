/**
 * 划词翻译的状态机：一次选区 → 一个浮层。
 *
 * 发请求、保住「最近一次选区」用于重试、在关闭/换选区时撤掉在途请求；另外管一个
 * **会话级引擎覆盖**：设置页那份是长期默认值，浮层里换引擎只影响本次会话，
 * 刷新页面即回到默认值，避免同一个「默认引擎」有两处互相打架的配置源。
 * 定位与拖动交给 {@link TranslationCard}，这里只存初始锚点。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ApiFailure,
  translateSelection,
  type TranslateProvider,
  type TranslateResult,
} from '../api'
import type { Translate } from '../locales'

/** 浮层下拉的三个选项：`default` = 不覆盖，跟着设置页的默认引擎走。 */
export type EngineChoice = 'default' | TranslateProvider

/**
 * 会话级引擎覆盖（模块级变量，不写盘）。
 *
 * 三种文档渲染器各自有一个 `useTranslation` 实例，切换附件时旧实例卸载、新实例挂载；
 * 放在模块作用域才能让「刚换的引擎」跨渲染器沿用，同时页面一刷新就清空。
 */
let engineOverride: TranslateProvider | undefined

export type TranslationStatus = 'loading' | 'done' | 'error'

/** 浮层要渲染的全部内容（原文 + 结果 + 锚点）。 */
export interface TranslationView {
  /** 选中原文，浮层顶部作为摘要展示。 */
  text: string
  status: TranslationStatus
  result?: TranslateResult
  error?: string
  /** 选区在渲染器坐标里的锚点（浮层初始落点）。 */
  x: number
  y: number
}

export interface TranslationController {
  view: TranslationView | null
  /** 浮层下拉的当前选择（`default` = 跟随设置）。 */
  engine: EngineChoice
  /** 切换引擎：立刻用新引擎重译当前选区，并在本会话内沿用。 */
  setEngine(engine: EngineChoice): void
  /** 打开浮层并立刻发请求。 */
  open(text: string, x: number, y: number): void
  /** 用上一次原文重发。 */
  retry(): void
  close(): void
}

export function useTranslation(t: Translate): TranslationController {
  const [view, setView] = useState<TranslationView | null>(null)
  const [engine, setEngineState] = useState<EngineChoice>(() => engineOverride ?? 'default')
  const abortRef = useRef<AbortController | null>(null)

  const cancel = useCallback((): void => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  // 卸载时别把请求留在半空（宿主仍会写完，但没人接结果）。
  useEffect(() => () => cancel(), [cancel])

  const request = useCallback((text: string, x: number, y: number, choice: EngineChoice): void => {
    cancel()
    const controller = new AbortController()
    abortRef.current = controller
    setView({ text, status: 'loading', x, y })
    translateSelection(text, {
      // `default` 不传 provider：Host 自己读设置里的默认引擎。
      provider: choice === 'default' ? undefined : choice,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return
        setView((current) => (current !== null && current.text === text
          ? { ...current, status: 'done', result }
          : current))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setView((current) => (current !== null && current.text === text
          ? { ...current, status: 'error', error: messageOf(t, error) }
          : current))
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null
      })
  }, [cancel, t])

  const open = useCallback((text: string, x: number, y: number): void => {
    request(text, x, y, engine)
  }, [request, engine])

  const retry = useCallback((): void => {
    const current = view
    if (current === null) return
    request(current.text, current.x, current.y, engine)
  }, [request, view, engine])

  const setEngine = useCallback((next: EngineChoice): void => {
    engineOverride = next === 'default' ? undefined : next
    setEngineState(next)
    // 换引擎就得立刻重译，否则下拉值变了、译文还是上一家的，最容易被误读。
    const current = view
    if (current !== null) request(current.text, current.x, current.y, next)
  }, [request, view])

  const close = useCallback((): void => {
    cancel()
    // 覆盖值故意留着：同一会话里连着翻几段时不必每次重选；刷新页面才回默认。
    setView(null)
  }, [cancel])

  return { view, engine, setEngine, open, retry, close }
}

/**
 * 错误归一化。
 *
 * 参数类错误（选区过长、空文本）Host 给的中文文案最准确，直接用；其余（网络、
 * 服务端）统一一句「翻译失败」+ 重试按钮，不把 HTTP 细节糊到用户脸上。
 *
 * 唯一例外是「未知 action translate」：这是**宿主半还停在旧版本**（插件升级后没重启
 * DSH）才会出现的 404，原样抛给用户只会得到一句看不懂的路由错误。
 */
function messageOf(t: Translate, error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === 'bad_request') {
      if (error.message.includes('未知 action')) return t('translate.needRestart')
      return error.message
    }
    return t('translate.failed')
  }
  return t('translate.failed')
}
