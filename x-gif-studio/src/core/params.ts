import type { AnimFormat, DitherMode, GifEncoder, GifParams, GifPreset } from '../shared/types'
import { DEFAULT_PARAMS, GIF_PRESETS, PARAM_LIMITS, findPreset } from '../shared/presets'

/** 参与「是否与预设一致」判断的参数键（与 shared/presets 的 detectPreset 保持一致） */
const PARAM_KEYS: (keyof GifParams)[] = [
  'encoder',
  'width',
  'fps',
  'colors',
  'quality',
  'dither',
  'preserveTiming',
  'optimize',
  'lossy',
  'speed',
  'loopCount',
]

const ENCODERS: GifEncoder[] = ['gifski', 'ffmpeg']
const DITHERS: DitherMode[] = ['sierra2_4a', 'bayer', 'none']

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function clampFloat(value: unknown, min: number, max: number, fallback: number, digits = 2): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  const clamped = Math.min(max, Math.max(min, num))
  const factor = Math.pow(10, digits)
  return Math.round(clamped * factor) / factor
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 参数兜底与范围校验：界面输入、IPC 回传、设置文件读取都走这里。
 * @param input 可能缺字段的参数对象
 * @param sourceWidth 源媒体宽度；传入时输出宽度不会超过源宽度（避免无意义的放大）
 */
export function clampParams(input: Partial<GifParams> | null | undefined, sourceWidth?: number | null): GifParams {
  const raw = (input ?? {}) as Partial<GifParams>
  const fallback = DEFAULT_PARAMS
  const widthValue = raw.width
  let width: number | null = null
  if (widthValue !== null && widthValue !== undefined) {
    width = clampInt(widthValue, PARAM_LIMITS.widthMin, PARAM_LIMITS.widthMax, 720)
    if (sourceWidth !== null && sourceWidth !== undefined && Number.isFinite(sourceWidth) && sourceWidth > 0) {
      width = Math.min(width, Math.max(PARAM_LIMITS.widthMin, Math.round(sourceWidth)))
    }
  }
  const fps = raw.fps === 'source' ? 'source' : clampInt(raw.fps, PARAM_LIMITS.fpsMin, PARAM_LIMITS.fpsMax, 30)
  return {
    encoder: ENCODERS.includes(raw.encoder as GifEncoder) ? (raw.encoder as GifEncoder) : fallback.encoder,
    width,
    fps,
    colors: clampInt(raw.colors, PARAM_LIMITS.colorsMin, PARAM_LIMITS.colorsMax, fallback.colors),
    quality: clampInt(raw.quality, PARAM_LIMITS.qualityMin, PARAM_LIMITS.qualityMax, fallback.quality),
    dither: DITHERS.includes(raw.dither as DitherMode) ? (raw.dither as DitherMode) : fallback.dither,
    preserveTiming: asBool(raw.preserveTiming, fallback.preserveTiming),
    optimize: asBool(raw.optimize, fallback.optimize),
    lossy: clampInt(raw.lossy, PARAM_LIMITS.lossyMin, PARAM_LIMITS.lossyMax, fallback.lossy),
    speed: clampFloat(raw.speed, PARAM_LIMITS.speedMin, PARAM_LIMITS.speedMax, fallback.speed),
    loopCount: clampInt(raw.loopCount, PARAM_LIMITS.loopMin, PARAM_LIMITS.loopMax, fallback.loopCount),
  }
}

/** 缺字段用 DEFAULT_PARAMS 补齐并校验，设置页 / IPC 返回值统一走这里 */
export function normalizeParams(input: Partial<GifParams> | null | undefined): GifParams {
  const candidate = { ...DEFAULT_PARAMS } as Record<string, unknown>
  if (input && typeof input === 'object') {
    for (const key of PARAM_KEYS) {
      const value = (input as Record<string, unknown>)[key]
      if (value !== undefined) candidate[key] = value
    }
  }
  return clampParams(candidate as unknown as Partial<GifParams>)
}

/** 判断两组参数是否完全一致 */
export function paramsEqual(a: GifParams, b: GifParams): boolean {
  return PARAM_KEYS.every((key) => a[key] === b[key])
}

/** 根据参数反推最接近的预设 id；不匹配任何预设时返回 null */
export function detectPresetId(params: GifParams): string | null {
  for (const preset of GIF_PRESETS) {
    if (preset.maxLongSide !== null) {
      // 最长边预设的 width 会按源媒体横竖动态推导，识别时忽略 width
      const { width: _width, ...restPreset } = preset.params
      const { width: _paramsWidth, ...restParams } = params
      if (paramsEqual(restPreset as GifParams, restParams as GifParams)) return preset.id
      continue
    }
    if (paramsEqual(preset.params, params)) return preset.id
  }
  return null
}

/** 预设 id → 预设对象（不存在返回 null） */
export function getPreset(id: string | null | undefined): GifPreset | null {
  return findPreset(id)
}

export function presetName(id: string | null | undefined): string {
  return findPreset(id)?.name ?? '自定义参数'
}

