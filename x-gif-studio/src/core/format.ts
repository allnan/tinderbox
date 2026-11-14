/**
 * 展示层数值格式化纯函数：体积、时长、帧率、数量、日期。
 * 所有函数对 null / undefined / NaN / 负数均返回占位符「—」，避免界面出现 NaN。
 */

const EMPTY = '—'

function trimZeros(text: string): string {
  if (!text.includes('.')) return text
  return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

/** 字节数 → 人类可读体积，如 1536 → '1.5 KB' */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return EMPTY
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${trimZeros(value.toFixed(digits))} ${units[index]}`
}

/** 秒 → 中文时长，如 0.5 → '500 毫秒'，75 → '1 分 15 秒' */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return EMPTY
  if (seconds === 0) return '0 秒'
  const ms = seconds * 1000
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`
  if (seconds < 10) return `${trimZeros(seconds.toFixed(1))} 秒`
  const total = Math.round(seconds)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (minutes < 60) return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const leftMinutes = minutes % 60
  return leftMinutes > 0 ? `${hours} 小时 ${leftMinutes} 分` : `${hours} 小时`
}

/** 帧率 → '25 fps' / '29.97 fps' */
export function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || !Number.isFinite(fps) || fps <= 0) return EMPTY
  const rounded = Math.round(fps * 100) / 100
  return Number.isInteger(rounded) ? `${rounded} fps` : `${trimZeros(rounded.toFixed(2))} fps`
}

/** 数量 → 带千分位，如 1234 → '1,234' */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY
  const sign = value < 0 ? '-' : ''
  const text = String(Math.round(Math.abs(value)))
  return sign + text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function parseDate(input: string | null | undefined): Date | null {
  if (!input) return null
  const date = new Date(input)
  return Number.isNaN(date.getTime()) ? null : date
}

/** ISO 时间 → 'YYYY-MM-DD HH:mm'（本地时区） */
export function formatDateTime(input: string | null | undefined): string {
  const date = parseDate(input)
  if (!date) return EMPTY
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** ISO 时间 → 'YYYY-MM-DD' */
export function formatDate(input: string | null | undefined): string {
  const date = parseDate(input)
  if (!date) return EMPTY
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** ISO 时间 → 相对时间（中文），无法解析时返回 '—' */
export function formatRelativeTime(input: string | null | undefined, now: number = Date.now()): string {
  const date = parseDate(input)
  if (!date) return EMPTY
  const diff = now - date.getTime()
  if (diff < -60_000) return formatDateTime(input)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatDate(input)
}

/** 百分比 → '42%'（0-100 截断，未知 -1 返回 '—'） */
export function formatPercent(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || !Number.isFinite(percent) || percent < 0) return EMPTY
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`
}

/** 秒数 → 紧凑时长，用于卡片角标，如 3.5 → '0:03' */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return EMPTY
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${pad(rest)}`
}
/** 相对源文件体积的倍数文案，如 '约为源 mp4 的 10.2 倍'；数据缺失时返回 null */
export function formatSizeRatio(
  targetBytes: number | null | undefined,
  sourceBytes: number | null | undefined,
  sourceLabel = '源视频',
): string | null {
  if (
    targetBytes === null ||
    targetBytes === undefined ||
    sourceBytes === null ||
    sourceBytes === undefined ||
    !Number.isFinite(targetBytes) ||
    !Number.isFinite(sourceBytes) ||
    targetBytes <= 0 ||
    sourceBytes <= 0
  ) {
    return null
  }
  const ratio = targetBytes / sourceBytes
  const digits = ratio >= 100 ? 0 : ratio >= 10 ? 1 : 2
  const spacer = /[A-Za-z0-9]$/.test(sourceLabel) ? ' ' : ''
  return `约为${sourceLabel}${spacer}的 ${trimZeros(ratio.toFixed(digits))} 倍`
}