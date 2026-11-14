/**
 * 渲染进程与主进程共用的数据契约。
 * 注意：本文件是前后端共同契约，界面开发与主进程开发都不得随意改动字段；
 * 需要变更时先同步 docs/架构与接口契约.md。
 */

/** 推文媒体类型：X 的「GIF」在数据里是 animated_gif，但文件实际是 mp4 */
export type MediaKind = 'gif' | 'video' | 'photo'

export interface TweetAuthor {
  name: string
  screenName: string
  avatarUrl: string | null
  verified: boolean
}

export interface MediaVariant {
  url: string
  bitrate: number
  width: number | null
  height: number | null
}

export interface TweetMedia {
  /** X 媒体 id（media id_str）；缺失时使用 'media-<序号>' */
  id: string
  kind: MediaKind
  /** 下载用地址：gif/video 为 mp4，photo 为原图 */
  sourceUrl: string
  thumbnailUrl: string | null
  width: number | null
  height: number | null
  durationSec: number | null
  variants: MediaVariant[]
}

export interface TweetInfo {
  id: string
  /** 规范化后的推文链接（https://x.com/<user>/status/<id>） */
  url: string
  author: TweetAuthor
  text: string
  /** 推文发布时间（ISO 字符串），缺失时为 null */
  createdAt: string | null
  media: TweetMedia[]
  /** 媒体数据来源，仅用于排障与日志 */
  source: 'fxtwitter' | 'syndication' | 'vxtwitter'
  fetchedAt: string
}

export interface ToolStatus {
  ffmpeg: string | null
  gifski: string | null
  gifsicle: string | null
  ffmpegVersion: string | null
  gifskiVersion: string | null
  gifsicleVersion: string | null
  ready: boolean
  missing: string[]
}

export interface MediaProbe {
  path: string
  width: number
  height: number
  durationSec: number
  frameCount: number
  /** 平均帧率 */
  fps: number
  /** 每帧持续毫秒（来自 MP4 stts），用于还原原始 GIF 播放节奏 */
  frameDurationsMs: number[]
  hasAudio: boolean
  sizeBytes: number
}

/** 已保存到输出目录的原始媒体文件格式（X 的 GIF 实际保存为 mp4） */
export type SavedMediaFormat = 'mp4' | 'jpg' | 'png' | 'webp' | 'gif'

/** 一条已保存到输出目录的原始媒体记录 */
export interface SavedMedia {
  /** 稳定 id：tweetId + mediaId + 格式，用于去重与历史定位 */
  id: string
  tweetId: string
  mediaId: string
  mediaKind: MediaKind
  format: SavedMediaFormat
  filePath: string
  fileName: string
  width: number | null
  height: number | null
  /** 视频/GIF(mp4) 的时长；图片为 null */
  durationSec: number | null
  sizeBytes: number
  createdAt: string
}

/** 保存原始媒体的请求 */
export interface SaveMediaRequest {
  jobId: string
  tweetId: string
  media: TweetMedia
  /** true 时即使已存在同一条记录也重新下载覆盖 */
  force?: boolean
}

export interface SaveMediaResult {
  saved: SavedMedia
  /** false 表示命中已有保存记录（未写入新文件） */
  newFile: boolean
}

export type GifEncoder = 'gifski' | 'ffmpeg'
export type DitherMode = 'sierra2_4a' | 'bayer' | 'none'
/** 动图输出格式：真正 GIF 或动画 WebP（体积约为 GIF 的 1/4–1/5，画质更高） */
export type AnimFormat = 'gif' | 'webp'

export interface GifParams {
  encoder: GifEncoder
  /** 输出宽度上限；null 表示保持原始宽度 */
  width: number | null
  /** 目标帧率；'source' 表示保留源视频全部帧并还原原始逐帧时长（专用还原模式） */
  fps: number | 'source'
  /** 调色板颜色数（ffmpeg 编码路径 / gifsicle 二次量化；gifski 路径仅在 optimize 时生效） */
  colors: number
  /** gifski 质量 1-100（越高越清晰，体积越大） */
  quality: number
  /** ffmpeg 编码路径的抖动方式 */
  dither: DitherMode
  /** 是否按 MP4 每帧时间戳还原 GIF 帧延时（推荐开启） */
  preserveTiming: boolean
  /** 是否用 gifsicle 做体积优化（--lossy / 调色板压缩） */
  optimize: boolean
  /** gifsicle --lossy 强度 0-200，0 表示关闭 */
  lossy: number
  /** 播放速度倍率 0.25-4（1 = 原速） */
  speed: number
  /** GIF 循环次数：0 = 无限循环 */
  loopCount: number
}