/** 把输出宽度限制在 [widthMin, source] 内并四舍五入到偶数（编码器友好；无源宽时用 widthMax 上限） */
export function roundEvenWidth(value: number, source?: number | null): number {
  const maxWidth = typeof source === 'number' && source > 0 ? source : PARAM_LIMITS.widthMax
  const safeValue = Number.isFinite(value) ? value : maxWidth
  const clamped = Math.min(Math.max(safeValue, PARAM_LIMITS.widthMin), maxWidth)
  let even = Math.round(clamped / 2) * 2
  // 四舍五入可能越过源宽（奇数源宽），此时向下取到不超过源宽的偶数
  if (even > maxWidth) even = Math.floor(maxWidth / 2) * 2
  return Math.max(2, even)
}

/**
 * 最长边上限 → 输出宽度：按 max(源宽, 源高) 等比缩放，宽度取偶数，且绝不放大。
 * 例如 1080×720 cap=480 → 480；720×1080 cap=480 → 320。
 */
export function presetWidthForSource(
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
  maxLongSide: number,
): number | null {
  const width = typeof sourceWidth === 'number' && Number.isFinite(sourceWidth) ? sourceWidth : null
  const height = typeof sourceHeight === 'number' && Number.isFinite(sourceHeight) ? sourceHeight : null
  const cap = typeof maxLongSide === 'number' && Number.isFinite(maxLongSide) && maxLongSide > 0 ? maxLongSide : null
  if (width === null || height === null || cap === null || width <= 0 || height <= 0) return null
  const longSide = Math.max(width, height)
  const rawWidth = width * Math.min(1, cap / longSide)
  const even = Math.max(2, Math.round(rawWidth / 2) * 2)
  // 源媒体本身不超过上限时保持原始宽度；奇数源宽向下取偶数，避免放大
  if (longSide <= cap) return Math.max(2, width % 2 === 0 ? width : width - 1)
  return even
}

/** 百分比（10-100）→ 输出 px：按源宽换算、四舍五入到偶数、不超过源宽 */
export function widthFromPercent(source: number, percent: number): number {
  const safeSource = Number.isFinite(source) && source > 0 ? source : PARAM_LIMITS.widthMax
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(10, percent)) : 100
  return roundEvenWidth((safeSource * safePercent) / 100, safeSource)
}

/** 输出 px → 百分比（无宽度时按 100%；无源宽时返回 100） */
export function percentFromWidth(width: number | null | undefined, source: number | null | undefined): number {
  if (typeof source !== 'number' || !Number.isFinite(source) || source <= 0) return 100
  const px = typeof width === 'number' && Number.isFinite(width) ? width : source
  return Math.min(100, Math.max(10, Math.round((px / source) * 100)))
}

/** 动图输出格式标签：旧数据缺省按 GIF */
export function animFormatLabel(format: AnimFormat | null | undefined): string {
  return format === 'webp' ? 'WebP' : 'GIF'
}

export function widthLabel(width: number | null | undefined): string {
  if (width === null || width === undefined || !Number.isFinite(width)) return '原始宽度'
  return `${Math.round(width)}px`
}

export function fpsLabel(fps: number | 'source' | null | undefined): string {
  if (fps === 'source' || fps === null || fps === undefined) return '源帧率'
  return `${Math.round(fps)} fps`
}

export function encoderLabel(encoder: GifEncoder): string {
  return encoder === 'ffmpeg' ? 'ffmpeg 两遍调色板' : 'gifski 高质量编码'
}

export function ditherLabel(dither: DitherMode): string {
  if (dither === 'bayer') return 'Bayer 抖动'
  if (dither === 'none') return '无抖动'
  return 'Sierra2_4a 抖动'
}

export function loopLabel(loopCount: number | null | undefined): string {
  if (loopCount === null || loopCount === undefined) return '无限循环'
  if (loopCount < 0) return '不循环（只播放一次）'
  if (loopCount === 0) return '无限循环'
  return loopCount === 1 ? '播放 1 次' : `循环 ${loopCount} 次`
}

export function speedLabel(speed: number | null | undefined): string {
  if (!speed || speed === 1) return '原速'
  return `${speed}× 速度`
}

/** 参数摘要（结果卡片 / 预览面板使用） */
export function summarizeParams(
  params: GifParams,
  presetId?: string | null,
  format: AnimFormat = 'gif',
): string {
  const parts: string[] = [presetName(presetId ?? detectPresetId(params))]
  if (format === 'webp') {
    // WebP 由编码器直接生成，不展示 gifski/调色板等 GIF 专属信息
    parts.push('WebP')
  } else {
    parts.push(encoderLabel(params.encoder))
  }
  parts.push(widthLabel(params.width))
  parts.push(fpsLabel(params.fps))
  if (format === 'gif') parts.push(`${Math.round(params.colors)} 色`)
  parts.push(`质量 ${Math.round(params.quality)}`)
  if (format === 'gif' && params.optimize) {
    parts.push(params.lossy > 0 ? `极限压缩 · lossy ${Math.round(params.lossy)}` : '极限压缩')
  }
  if (params.speed !== 1) parts.push(speedLabel(params.speed))
  if (params.loopCount !== 0) parts.push(loopLabel(params.loopCount))
  if (!params.preserveTiming) parts.push('不还原逐帧时序')
  return parts.join(' · ')
}