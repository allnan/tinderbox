import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  AnimFormat,
  AppInfo,
  AppSettings,
  ConvertGifRequest,
  GifParams,
  GifResult,
  HistoryEntry,
  JobPhase,
  JobProgress,
  SavedMedia,
  ThemeMode,
  TweetInfo,
  TweetMedia,
} from '../shared/types'
import { normalizeSettings } from '../core/settings'
import { animFormatLabel, clampParams, getPreset, normalizeParams, presetWidthForSource } from '../core/params'
import { createJobId, type JobStatus } from '../core/jobs'
import { isConvertibleKind, mediaKindLabel, normalizeTweetInput } from '../core/tweet'
import { useToast } from '../components/ui'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type AppView = 'parse' | 'history' | 'settings'

/** 界面侧转换任务；主进程只通过 job:progress 事件与 gif.convert 结果更新状态 */
export interface JobRecord {
  jobId: string
  kind: 'convert' | 'reencode' | 'save'
  tweetId: string
  mediaId: string
  media: TweetMedia
  label: string
  params: GifParams
  presetId: string | null
  /** 输出动图格式；旧任务/缺省按 gif */
  format?: AnimFormat
  status: JobStatus
  phase: JobPhase
  percent: number
  message: string
  error: string | null
  createdAt: number
  resultId: string | null
  /** 保存任务是否强制覆盖已有文件 */
  force?: boolean
}

/** 最长边预设：按每个媒体自身的横竖尺寸计算输出宽度，批量任务不能共用同一宽度 */
function jobParamsForMedia(media: TweetMedia, params: GifParams, presetId: string | null): GifParams {
  const preset = getPreset(presetId)
  let effective = params
  if (preset?.maxLongSide) {
    const width = presetWidthForSource(media.width, media.height, preset.maxLongSide)
    effective = { ...params, width }
  }
  return clampParams(effective)
}

interface StoreState {
  ready: boolean
  info: AppInfo | null
  infoError: string | null
  settings: AppSettings
  settingsError: string | null
  view: AppView
  tweet: TweetInfo | null
  tweetLoading: boolean
  tweetError: string | null
  selectedMediaIds: string[]
  jobs: JobRecord[]
  results: GifResult[]
  /** 当前推文已保存的原始媒体（来自历史记录与本次保存结果） */
  savedMedia: SavedMedia[]
  /** 历史页/外部跳转带入解析流程的链接；解析页消费后清空 */
  pendingParseUrl: string | null
  /** 「解析新链接」计数器：侧栏触发后让解析页清空输入并回到初始解析页 */
  newParseNonce: number
  /** 解析页子视图：home=初始解析页（粘贴链接），result=当前解析结果 */
  parseScreen: 'home' | 'result'
  history: HistoryEntry[]
  historyLoading: boolean
  historyError: string | null
}

const MAX_JOBS = 40
const MAX_CONCURRENT_JOBS = 2

function readViewFromHash(): AppView {
  try {
    const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase()
    if (hash === 'history' || hash === 'settings' || hash === 'parse') return hash
  } catch {
    // 非浏览器环境回退默认
  }
  return 'parse'
}

/** 系统是否偏好深色；无 matchMedia（jsdom/旧环境）时按深色处理 */
function prefersDarkMode(): boolean {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
  } catch {
    // 忽略
  }
  return true
}

/** 历史按推文 id 去重并保留原顺序（防御旧数据/异常数据出现重复分组） */
function dedupeHistoryEntries(entries: HistoryEntry[] | null | undefined): HistoryEntry[] {
  if (!Array.isArray(entries)) return []
  const seen = new Set<string>()
  const result: HistoryEntry[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue
    seen.add(entry.id)
    result.push(entry)
  }
  return result
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '未知错误'
}

/**
 * app.info 的返回值在不同主进程版本里可能是 AppInfo，也可能是 OperationResult<AppInfo>。
 * 这里统一解包，避免把 {ok,data} 当成 AppInfo 使用导致 info.tools 为 undefined。
 */
function unwrapAppInfo(value: unknown): { info: AppInfo | null; error: string | null } {
  if (value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean') {
    const result = value as { ok: boolean; data?: AppInfo; error?: string }
    if (result.ok) return { info: result.data ?? null, error: null }
    return { info: null, error: result.error || '读取应用信息失败' }
  }
  if (value && typeof value === 'object') return { info: value as AppInfo, error: null }
  return { info: null, error: '读取应用信息失败' }
}

