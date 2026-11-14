/**
 * GIF 输出文件名预览与路径工具（纯函数）。
 * 命名规则与 docs/架构与接口契约.md 第 6 节一致：
 * <screenName>_<tweetId>_<media序号>_<宽>x<高>_<preset>_<时间戳>.gif
 */

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

export interface GifFileNameInput {
  screenName?: string | null
  tweetId?: string | null
  mediaIndex?: number | null
  width?: number | null
  height?: number | null
  presetId?: string | null
  /** 生成时间，测试时可注入固定时间 */
  date?: Date
}

/** 清理文件名片段：去掉 Windows 非法字符、首尾点与空格，限制长度 */
export function sanitizeFileNamePart(value: string | null | undefined, fallback = 'unknown'): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/^\.+/, '')
    .replace(INVALID_CHARS, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 48)
  return cleaned || fallback
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Date → 'YYYYMMDD-HHmmss' */
export function formatFileTimestamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 生成导出文件名预览 */
export function buildGifFileName(input: GifFileNameInput): string {
  const screen = sanitizeFileNamePart(input.screenName, 'x')
  const tweet = sanitizeFileNamePart(input.tweetId, 'tweet')
  const index = input.mediaIndex === null || input.mediaIndex === undefined
    ? '1'
    : String(Math.max(1, Math.round(input.mediaIndex)))
  const size =
    input.width !== null && input.width !== undefined && input.width > 0 && input.height !== null && input.height !== undefined && input.height > 0
      ? `${Math.round(input.width)}x${Math.round(input.height)}`
      : 'auto'
  const preset = sanitizeFileNamePart(input.presetId, 'custom')
  return `${screen}_${tweet}_${index}_${size}_${preset}_${formatFileTimestamp(input.date)}.gif`
}

/** 取路径最后一段文件名 */
export function fileBaseName(filePath: string | null | undefined): string {
  if (!filePath) return ''
  const parts = String(filePath).split(/[\\/]/)
  return parts[parts.length - 1] || String(filePath)
}

/** 中间省略的长路径，便于卡片内展示 */
export function shortenPath(filePath: string | null | undefined, max = 64): string {
  if (!filePath) return ''
  const text = String(filePath)
  if (text.length <= max) return text
  const keep = Math.max(8, Math.floor((max - 1) / 2))
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`
}