export interface GifPreset {
  id: string
  name: string
  description: string
  params: GifParams
  /** 最长边上限：批量转换时按每个媒体自身横竖方向动态换算宽度；null 表示不限制 */
  maxLongSide: number | null
}

export interface GifInfo {
  path: string
  fileName: string
  width: number
  height: number
  sizeBytes: number
  frameCount: number
  durationSec: number
  /** 实际平均帧率 */
  fps: number
  /** 每帧延时（毫秒），读取 GIF GCE 得到 */
  frameDelaysMs: number[]
}

export interface GifResult {
  id: string
  tweetId: string
  mediaId: string
  /** 输出文件路径（GIF 或 WebP，旧数据缺省为 GIF） */
  gifPath: string
  /** 输出格式；旧历史数据没有该字段时按 gif 处理 */
  format?: AnimFormat
  info: GifInfo
  params: GifParams
  presetId: string | null
  createdAt: string
  /** 用户「另存为」产生的副本路径 */
  copies: string[]
  sourceProbe: MediaProbe | null
  /** 转换前自动保存的源媒体（autoSave 时由主进程写入） */
  sourceSaved: SavedMedia | null
}

export interface HistoryMedia {
  id: string
  kind: MediaKind
  sourceUrl: string
  thumbnailUrl: string | null
  /** 已下载的本地 mp4 缓存路径 */
  localPath: string | null
  probe: MediaProbe | null
}

export interface HistoryEntry {
  /** 推文 id（历史以 X 链接为主键分组） */
  id: string
  tweetUrl: string
  author: TweetAuthor
  text: string
  tweetCreatedAt: string | null
  fetchedAt: string
  lastOpenedAt: string
  media: HistoryMedia[]
  /** 已保存到输出目录的原始媒体（mp4/图片） */
  savedMedia: SavedMedia[]
  results: GifResult[]
}

/** 界面主题：深色 / 浅色 / 跟随系统 */
export type ThemeMode = 'dark' | 'light' | 'system'

/** 网络代理模式：系统代理 / 自定义代理 / 直连（不走代理） */
export type ProxyMode = 'system' | 'custom' | 'direct'

export interface ProxySettings {
  mode: ProxyMode
  /**
   * 自定义代理地址，例如：
   * - http://127.0.0.1:7890
   * - https://127.0.0.1:7891
   * - socks5://127.0.0.1:1080
   * - 裸 host:port（按 http 处理）
   */
  url: string
  /** 不走代理的主机/域名列表，分号、逗号或空白分隔 */
  bypass: string
  username: string
  password: string
}

export interface ProxyCheck {
  /** 检查项名称，例如「X 接口」「媒体 CDN」 */
  name: string
  url: string
  ok: boolean
  /** HTTP 状态码；网络错误时为 null */
  status: number | null
  latencyMs: number
  error: string | null
}

export interface ProxyTestResult {
  ok: boolean
  mode: ProxyMode
  /** 实际生效的自定义代理地址；系统/直连模式为 null */
  effectiveUrl: string | null
  checks: ProxyCheck[]
  error: string | null
}

export interface AppSettings {
  /** GIF 输出目录；null = 默认 <用户数据>/gifs */
  outputDir: string | null
  /** 缓存目录；null = 默认 <用户数据>/cache */
  cacheDir: string | null
  /** 新任务默认参数 */
  defaultParams: GifParams
  /** 默认选中的预设 id */
  defaultPresetId: string
  /** 保留已下载的原始 mp4 缓存 */
  keepOriginalMp4: boolean
  /** 缓存上限（MB），超过时清理最旧的媒体缓存 */
  maxCacheSizeMb: number
  /** 网络代理（X 接口、媒体下载与缩略图都走该代理配置） */
  proxy: ProxySettings
  /** 界面主题（保存后立即生效） */
  theme: ThemeMode
}

export interface AppInfo {
  version: string
  name: string
  isPackaged: boolean
  dataDir: string
  cacheDir: string
  outputDir: string
  logsDir: string
  tools: ToolStatus
}

/** 所有需要传回渲染进程的操作结果；失败时 error 为可直接展示的中文信息 */
export type OperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

export type JobScope = 'media' | 'gif' | 'save'
export type JobPhase = 'queued' | 'download' | 'probe' | 'thumbnail' | 'extract' | 'encode' | 'optimize' | 'finalize' | 'done' | 'error' | 'cancelled'