function initialState(): StoreState {
  return {
    ready: false,
    info: null,
    infoError: null,
    settings: normalizeSettings(null),
    settingsError: null,
    view: readViewFromHash(),
    tweet: null,
    tweetLoading: false,
    tweetError: null,
    selectedMediaIds: [],
    jobs: [],
    results: [],
    savedMedia: [],
    pendingParseUrl: null,
    newParseNonce: 0,
    parseScreen: 'home',
    history: [],
    historyLoading: false,
    historyError: null,
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AppContextValue extends StoreState {
  desktopAvailable: boolean
  setView: (view: AppView) => void
  /** 从历史页等携带链接进入解析流程：设置 pending 链接并切到解析视图，解析页自动填入并解析 */
  openParseWithUrl: (url: string) => void
  /** 解析页消费 pending 链接后调用，避免重复自动解析 */
  clearPendingParseUrl: () => void
  /** 回到初始解析页（保留当前解析结果，可再通过「解析推文」返回） */
  startNewParse: () => void
  /** 打开当前解析结果页（侧栏「解析推文」使用） */
  showParseResult: () => void
  refreshInfo: () => Promise<void>
  refreshHistory: () => Promise<void>
  fetchTweet: (rawUrl: string) => Promise<boolean>
  clearTweet: () => void
  toggleMedia: (mediaId: string) => void
  selectAllMedia: () => void
  clearSelection: () => void
  /** 保存原始媒体（支持多选，走任务队列，进度 scope='save'） */
  saveMediaList: (mediaList: TweetMedia[], force?: boolean) => number
  /** 对单条媒体发起 GIF 转换（右键菜单用；未保存会自动保存源文件） */
  convertMedia: (media: TweetMedia, params: GifParams, presetId: string | null, format?: AnimFormat) => number
  /** 正在保存中的 mediaId 列表（用于媒体卡 loading/禁用） */
  savingMediaIds: string[]
  convertSelected: (params: GifParams, presetId: string | null, format?: AnimFormat) => number
  reencodeResult: (result: GifResult, media: TweetMedia, params: GifParams, presetId: string | null, format?: AnimFormat) => void
  cancelJob: (jobId: string) => Promise<void>
  dismissJob: (jobId: string) => void
  /** 清除已结束任务；传入 kinds 时只清除指定类型（解析页只清 GIF 任务，保存任务保留） */
  clearFinishedJobs: (kinds?: Array<'convert' | 'reencode' | 'save'>) => void
  openGif: (result: GifResult) => Promise<void>
  revealGif: (result: GifResult) => Promise<void>
  exportGif: (result: GifResult) => Promise<void>
  copyGifPath: (result: GifResult) => Promise<void>
  deleteResult: (result: GifResult) => Promise<void>
  /** 已保存原始媒体：打开 / 定位 / 另存为 / 复制路径 / 删除（删除同时清理历史记录） */
  openSavedMedia: (saved: SavedMedia) => Promise<void>
  revealSavedMedia: (saved: SavedMedia) => Promise<void>
  exportSavedMedia: (saved: SavedMedia) => Promise<void>
  copySavedMediaPath: (saved: SavedMedia) => Promise<void>
  removeSavedMedia: (saved: SavedMedia) => Promise<void>
  removeHistoryEntry: (tweetId: string, options?: { deleteFiles?: boolean }) => Promise<void>
  removeHistoryResult: (tweetId: string, resultId: string) => Promise<void>
  clearHistory: () => Promise<void>
  saveSettings: (next: AppSettings) => Promise<boolean>
  /** 当前生效主题（system 已根据系统偏好解析为 dark/light） */
  effectiveTheme: 'dark' | 'light'
  /** 设置页里尚未保存的主题预览；null 表示使用已保存设置 */
  themePreview: ThemeMode | null
  setThemePreview: (mode: ThemeMode | null) => void
  /** 标题栏快捷切换：在深色/浅色之间切换并立即持久化 */
  toggleTheme: () => Promise<void>
  chooseDirectory: (kind: 'output' | 'cache') => Promise<string | null>
  openOutputDir: () => Promise<void>
  openCacheDir: () => Promise<void>
  /** 打开便携数据目录（程序目录 userdata） */
  openDataDir: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AppProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast()
  const [state, setState] = useState<StoreState>(initialState)
  const stateRef = useRef(state)
  stateRef.current = state
  const initialized = useRef(false)
  const runJobRef = useRef<(job: JobRecord) => Promise<void>>(async () => {})
  const pumpRef = useRef<() => void>(() => {})
  const [themePreview, setThemePreviewState] = useState<ThemeMode | null>(null)
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDarkMode())
  const themeMode: ThemeMode = themePreview ?? state.settings.theme
  const effectiveTheme: 'dark' | 'light' = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode
  const effectiveThemeRef = useRef(effectiveTheme)
  effectiveThemeRef.current = effectiveTheme

  const desktopAvailable = typeof window !== 'undefined' && Boolean(window.desktop)

  const patch = useCallback((next: Partial<StoreState>) => {
    setState((prev) => ({ ...prev, ...next }))
  }, [])

  // ---------- 刷新：应用信息 / 历史 ----------

  const refreshInfo = useCallback(async () => {
    const bridge = window.desktop
    if (!bridge) {
      patch({ infoError: '当前运行环境未提供桌面能力（window.desktop），无法读取工具状态。' })
      return
    }
    try {
      const result = unwrapAppInfo(await bridge.app.info())
      patch({ info: result.info, infoError: result.error })
    } catch (error) {
      patch({ info: null, infoError: errorText(error) })
    }
  }, [patch])

  const refreshHistory = useCallback(async () => {
    const bridge = window.desktop
    if (!bridge) return
    try {
      const result = await bridge.history.list()
      if (result.ok) {
        const entries = dedupeHistoryEntries(result.data)
        patch({ history: entries, historyError: null, historyLoading: false })
        // 当前推文：同步历史中的已保存媒体与已有 GIF（同一推文重复解析/保存只更新同一条记录）
        setState((prev) => {
          if (!prev.tweet) return prev
          const entry = entries.find((item) => item.id === prev.tweet?.id)
          if (!entry) return prev
          const savedMedia = Array.isArray(entry.savedMedia) ? entry.savedMedia : []
          const results = [...prev.results]
          for (const item of entry.results ?? []) {
            if (!results.some((existing) => existing.id === item.id)) results.push(item)
          }
          return { ...prev, savedMedia, results }
        })
      } else {
        patch({ historyError: result.error || '读取历史失败', historyLoading: false })
      }
    } catch (error) {
      patch({ historyError: errorText(error), historyLoading: false })
    }
  }, [patch])

  // ---------- 初始化 ----------

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    const bridge = window.desktop
    if (!bridge) {
      patch({
        ready: true,
        infoError: '当前运行环境未提供桌面能力（window.desktop）：解析、转换、历史与设置仅在桌面版可用。',
        historyLoading: false,
      })
      return
    }
    let cancelled = false
    void (async () => {
      const [infoOutcome, settingsOutcome, historyOutcome] = await Promise.allSettled([
        bridge.app.info(),
        bridge.settings.get(),
        bridge.history.list(),
      ])
      if (cancelled) return
      const next: Partial<StoreState> = { ready: true, historyLoading: false }
      if (infoOutcome.status === 'fulfilled') {
        const unpacked = unwrapAppInfo(infoOutcome.value)
        next.info = unpacked.info
        if (unpacked.error) next.infoError = unpacked.error
      } else {
        next.info = null
        next.infoError = '读取应用信息失败：' + errorText(infoOutcome.reason)
      }

      if (settingsOutcome.status === 'fulfilled') {
        if (settingsOutcome.value.ok) next.settings = normalizeSettings(settingsOutcome.value.data)
        else next.settingsError = settingsOutcome.value.error || '读取设置失败'
      } else {
        next.settingsError = '读取设置失败：' + errorText(settingsOutcome.reason)
      }

      if (historyOutcome.status === 'fulfilled') {
        if (historyOutcome.value.ok) next.history = dedupeHistoryEntries(historyOutcome.value.data)
        else next.historyError = historyOutcome.value.error || '读取历史失败'
      } else {
        next.historyError = '读取历史失败：' + errorText(historyOutcome.reason)
      }
      patch(next)
    })()
    return () => {
      cancelled = true
    }
  }, [patch])

  // ---------- hash 路由 ----------

  const setView = useCallback((view: AppView) => {
    // 手动导航时清空待解析链接，避免下次进入解析页重复自动解析
    setState((prev) => (prev.view === view && prev.pendingParseUrl === null ? prev : { ...prev, view, pendingParseUrl: null }))
    try {
      const nextHash = '#' + view
      if (window.location.hash !== nextHash) window.history.replaceState(null, '', nextHash)
    } catch {
      // 忽略：某些环境不允许修改 history
    }
  }, [])

  /** 历史页「去解析」：携带链接切到解析视图，由解析页消费并自动解析 */
  const openParseWithUrl = useCallback((url: string) => {
    const trimmed = String(url || '').trim()
    setState((prev) => ({ ...prev, view: 'parse', pendingParseUrl: trimmed || null, tweetError: null }))
    try {
      if (window.location.hash !== '#parse') window.history.replaceState(null, '', '#parse')
    } catch {
      // 忽略：某些环境不允许修改 history
    }
  }, [])

  const clearPendingParseUrl = useCallback(() => {
    setState((prev) => (prev.pendingParseUrl === null ? prev : { ...prev, pendingParseUrl: null }))
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      const next = readViewFromHash()
      setState((prev) => (prev.view === next ? prev : { ...prev, view: next }))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // ---------- 主题 ----------

  // 跟随系统：matchMedia 变化时实时切换（jsdom 等无 matchMedia 的环境安全跳过）
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(media.matches)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(Boolean(event.matches))
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // 把生效主题写到 <html data-theme>，CSS 只依赖该属性切换明暗变量
  useEffect(() => {
    try {
      const root = document.documentElement
      root.dataset.theme = effectiveTheme
      root.style.colorScheme = effectiveTheme
    } catch {
      // 忽略非浏览器环境
    }
  }, [effectiveTheme])

  // 保存成功后自动清除临时预览（例如设置页选了主题又保存）
  useEffect(() => {
    if (themePreview && state.settings.theme === themePreview) setThemePreviewState(null)
  }, [state.settings.theme, themePreview])

  const setThemePreview = useCallback((mode: ThemeMode | null) => {
    setThemePreviewState(mode)
  }, [])

  // ---------- 任务进度订阅 ----------

  useEffect(() => {
    const bridge = window.desktop
    if (!bridge || !bridge.jobs || typeof bridge.jobs.onProgress !== 'function') return () => {}
    const off = bridge.jobs.onProgress((progress: JobProgress) => {
      if (!progress || !progress.jobId) return
      setState((prev) => {
        const index = prev.jobs.findIndex((job) => job.jobId === progress.jobId)
        if (index < 0) return prev
        const current = prev.jobs[index]
        const jobs = [...prev.jobs]
        jobs[index] = {
          ...current,
          phase: progress.phase || current.phase,
          percent: typeof progress.percent === 'number' ? progress.percent : current.percent,
          message: progress.message ? progress.message : current.message,
        }
        return { ...prev, jobs }
      })
    })
    return () => {
      try {
        off()
      } catch {
        // 忽略取消订阅异常
      }
    }
  }, [])

  // ---------- 任务执行 ----------

  /** 把保存结果并入当前推文的已保存媒体列表（按 id 去重/更新） */
  const mergeSavedMedia = useCallback((saved: SavedMedia) => {
    setState((prev) => {
      if (!prev.tweet || prev.tweet.id !== saved.tweetId) return prev
      const exists = prev.savedMedia.some((item) => item.id === saved.id)
      return {
        ...prev,
        savedMedia: exists
          ? prev.savedMedia.map((item) => (item.id === saved.id ? saved : item))
          : [...prev.savedMedia, saved],
      }
    })
  }, [])

  const runJob = useCallback(
    async (job: JobRecord) => {
      const bridge = window.desktop
      const finish = (next: Partial<JobRecord>) => {
        setState((prev) => ({
          ...prev,
          jobs: prev.jobs.map((item) => (item.jobId === job.jobId ? { ...item, ...next } : item)),
        }))
      }
      if (!bridge) {
        finish({ status: 'error', phase: 'error', message: '桌面能力不可用', error: '当前为浏览器预览模式，该操作需在桌面版进行' })
        return
      }
      try {
        // 保存原始媒体任务（mp4 / 图片），进度由主进程 media:save 上报（scope='save'）
        if (job.kind === 'save') {
          const savedResponse = await bridge.media.save({
            jobId: job.jobId,
            tweetId: job.tweetId,
            media: job.media,
            force: job.force,
          })
          if (savedResponse.ok) {
            const { saved, newFile } = savedResponse.data
            finish({ status: 'success', phase: 'done', percent: 100, message: newFile ? '媒体已保存' : '已保存过，直接复用', error: null })
            mergeSavedMedia(saved)
            toast(newFile ? '已保存：' + saved.fileName : '该媒体已保存过，直接复用', 'success')
          } else {
            const cancelled = savedResponse.code === 'CANCELLED'
            finish(
              cancelled
                ? { status: 'cancelled', phase: 'cancelled', percent: -1, message: '任务已取消', error: null }
                : {
                    status: 'error',
                    phase: 'error',
                    percent: -1,
                    message: savedResponse.error || '保存失败',
                    error: savedResponse.error || '保存失败',
                  },
            )
            if (!cancelled) toast(savedResponse.error || '保存失败', 'error')
          }
          return
        }
        const request: ConvertGifRequest = {
          jobId: job.jobId,
          tweetId: job.tweetId,
          media: job.media,
          params: job.params,
          presetId: job.presetId,
          format: job.format ?? 'gif',
          // 产品流程：转换动图时若源媒体未保存，主进程自动保存源文件
          autoSave: true,
        }
        const result = await bridge.gif.convert(request)
        if (result.ok) {
          const gif = result.data
          finish({ status: 'success', phase: 'done', percent: 100, message: '转换完成', error: null, resultId: gif.id })
          setState((prev) => {
            if (!prev.tweet || prev.tweet.id !== gif.tweetId) return prev
            if (prev.results.some((item) => item.id === gif.id)) return prev
            return { ...prev, results: [gif, ...prev.results] }
          })
          if (gif.sourceSaved) mergeSavedMedia(gif.sourceSaved)
          toast(animFormatLabel(gif.format ?? job.format) + ' 转换完成', 'success')
        } else {
          const cancelled = result.code === 'CANCELLED'
          finish(
            cancelled
              ? { status: 'cancelled', phase: 'cancelled', percent: -1, message: '任务已取消', error: null }
              : {
                  status: 'error',
                  phase: 'error',
                  percent: -1,
                  message: result.error || '转换失败',
                  error: result.error || '转换失败',
                },
          )
          if (!cancelled) toast(result.error || '转换失败', 'error')
        }
      } catch (error) {
        const message = errorText(error)
        finish({ status: 'error', phase: 'error', percent: -1, message, error: message })
        toast((job.kind === 'save' ? '保存失败：' : '转换失败：') + message, 'error')
      } finally {
        void refreshHistory()
      }
    },
    [mergeSavedMedia, refreshHistory, toast],
  )
  runJobRef.current = runJob

  /** 队列调度：同一时间最多 2 个转换任务，其余保持排队 */
  const pump = useCallback(() => {
    const bridge = window.desktop
    if (!bridge) return
    const jobs = stateRef.current.jobs
    let capacity = MAX_CONCURRENT_JOBS - jobs.filter((job) => job.status === 'running').length
    if (capacity <= 0) return
    for (const job of jobs) {
      if (job.status !== 'queued' || capacity <= 0) continue
      capacity -= 1
      setState((prev) => {
        const current = prev.jobs.find((item) => item.jobId === job.jobId)
        if (!current || current.status !== 'queued') return prev
        return {
          ...prev,
          jobs: prev.jobs.map((item) =>
            item.jobId === job.jobId
              ? { ...item, status: 'running' as JobStatus, phase: 'queued' as JobPhase, percent: 0, message: '已提交转换任务…' }
              : item,
          ),
        }
      })
      void runJobRef.current(job)
    }
  }, [])
  pumpRef.current = pump

  useEffect(() => {
    pumpRef.current()
  }, [state.jobs])

  // ---------- 推文解析 ----------

  const fetchTweet = useCallback(
    async (rawUrl: string): Promise<boolean> => {
      const parsed = normalizeTweetInput(rawUrl)
      if (!parsed.ok) {
        patch({ tweetError: parsed.error })
        toast(parsed.error, 'warning')
        return false
      }
      const bridge = window.desktop
      if (!bridge) {
        const message = '当前不在桌面环境中运行，无法解析推文'
        patch({ tweetError: message })
        toast(message, 'error')
        return false
      }
      patch({ tweetLoading: true, tweetError: null, tweet: null, results: [], savedMedia: [], selectedMediaIds: [] })
      try {
        const result = await bridge.tweet.fetch(parsed.url)
        if (result.ok) {
          const tweet = result.data
          const selected = tweet.media.map((item) => item.id)
          // 同一推文重复解析：从历史读取已保存媒体与既有 GIF，保证「只更新同一条记录」
          let savedMedia: SavedMedia[] = []
          let previousResults: GifResult[] = []
          try {
            const entry = await bridge.history.get(tweet.id)
            if (entry.ok && entry.data) {
              savedMedia = Array.isArray(entry.data.savedMedia) ? entry.data.savedMedia : []
              previousResults = Array.isArray(entry.data.results) ? entry.data.results : []
            }
          } catch {
            // 历史读取失败不阻塞解析
          }
          patch({ tweetLoading: false, tweet, parseScreen: 'result', selectedMediaIds: selected, results: previousResults, savedMedia })
          toast(
            '已解析到 ' + tweet.media.length + ' 个媒体' + (savedMedia.length > 0 ? '，历史已保存 ' + savedMedia.length + ' 个' : ''),
            'success',
          )
          void refreshHistory()
          return true
        }
        patch({ tweetLoading: false, tweetError: result.error || '解析失败' })
        toast(result.error || '解析失败', 'error')
        return false
      } catch (error) {
        const message = errorText(error)
        patch({ tweetLoading: false, tweetError: message })
        toast('解析失败：' + message, 'error')
        return false
      }
    },
    [patch, refreshHistory, toast],
  )

  const clearTweet = useCallback(() => {
    patch({ tweet: null, tweetError: null, parseScreen: 'home', results: [], savedMedia: [], selectedMediaIds: [], tweetLoading: false })
  }, [patch])

  const startNewParse = useCallback(() => {
    setState((prev) => ({ ...prev, newParseNonce: prev.newParseNonce + 1, parseScreen: 'home' }))
  }, [])

  const showParseResult = useCallback(() => {
    setState((prev) => (prev.tweet ? { ...prev, parseScreen: 'result' } : prev))
  }, [])

  // ---------- 媒体勾选 ----------

  const toggleMedia = useCallback((mediaId: string) => {
    setState((prev) => {
      const tweet = prev.tweet
      if (!tweet) return prev
      const media = tweet.media.find((item) => item.id === mediaId)
      if (!media) return prev
      const selected = prev.selectedMediaIds.includes(mediaId)
        ? prev.selectedMediaIds.filter((id) => id !== mediaId)
        : [...prev.selectedMediaIds, mediaId]
      return { ...prev, selectedMediaIds: selected }
    })
  }, [])

  const selectAllMedia = useCallback(() => {
    setState((prev) => {
      if (!prev.tweet) return prev
      return {
        ...prev,
        selectedMediaIds: prev.tweet.media.map((item) => item.id),
      }
    })
  }, [])

  const clearSelection = useCallback(() => {
    setState((prev) => (prev.selectedMediaIds.length === 0 ? prev : { ...prev, selectedMediaIds: [] }))
  }, [])

  // ---------- 发起转换 ----------

  const enqueue = useCallback((jobs: JobRecord[]) => {
    if (jobs.length === 0) return
    setState((prev) => ({ ...prev, jobs: [...jobs, ...prev.jobs].slice(0, MAX_JOBS) }))
  }, [])

  /** 创建单个 GIF 转换任务（主进程会在未保存时自动保存源媒体） */
  const createConvertJob = (
    tweet: TweetInfo,
    media: TweetMedia,
    params: GifParams,
    presetId: string | null,
    format: AnimFormat = 'gif',
  ): JobRecord => ({
    jobId: createJobId(),
    kind: 'convert',
    tweetId: tweet.id,
    mediaId: media.id,
    media,
    label: animFormatLabel(format) + ' · 第 ' + (tweet.media.findIndex((item) => item.id === media.id) + 1) + ' 项',
    params: jobParamsForMedia(media, params, presetId),
    presetId,
    format,
    status: 'queued',
    phase: 'queued',
    percent: -1,
    message: '等待执行…',
    error: null,
    createdAt: Date.now(),
    resultId: null,
  })

  const convertSelected = useCallback(
    (params: GifParams, presetId: string | null, format: AnimFormat = 'gif'): number => {
      const bridge = window.desktop
      const { tweet, selectedMediaIds } = stateRef.current
      if (!bridge) {
        toast('当前为浏览器预览模式，转换需在桌面版进行', 'error')
        return 0
      }
      if (!tweet) {
        toast('请先解析一条 X 推文', 'warning')
        return 0
      }
      const mediaList = tweet.media.filter(
        (item) => selectedMediaIds.includes(item.id) && isConvertibleKind(item.kind),
      )
      if (mediaList.length === 0) {
        toast('请先勾选要转换的动图或视频', 'warning')
        return 0
      }
      const normalized = clampParams(params)
      const jobs: JobRecord[] = mediaList.map((media) => createConvertJob(tweet, media, normalized, presetId, format))
      setState((prev) => ({
        ...prev,
        tweetError: null,
        selectedMediaIds: [],
        jobs: [...jobs, ...prev.jobs].slice(0, MAX_JOBS),
      }))
      toast('已加入转换队列：' + jobs.length + ' 个任务', 'success')
      return jobs.length
    },
    [toast],
  )

  /** 保存原始媒体（多选）：走与转换相同的任务队列与进度系统 */
  const saveMediaList = useCallback(
    (mediaList: TweetMedia[], force = false): number => {
      const bridge = window.desktop
      const { tweet } = stateRef.current
      if (!bridge) {
        toast('当前为浏览器预览模式，保存媒体需在桌面版进行', 'error')
        return 0
      }
      if (!tweet) {
        toast('请先解析一条 X 推文', 'warning')
        return 0
      }
      if (!Array.isArray(mediaList) || mediaList.length === 0) {
        toast('请先勾选要保存的媒体', 'warning')
        return 0
      }
      const jobs: JobRecord[] = mediaList.map((media) => ({
        jobId: createJobId(),
        kind: 'save',
        tweetId: tweet.id,
        mediaId: media.id,
        media,
        label: '保存原始媒体 · 第 ' + (tweet.media.findIndex((item) => item.id === media.id) + 1) + ' 项',
        params: normalizeParams(null),
        presetId: null,
        force,
        status: 'queued',
        phase: 'queued',
        percent: -1,
        message: '等待执行…',
        error: null,
        createdAt: Date.now(),
        resultId: null,
      }))
      enqueue(jobs)
      toast('已加入保存队列：' + jobs.length + ' 个媒体', 'success')
      return jobs.length
    },
    [enqueue, toast],
  )

  /** 右键菜单：对单条媒体发起 GIF 转换（未保存时自动保存源媒体） */
  const convertMedia = useCallback(
    (media: TweetMedia, params: GifParams, presetId: string | null, format: AnimFormat = 'gif'): number => {
      const bridge = window.desktop
      const { tweet } = stateRef.current
      if (!bridge) {
        toast('当前为浏览器预览模式，转换需在桌面版进行', 'error')
        return 0
      }
      if (!tweet) {
        toast('请先解析一条 X 推文', 'warning')
        return 0
      }
      if (!isConvertibleKind(media.kind)) {
        toast('图片无需转换，可直接保存', 'warning')
        return 0
      }
      enqueue([createConvertJob(tweet, media, params, presetId, format)])
      toast('已加入转换队列', 'success')
      return 1
    },
    [enqueue, toast],
  )

  const reencodeResult = useCallback(
    (result: GifResult, media: TweetMedia, params: GifParams, presetId: string | null, format: AnimFormat = result.format ?? 'gif') => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，重新导出需在桌面版进行', 'error')
        return
      }
      const job: JobRecord = {
        jobId: createJobId(),
        kind: 'reencode',
        tweetId: result.tweetId,
        mediaId: media.id,
        media,
        label: '重新导出 · ' + animFormatLabel(format) + ' · ' + result.info.fileName,
        params: jobParamsForMedia(media, params, presetId),
        presetId,
        format,
        status: 'queued',
        phase: 'queued',
        percent: -1,
        message: '等待执行…',
        error: null,
        createdAt: Date.now(),
        resultId: null,
      }
      enqueue([job])
      toast('已按新参数加入导出队列', 'success')
    },
    [enqueue, toast],
  )

  const cancelJob = useCallback(
    async (jobId: string) => {
      const job = stateRef.current.jobs.find((item) => item.jobId === jobId)
      if (!job) return
      if (job.status === 'queued') {
        setState((prev) => ({
          ...prev,
          jobs: prev.jobs.map((item) =>
            item.jobId === jobId
              ? { ...item, status: 'cancelled' as JobStatus, phase: 'cancelled' as JobPhase, percent: -1, message: '任务已取消' }
              : item,
          ),
        }))
        return
      }
      if (job.status !== 'running') return
      const bridge = window.desktop
      if (!bridge) return
      try {
        const result = await bridge.jobs.cancel(jobId)
        if (result.ok) {
          setState((prev) => ({
            ...prev,
            jobs: prev.jobs.map((item) =>
              item.jobId === jobId && item.status === 'running' ? { ...item, message: '正在取消…' } : item,
            ),
          }))
        } else {
          toast(result.error || '取消失败', 'warning')
        }
      } catch (error) {
        toast('取消失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const dismissJob = useCallback((jobId: string) => {
    setState((prev) => ({ ...prev, jobs: prev.jobs.filter((job) => job.jobId !== jobId) }))
  }, [])

  const clearFinishedJobs = useCallback((kinds?: Array<'convert' | 'reencode' | 'save'>) => {
    setState((prev) => ({
      ...prev,
      jobs: prev.jobs.filter((job) => {
        // 进行中/排队任务始终保留
        if (job.status === 'running' || job.status === 'queued') return true
        // 未指定类型：清除全部已结束任务
        if (!kinds || kinds.length === 0) return false
        // 指定类型：只清除这些类型的已结束任务
        return !kinds.includes(job.kind)
      }),
    }))
  }, [])

  // ---------- 结果操作 ----------

  const openGif = useCallback(
    async (result: GifResult) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.gif.open(result.gifPath)
        if (response.ok) toast('已用默认程序打开文件', 'success')
        else toast(response.error || '打开失败', 'error')
      } catch (error) {
        toast('打开失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const revealGif = useCallback(
    async (result: GifResult) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.gif.reveal(result.gifPath)
        if (response.ok) toast('已在资源管理器中定位文件', 'success')
        else toast(response.error || '定位失败', 'error')
      } catch (error) {
        toast('定位失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const exportGif = useCallback(
    async (result: GifResult) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.gif.exportAs(result.gifPath, result.info.fileName)
        if (!response.ok) {
          toast(response.error || '另存为失败', 'error')
          return
        }
        if (response.data.canceled) return
        toast('已另存为：' + (response.data.filePath || '新文件'), 'success')
      } catch (error) {
        toast('另存为失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const copyGifPath = useCallback(
    async (result: GifResult) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.gif.copyPath(result.gifPath)
        if (response.ok) toast('已复制文件路径', 'success')
        else toast(response.error || '复制失败', 'error')
      } catch (error) {
        toast('复制失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const deleteResult = useCallback(
    async (result: GifResult) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      let fileError: string | null = null
      let recordError: string | null = null
      try {
        const removed = await bridge.gif.remove(result.gifPath)
        if (!removed.ok) fileError = removed.error || '删除文件失败'
      } catch (error) {
        fileError = errorText(error)
      }
      try {
        const removed = await bridge.history.removeResult(result.tweetId, result.id)
        if (!removed.ok) recordError = removed.error || '删除历史记录失败'
      } catch (error) {
        recordError = errorText(error)
      }
      if (fileError && recordError) {
        toast('删除失败：' + (fileError || recordError), 'error')
        return
      }
      setState((prev) => ({
        ...prev,
        results: prev.results.filter((item) => item.id !== result.id),
        history: prev.history.map((entry) =>
          entry.id === result.tweetId
            ? { ...entry, results: (entry.results ?? []).filter((item) => item.id !== result.id) }
            : entry,
        ),
      }))
      void refreshHistory()
      toast('已删除该动图与历史记录', 'success')
    },
    [refreshHistory, toast],
  )

  // ---------- 已保存原始媒体 ----------

  const openSavedMedia = useCallback(
    async (saved: SavedMedia) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.media.open(saved.filePath)
        if (response.ok) toast('已打开媒体文件', 'success')
        else toast(response.error || '打开失败', 'error')
      } catch (error) {
        toast('打开失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const revealSavedMedia = useCallback(
    async (saved: SavedMedia) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.media.reveal(saved.filePath)
        if (response.ok) toast('已在资源管理器中定位文件', 'success')
        else toast(response.error || '定位失败', 'error')
      } catch (error) {
        toast('定位失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const exportSavedMedia = useCallback(
    async (saved: SavedMedia) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.media.exportAs(saved.filePath, saved.fileName)
        if (!response.ok) {
          toast(response.error || '另存为失败', 'error')
          return
        }
        if (response.data.canceled) return
        toast('已另存为：' + (response.data.filePath || '新文件'), 'success')
      } catch (error) {
        toast('另存为失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const copySavedMediaPath = useCallback(
    async (saved: SavedMedia) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.media.copyPath(saved.filePath)
        if (response.ok) toast('已复制文件路径', 'success')
        else toast(response.error || '复制失败', 'error')
      } catch (error) {
        toast('复制失败：' + errorText(error), 'error')
      }
    },
    [toast],
  )

  const removeSavedMedia = useCallback(
    async (saved: SavedMedia) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      let fileError: string | null = null
      let recordError: string | null = null
      try {
        const removed = await bridge.media.remove(saved.filePath)
        if (!removed.ok) fileError = removed.error || '删除文件失败'
      } catch (error) {
        fileError = errorText(error)
      }
      try {
        const removed = await bridge.history.removeSaved(saved.tweetId, saved.id)
        if (!removed.ok) recordError = removed.error || '删除历史记录失败'
      } catch (error) {
        recordError = errorText(error)
      }
      if (fileError && recordError) {
        toast('删除失败：' + (fileError || recordError), 'error')
        return
      }
      setState((prev) => ({
        ...prev,
        savedMedia: prev.savedMedia.filter((item) => item.id !== saved.id),
        history: prev.history.map((entry) =>
          entry.id === saved.tweetId
            ? { ...entry, savedMedia: (entry.savedMedia ?? []).filter((item) => item.id !== saved.id) }
            : entry,
        ),
      }))
      void refreshHistory()
      toast('已删除该媒体文件与历史记录', 'success')
    },
    [refreshHistory, toast],
  )

  // ---------- 历史操作 ----------

  const removeHistoryEntry = useCallback(
    async (tweetId: string, options?: { deleteFiles?: boolean }) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const deleteFiles = Boolean(options && options.deleteFiles)
        const response = await bridge.history.remove(tweetId, deleteFiles)
        if (!response.ok) {
          toast(response.error || '移除历史失败', 'error')
          return
        }
        setState((prev) => ({ ...prev, history: prev.history.filter((entry) => entry.id !== tweetId) }))
        void refreshHistory()
        if (deleteFiles) {
          const data = response.data
          const deleted = data && typeof data.deletedFiles === 'number' ? data.deletedFiles : 0
          const failed = data && typeof data.failedFiles === 'number' ? data.failedFiles : 0
          toast(failed > 0 ? '已移除记录并删除 ' + deleted + ' 个文件（' + failed + ' 个未能删除）' : '已移除记录并删除 ' + deleted + ' 个文件', failed > 0 ? 'warning' : 'success')
        } else {
          toast('已从历史记录中移除该推文（文件仍保留）', 'success')
        }
      } catch (error) {
        toast('移除历史失败：' + errorText(error), 'error')
      }
    },
    [refreshHistory, toast],
  )

  const removeHistoryResult = useCallback(
    async (tweetId: string, resultId: string) => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return
      }
      try {
        const response = await bridge.history.removeResult(tweetId, resultId)
        if (!response.ok) {
          toast(response.error || '删除结果失败', 'error')
          return
        }
        setState((prev) => ({
          ...prev,
          history: prev.history.map((entry) =>
            entry.id === tweetId
              ? { ...entry, results: (entry.results ?? []).filter((item) => item.id !== resultId) }
              : entry,
          ),
        }))
        void refreshHistory()
        toast('已从历史移除该结果', 'success')
      } catch (error) {
        toast('删除结果失败：' + errorText(error), 'error')
      }
    },
    [refreshHistory, toast],
  )

  const clearHistory = useCallback(async () => {
    const bridge = window.desktop
    if (!bridge) {
      toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
      return
    }
    try {
      const response = await bridge.history.clear()
      if (!response.ok) {
        toast(response.error || '清空历史失败', 'error')
        return
      }
      setState((prev) => ({ ...prev, history: [] }))
      void refreshHistory()
      toast('历史记录已清空（动图文件仍保留）', 'success')
    } catch (error) {
      toast('清空历史失败：' + errorText(error), 'error')
    }
  }, [refreshHistory, toast])

  // ---------- 设置 ----------

  const saveSettings = useCallback(
    async (next: AppSettings): Promise<boolean> => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，保存设置需在桌面版进行', 'error')
        return false
      }
      const normalized = normalizeSettings(next)
      try {
        const response = await bridge.settings.save(normalized)
        if (!response.ok) {
          // 主进程会返回 PROXY_INVALID 等业务错误；在页面顶部提示条中持续展示，而不是只弹 toast
          const message = response.error || '保存设置失败'
          patch({ settingsError: message })
          toast(message, 'error')
          return false
        }
        patch({ settings: normalizeSettings(response.data), settingsError: null })
        toast('设置已保存', 'success')
        return true
      } catch (error) {
        const message = '保存设置失败：' + errorText(error)
        patch({ settingsError: message })
        toast(message, 'error')
        return false
      }
    },
    [patch, toast],
  )

  const toggleTheme = useCallback(async () => {
    const next: ThemeMode = effectiveThemeRef.current === 'dark' ? 'light' : 'dark'
    setThemePreviewState(null)
    const current = stateRef.current.settings
    await saveSettings({ ...current, theme: next })
  }, [saveSettings])

  const chooseDirectory = useCallback(
    async (kind: 'output' | 'cache'): Promise<string | null> => {
      const bridge = window.desktop
      if (!bridge) {
        toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
        return null
      }
      try {
        const response = await bridge.settings.chooseDirectory(kind)
        if (!response.ok) {
          toast(response.error || '选择目录失败', 'error')
          return null
        }
        return response.data
      } catch (error) {
        toast('选择目录失败：' + errorText(error), 'error')
        return null
      }
    },
    [toast],
  )

  const openOutputDir = useCallback(async () => {
    const bridge = window.desktop
    if (!bridge) {
      toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
      return
    }
    try {
      const response = await bridge.app.openOutputDir()
      if (response.ok) toast('已打开输出目录', 'success')
      else toast(response.error || '打开输出目录失败', 'error')
    } catch (error) {
      toast('打开输出目录失败：' + errorText(error), 'error')
    }
  }, [toast])

  const openDataDir = useCallback(async () => {
    const bridge = window.desktop
    if (!bridge) {
      toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
      return
    }
    try {
      const response = await bridge.app.openDataDir()
      if (response.ok) toast('已打开数据目录：' + response.data, 'success')
      else toast(response.error || '打开数据目录失败', 'error')
    } catch (error) {
      toast('打开数据目录失败：' + errorText(error), 'error')
    }
  }, [toast])

  const openCacheDir = useCallback(async () => {
    const bridge = window.desktop
    if (!bridge) {
      toast('当前为浏览器预览模式，该操作需在桌面版进行', 'error')
      return
    }
    try {
      const response = await bridge.app.openCacheDir()
      if (response.ok) toast('已打开缓存目录', 'success')
      else toast(response.error || '打开缓存目录失败', 'error')
    } catch (error) {
      toast('打开缓存目录失败：' + errorText(error), 'error')
    }
  }, [toast])

  /** 正在保存中的媒体 id（去重），供媒体卡展示保存中/禁用快捷操作 */
  const savingMediaIds = useMemo(
    () =>
      Array.from(
        new Set(
          state.jobs
            .filter((job) => job.kind === 'save' && (job.status === 'queued' || job.status === 'running'))
            .map((job) => job.mediaId),
        ),
      ),
    [state.jobs],
  )

  const value = useMemo<AppContextValue>(
    () => ({
      ...state,
      desktopAvailable,
      setView,
      openParseWithUrl,
      clearPendingParseUrl,
      startNewParse,
      showParseResult,
      refreshInfo,
      refreshHistory,
      fetchTweet,
      clearTweet,
      toggleMedia,
      selectAllMedia,
      clearSelection,
      saveMediaList,
      convertMedia,
      savingMediaIds,
      convertSelected,
      reencodeResult,
      cancelJob,
      dismissJob,
      clearFinishedJobs,
      openGif,
      revealGif,
      exportGif,
      copyGifPath,
      deleteResult,
      openSavedMedia,
      revealSavedMedia,
      exportSavedMedia,
      copySavedMediaPath,
      removeSavedMedia,
      removeHistoryEntry,
      removeHistoryResult,
      clearHistory,
      saveSettings,
      effectiveTheme,
      themePreview,
      setThemePreview,
      toggleTheme,
      chooseDirectory,
      openOutputDir,
      openCacheDir,
      openDataDir,
    }),
    [
      state,
      desktopAvailable,
      setView,
      openParseWithUrl,
      clearPendingParseUrl,
      startNewParse,
      showParseResult,
      refreshInfo,
      refreshHistory,
      fetchTweet,
      clearTweet,
      toggleMedia,
      selectAllMedia,
      clearSelection,
      saveMediaList,
      convertMedia,
      savingMediaIds,
      convertSelected,
      reencodeResult,
      cancelJob,
      dismissJob,
      clearFinishedJobs,
      openGif,
      revealGif,
      exportGif,
      copyGifPath,
      deleteResult,
      openSavedMedia,
      revealSavedMedia,
      exportSavedMedia,
      copySavedMediaPath,
      removeSavedMedia,
      removeHistoryEntry,
      removeHistoryResult,
      clearHistory,
      saveSettings,
      effectiveTheme,
      themePreview,
      setThemePreview,
      toggleTheme,
      chooseDirectory,
      openOutputDir,
      openCacheDir,
      openDataDir,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext)
  if (!context) throw new Error('useApp 必须在 AppProvider 内使用')
  return context
}