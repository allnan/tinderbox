import type { MediaKind, TweetMedia } from '../shared/types'

const TRACKING_HOSTS = new Set(['x.com', 'twitter.com'])

export type TweetUrlParse =
  | { ok: true; url: string; tweetId: string | null }
  | { ok: false; error: string }

/** 从任意文本中抽出推文 id（支持 /status/ 与 /statuses/） */
export function extractTweetId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const match = String(raw).match(/(?:status|statuses)\/(\d{1,25})/i)
  return match ? match[1] : null
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www\.|mobile\.|m\.)/, '')
}

/** 是否为合法的 X / Twitter 推文链接（允许省略协议） */
export function isTweetUrl(raw: string | null | undefined): boolean {
  const text = String(raw ?? '').trim()
  if (!text) return false
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (!TRACKING_HOSTS.has(normalizedHost(parsed.hostname))) return false
  return /\/status(?:es)?\/\d+/i.test(parsed.pathname)
}

/** 校验并规范化用户输入的推文链接（界面输入框使用） */
export function normalizeTweetInput(raw: string | null | undefined): TweetUrlParse {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, error: '请输入 X（Twitter）推文链接' }
  if (!isTweetUrl(text)) {
    return { ok: false, error: '链接格式不正确，请形如 https://x.com/用户名/status/1234567890' }
  }
  const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`
  const parsed = new URL(withProtocol)
  parsed.protocol = 'https:'
  parsed.hostname = 'x.com'
  parsed.search = ''
  parsed.hash = ''
  return { ok: true, url: parsed.toString(), tweetId: extractTweetId(text) }
}

export function mediaKindLabel(kind: MediaKind): string {
  if (kind === 'gif') return '动图'
  if (kind === 'video') return '视频'
  return '图片'
}

/** 只有动图（animated_gif）与视频可转换；图片仅展示 */
export function isConvertibleKind(kind: MediaKind): boolean {
  return kind === 'gif' || kind === 'video'
}

export function countConvertibleMedia(media: TweetMedia[] | null | undefined): number {
  if (!media) return 0
  return media.filter((item) => isConvertibleKind(item.kind)).length
}

/** 尺寸文案，如 '1080 × 1920' */
export function mediaSizeLabel(width: number | null | undefined, height: number | null | undefined): string {
  if (!width || !height) return '尺寸未知'
  return `${Math.round(width)} × ${Math.round(height)}`
}

/** 历史媒体记录 → 转换请求所需的 TweetMedia（改参数再导出时使用） */
export function historyMediaToTweetMedia(media: {
  id: string
  kind: MediaKind
  sourceUrl: string
  thumbnailUrl: string | null
  probe: { width: number; height: number; durationSec: number } | null
}): TweetMedia {
  return {
    id: media.id,
    kind: media.kind,
    sourceUrl: media.sourceUrl,
    thumbnailUrl: media.thumbnailUrl,
    width: media.probe?.width ?? null,
    height: media.probe?.height ?? null,
    durationSec: media.probe?.durationSec ?? null,
    variants: [],
  }
}