export interface JobProgress {
  jobId: string
  scope: JobScope
  phase: JobPhase
  /** 0-100，未知时为 -1 */
  percent: number
  message: string
}

export interface ConvertGifRequest {
  jobId: string
  tweetId: string
  media: TweetMedia
  params: GifParams
  presetId: string | null
  /** 输出格式：gif（默认）或 webp（动画 WebP） */
  format?: AnimFormat
  /** true 时若源媒体尚未保存，先保存到输出目录再转换（右键转换的默认行为） */
  autoSave?: boolean
}

export interface PrepareMediaRequest {
  jobId: string
  tweetId: string
  media: TweetMedia
}

export interface PreparedMedia {
  mediaId: string
  localPath: string
  thumbnailPath: string | null
  probe: MediaProbe
}

export interface ExportResult {
  canceled: boolean
  filePath?: string
}

export interface DesktopApi {
  isDesktop: true
  app: {
    info: () => Promise<AppInfo>
    toggleDevTools: () => Promise<void>
    openOutputDir: () => Promise<OperationResult<string>>
    openCacheDir: () => Promise<OperationResult<string>>
    /** 打开便携数据目录（程序目录 userdata\） */
    openDataDir: () => Promise<OperationResult<string>>
  }
  tweet: {
    fetch: (url: string) => Promise<OperationResult<TweetInfo>>
  }
  media: {
    prepare: (req: PrepareMediaRequest) => Promise<OperationResult<PreparedMedia>>
    /** 保存原始媒体到输出目录（mp4 / jpg / png / webp） */
    save: (req: SaveMediaRequest) => Promise<OperationResult<SaveMediaResult>>
    exportAs: (filePath: string, defaultName?: string) => Promise<OperationResult<ExportResult>>
    open: (filePath: string) => Promise<OperationResult<true>>
    reveal: (filePath: string) => Promise<OperationResult<true>>
    remove: (filePath: string) => Promise<OperationResult<true>>
    copyPath: (filePath: string) => Promise<OperationResult<true>>
    /** 把任意本地路径转换为渲染进程可直接显示的 xgif:// 地址 */
    toDisplayUrl: (filePath: string) => Promise<string>

    /** 已保存视频的首帧缩略图（xgif:// 显示地址；失败返回空字符串） */

    videoThumbnail: (filePath: string) => Promise<string>
  }
  gif: {
    convert: (req: ConvertGifRequest) => Promise<OperationResult<GifResult>>
    info: (filePath: string) => Promise<OperationResult<GifInfo>>
    exportAs: (filePath: string, defaultName?: string) => Promise<OperationResult<ExportResult>>
    open: (filePath: string) => Promise<OperationResult<true>>
    reveal: (filePath: string) => Promise<OperationResult<true>>
    remove: (filePath: string) => Promise<OperationResult<true>>
    copyPath: (filePath: string) => Promise<OperationResult<true>>
  }
  history: {
    list: () => Promise<OperationResult<HistoryEntry[]>>
    get: (tweetId: string) => Promise<OperationResult<HistoryEntry | null>>
    /** 移除一条历史记录；deleteFiles 为 true 时同时删除该记录下已保存的媒体与 GIF 文件 */
    remove: (tweetId: string, deleteFiles?: boolean) => Promise<OperationResult<{ deletedFiles: number; failedFiles: number }>>
    removeResult: (tweetId: string, resultId: string) => Promise<OperationResult<true>>
    /** 删除一条已保存的原始媒体记录（同时删除文件） */
    removeSaved: (tweetId: string, savedId: string) => Promise<OperationResult<true>>
    clear: () => Promise<OperationResult<true>>
  }
  settings: {
    get: () => Promise<OperationResult<AppSettings>>
    save: (settings: AppSettings) => Promise<OperationResult<AppSettings>>
    chooseDirectory: (kind: 'output' | 'cache') => Promise<OperationResult<string | null>>
  }
  /** 网络代理：应用候选代理配置并实测 X 接口与媒体 CDN 连通性（测试后恢复已保存的设置） */
  proxy: {
    test: (proxy: ProxySettings) => Promise<OperationResult<ProxyTestResult>>
  }
  jobs: {
    cancel: (jobId: string) => Promise<OperationResult<true>>
    onProgress: (callback: (progress: JobProgress) => void) => () => void
  }
  clipboard: {
    writeText: (text: string) => Promise<OperationResult<true>>
  }
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    isMaximized: () => Promise<boolean>
    close: () => Promise<void>
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
  }
}

declare global {
  interface Window {
    desktop?: DesktopApi
  }
}

export {}
