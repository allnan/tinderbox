'use strict'

/**
 * 推文链接解析与公开接口抓取。
 *
 * - parseTweetUrl：支持 x.com / twitter.com / mobile.twitter.com 的
 *   {user|i|i/web|web}/status/{id} 链接（带查询参数、/photo/1 等后缀、移动端链接均可）；
 * - fetch：按 fxtwitter v2 → fxtwitter v1 → syndication → vxtwitter 的顺序尝试，
 *   归一化为 src/shared/types.ts 中的 TweetInfo；
 * - 不要求登录；失败时抛出可直接展示的中文错误（不存在 / 受保护 / 无媒体 / 网络失败）。
 *
 * 网络请求统一走 network.cjs：
 * - Electron 主进程内为 net.fetch（Chromium 网络栈），自动经过默认 session 上配置的代理；
 * - 纯 Node（测试/脚本）退化为全局 fetch；
 * 禁止在这里直接调用全局 fetch，否则代理设置不会生效（见 docs/网络与代理.md）。
 *
 * 额外提供 getCached(tweetId)：转换流水线（gif.cjs）在只拿到 tweetId 时，
 * 从这里取回最近一次解析的推文信息，用于输出目录命名与历史记录。
 */

const network = require('./network.cjs')

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 15000
const MAX_CACHE = 20
const tweetCache = new Map()

function tweetError(message, code) {
  const error = new Error(message)
  error.code = code || 'TWEET_FETCH_FAILED'
  return error
}

/**
 * 解析推文链接。
 * @param {string} url
 * @returns {{tweetId:string, canonicalUrl:string, screenName:string|null}|null}
 */
function parseTweetUrl(url) {
  if (typeof url !== 'string') return null
  let text = url.trim()
  if (!text) return null
  // 去掉包裹的尖括号/括号/中文引号等常见粘贴内容
  text = text.replace(/^[<（(【「\s]+/, '').replace(/[>）)】」\s]+$/, '')
  text = text.replace(/^https?:\/\//i, '')
  text = text.replace(/^www\./i, '')
  text = text.replace(/^(?:mobile|m)\./i, '')
  const match = text.match(/^(x\.com|twitter\.com)\/(?:([A-Za-z0-9_]{1,30})|i\/web|i|web)\/status(?:es)?\/(\d{5,25})(?:[/?#].*)?$/i)
  if (!match) return null
  const tweetId = match[3]
  const rawUser = match[2]
  const screenName = rawUser && !/^(i|web)$/i.test(rawUser) ? rawUser : null
  const canonicalUrl = screenName
    ? 'https://x.com/' + screenName + '/status/' + tweetId
    : 'https://x.com/i/status/' + tweetId
  return { tweetId, canonicalUrl, screenName }
}

/** syndication 接口的 token 算法（公开接口的已知实现） */
function syndicationToken(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

function httpFetch(url, options = {}) {
  const timeout = options.timeoutMs || REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  return network.fetch(url, {
    signal: controller.signal,
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      ...(options.headers || {}),
    },
  }).finally(() => clearTimeout(timer))
}

async function fetchJsonEndpoint(url, label) {
  let response
  try {
    response = await httpFetch(url, { timeoutMs: REQUEST_TIMEOUT_MS })
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? '请求超时' : '网络连接失败'
    const wrapped = tweetError(label + ' 接口' + reason + '：' + (error && error.message ? error.message : String(error)), 'NETWORK_ERROR')
    wrapped.network = true
    throw wrapped
  }
  const text = await response.text().catch(() => '')
  if (response.status === 404) {
    const error = tweetError('推文不存在或已被删除', 'TWEET_NOT_FOUND')
    error.notFound = true
    throw error
  }
  if (response.status === 401 || response.status === 403) {
    const error = tweetError('该推文受保护或账号不可用，无法读取', 'TWEET_PROTECTED')
    error.protected = true
    throw error
  }
  if (response.status === 429) {
    const error = tweetError('请求过于频繁，请稍后再试', 'TWEET_RATE_LIMIT')
    error.network = true
    throw error
  }
  if (!response.ok) {
    const error = tweetError(label + ' 接口请求失败（HTTP ' + response.status + '）', 'TWEET_FETCH_FAILED')
    error.network = true
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    const error = tweetError(label + ' 接口返回了无法解析的数据', 'TWEET_FETCH_FAILED')
    error.network = true
    throw error
  }
}

// ---------------------------------------------------------------------------
// 归一化辅助
// ---------------------------------------------------------------------------

function safeText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/https:\/\/t\.co\/\w+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isoDate(value) {
  if (!value) return null
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** 把 pbs.twimg.com 图片地址规范到原图 */
function originalPhotoUrl(url) {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    if (/(^|\.)pbs\.twimg\.com$/i.test(parsed.hostname)) {
      parsed.searchParams.set('name', 'orig')
      return parsed.toString()
    }
    return url
  } catch {
    return url
  }
}

/** 从 video.twimg.com 的变体地址里推断尺寸（如 /vid/avc1/480x486/xxx.mp4） */
function sizeFromVariantUrl(url) {
  if (typeof url !== 'string') return { width: null, height: null }
  const match = url.match(/\/vid\/[^/]+\/(\d+)x(\d+)\//i) || url.match(/\/(\d{2,5})x(\d{2,5})\//)
  if (!match) return { width: null, height: null }
  return { width: Number(match[1]) || null, height: Number(match[2]) || null }
}

function pickBestMp4(variants, fallbackUrl) {
  const mp4 = (variants || []).filter((item) => {
    const contentType = String(item.content_type || item.container || '')
    if (/mpegurl/i.test(contentType)) return false
    if (/mp4/i.test(contentType)) return true
    return /\.mp4(?:[?#]|$)/i.test(String(item.url || ''))
  })
  if (mp4.length === 0) return fallbackUrl || ((variants || [])[0] && variants[0].url) || null
  mp4.sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
  return mp4[0].url
}

function normalizeVariant(variant) {
  const url = variant.url || variant.src || ''
  const size = sizeFromVariantUrl(url)
  return {
    url,
    bitrate: Number(variant.bitrate) || 0,
    width: variant.width != null ? Number(variant.width) : size.width,
    height: variant.height != null ? Number(variant.height) : size.height,
  }
}

const KIND_MAP = {
  gif: 'gif',
  animated_gif: 'gif',
  animatedgif: 'gif',
  video: 'video',
  photo: 'photo',
  image: 'photo',
}

function normalizeKind(type) {
  return KIND_MAP[String(type || '').toLowerCase()] || null
}

// ---------------------------------------------------------------------------
// fxtwitter 归一化
// ---------------------------------------------------------------------------

function normalizeFxTweet(tweet, source, canonicalUrl) {
  if (!tweet || typeof tweet !== 'object') return null
  const authorSource = tweet.author || {}
  const verification = authorSource.verification || {}
  const author = {
    name: String(authorSource.name || authorSource.screen_name || '未知用户'),
    screenName: String(authorSource.screen_name || ''),
    avatarUrl: authorSource.avatar_url || authorSource.profile_image_url_https || null,
    verified: Boolean(authorSource.verified || verification.verified || authorSource.is_blue_verified),
  }
  const authorScreen = author.screenName || (canonicalUrl ? (canonicalUrl.match(/x\.com\/([^/]+)\//) || [])[1] : '') || ''
  const mediaSource = (tweet.media && (tweet.media.all || tweet.media.videos || tweet.media.photos)) || []
  const media = []
  for (let index = 0; index < mediaSource.length; index += 1) {
    const item = mediaSource[index] || {}
    const kind = normalizeKind(item.type)
    if (!kind) continue
    const rawVariants = item.variants || item.formats || []
    const variants = rawVariants.map(normalizeVariant).filter((variant) => variant.url)
    let sourceUrl
    if (kind === 'photo') {
      sourceUrl = originalPhotoUrl(item.url || (variants[0] && variants[0].url) || '')
    } else {
      sourceUrl = pickBestMp4(rawVariants, item.url)
    }
    if (!sourceUrl) continue
    const width = item.width != null ? Number(item.width) : item.original_info ? Number(item.original_info.width) : null
    const height = item.height != null ? Number(item.height) : item.original_info ? Number(item.original_info.height) : null
    let durationSec = null
    if (Number.isFinite(Number(item.duration)) && Number(item.duration) > 0) durationSec = Math.round(Number(item.duration) * 1000) / 1000
    else if (Number.isFinite(Number(item.duration_millis)) && Number(item.duration_millis) > 0) durationSec = Math.round(Number(item.duration_millis)) / 1000
    media.push({
      id: String(item.id || item.id_str || 'media-' + (index + 1)),
      kind,
      sourceUrl,
      thumbnailUrl: item.thumbnail_url || (kind === 'photo' ? sourceUrl : null),
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      durationSec,
      variants,
    })
  }
  const text = safeText(tweet.text) || safeText(tweet.raw_text && tweet.raw_text.text) || ''
  return {
    id: String(tweet.id || tweet.id_str || ''),
    url: typeof tweet.url === 'string' && /(?:x|twitter)\.com\/.*\/status\//i.test(tweet.url) ? tweet.url : canonicalUrl,
    author: { ...author, screenName: authorScreen || author.screenName },
    text,
    createdAt: isoDate(tweet.created_at || tweet.created_timestamp),
    media,
    source,
    fetchedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// syndication 归一化
// ---------------------------------------------------------------------------

function normalizeSyndication(json, canonicalUrl) {
  if (!json || typeof json !== 'object') return null
  if (String(json.__typename || '').includes('Tombstone')) return null
  if (!json.id_str && !json.id) return null
  const user = json.user || {}
  const avatar = String(user.profile_image_url_https || '').replace(/_normal(\.(?:jpg|jpeg|png|gif|webp))/i, '_400x400$1')
  const author = {
    name: String(user.name || user.screen_name || '未知用户'),
    screenName: String(user.screen_name || ''),
    avatarUrl: avatar || null,
    verified: Boolean(user.verified || user.is_blue_verified),
  }
  const details = Array.isArray(json.mediaDetails) ? json.mediaDetails : []
  const media = []
  for (let index = 0; index < details.length; index += 1) {
    const item = details[index] || {}
    const kind = normalizeKind(item.type)
    if (!kind) continue
    const rawVariants = (item.video_info && item.video_info.variants) || []
    const variants = rawVariants.map(normalizeVariant).filter((variant) => variant.url)
    let sourceUrl
    if (kind === 'photo') {
      sourceUrl = originalPhotoUrl(item.media_url_https || item.url || '')
    } else {
      sourceUrl = pickBestMp4(rawVariants, null)
    }
    if (!sourceUrl) continue
    const width = item.original_info && item.original_info.width ? Number(item.original_info.width) : null
    const height = item.original_info && item.original_info.height ? Number(item.original_info.height) : null
    let durationSec = null
    if (item.video_info && Number(item.video_info.duration_millis) > 0) durationSec = Math.round(Number(item.video_info.duration_millis)) / 1000
    else if (json.video && Number(json.video.durationMs) > 0) durationSec = Math.round(Number(json.video.durationMs)) / 1000
    media.push({
      id: deriveSyndicationMediaId(item, index),
      kind,
      sourceUrl,
      thumbnailUrl: item.media_url_https || (json.video && json.video.poster) || null,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      durationSec,
      variants,
    })
  }
  const tweetId = String(json.id_str || json.id || '')
  const screenName = author.screenName
  const url = canonicalUrl || (tweetId ? (screenName ? 'https://x.com/' + screenName + '/status/' + tweetId : 'https://x.com/i/status/' + tweetId) : '')
  return {
    id: tweetId,
    url,
    author,
    text: safeText(json.text) || '',
    createdAt: isoDate(json.created_at),
    media,
    source: 'syndication',
    fetchedAt: new Date().toISOString(),
  }
}

function deriveSyndicationMediaId(item, index) {
  const candidates = [item.media_url_https, item.expanded_url, item.url]
  for (const candidate of candidates) {
    const text = String(candidate || '')
    const videoMatch = text.match(/\/(?:tweet_video|amplify_video|ext_tw_video)\/(\d+)/)
    if (videoMatch) return videoMatch[1]
    const fileMatch = text.match(/\/([A-Za-z0-9_-]{6,})\.(?:jpg|jpeg|png|webp|mp4)/i)
    if (fileMatch) return fileMatch[1]
  }
  return 'media-' + (index + 1)
}

// ---------------------------------------------------------------------------
// vxtwitter 归一化（第三回退）
// ---------------------------------------------------------------------------

function normalizeVxTweet(json, canonicalUrl) {
  if (!json || typeof json !== 'object') return null
  if (!json.tweetURL && !json.tweet_id && !json.user_screen_name) return null
  const author = {
    name: String(json.user_name || '未知用户'),
    screenName: String(json.user_screen_name || ''),
    avatarUrl: json.user_profile_image_url || null,
    verified: Boolean(json.user_verified),
  }
  const items = Array.isArray(json.media_extended) ? json.media_extended : []
  const media = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {}
    const kind = normalizeKind(item.type)
    if (!kind) continue
    const sourceUrl = kind === 'photo' ? originalPhotoUrl(item.url) : item.url
    if (!sourceUrl) continue
    media.push({
      id: deriveSyndicationMediaId(item, index),
      kind,
      sourceUrl,
      thumbnailUrl: item.thumbnail_url || (kind === 'photo' ? sourceUrl : null),
      width: item.size && Number(item.size.width) > 0 ? Number(item.size.width) : null,
      height: item.size && Number(item.size.height) > 0 ? Number(item.size.height) : null,
      durationSec: Number(item.duration_millis) > 0 ? Math.round(Number(item.duration_millis)) / 1000 : null,
      variants: [],
    })
  }
  const tweetId = String(json.tweet_id || (json.tweetURL || '').match(/status\/(\d+)/)?.[1] || '')
  return {
    id: tweetId,
    url: canonicalUrl || json.tweetURL || '',
    author,
    text: safeText(json.text) || '',
    createdAt: isoDate(json.date || json.date_epoch),
    media,
    source: 'vxtwitter',
    fetchedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

function rememberTweet(info) {
  if (!info || !info.id) return
  tweetCache.delete(info.id)
  tweetCache.set(info.id, info)
  if (tweetCache.size > MAX_CACHE) {
    const oldest = tweetCache.keys().next().value
    tweetCache.delete(oldest)
  }
}

/** 取最近一次 fetch 得到的推文信息（不存在时返回 null） */
function getCached(tweetId) {
  if (!tweetId) return null
  return tweetCache.get(String(tweetId)) || null
}

function clearCache() {
  tweetCache.clear()
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function finalizeTweet(info, canonicalUrl) {
  if (!info || !Array.isArray(info.media)) return null
  if (!info.id) return null
  if (info.media.length === 0) return info
  return info
}

function ensureMedia(info) {
  if (info.media.length === 0) {
    throw tweetError('该推文没有可转换的媒体（没有 GIF、视频或图片）', 'NO_MEDIA')
  }
  return info
}

/**
 * 抓取并归一化推文。
 * @param {string} url
 * @returns {Promise<import('../src/shared/types').TweetInfo>}
 */
async function fetchTweet(url) {
  const parsed = parseTweetUrl(url)
  if (!parsed) {
    throw tweetError('链接格式不正确，请输入 X 或 Twitter 的推文链接（例如 https://x.com/user/status/1234567890）', 'INVALID_URL')
  }
  const { tweetId, canonicalUrl, screenName } = parsed
  const endpointErrors = []
  const endpoints = [
    {
      label: 'fxtwitter',
      run: async () => {
        const json = await fetchJsonEndpoint('https://api.fxtwitter.com/2/status/' + tweetId, 'fxtwitter')
        const tweet = json && (json.status || json.tweet)
        if (!tweet) {
          if (json && (json.code === 404 || json.code === 'NOT_FOUND')) throw tweetError('推文不存在或已被删除', 'TWEET_NOT_FOUND')
          throw tweetError('fxtwitter 接口没有返回推文数据', 'TWEET_FETCH_FAILED')
        }
        return normalizeFxTweet(tweet, 'fxtwitter', canonicalUrl)
      },
    },
    {
      label: 'fxtwitter-v1',
      run: async () => {
        const path = screenName ? screenName + '/status/' + tweetId : 'i/status/' + tweetId
        const json = await fetchJsonEndpoint('https://api.fxtwitter.com/' + path, 'fxtwitter')
        const tweet = json && json.tweet
        if (!tweet) throw tweetError('fxtwitter 接口没有返回推文数据', 'TWEET_FETCH_FAILED')
        return normalizeFxTweet(tweet, 'fxtwitter', canonicalUrl)
      },
    },
    {
      label: 'syndication',
      run: async () => {
        const endpoint = 'https://cdn.syndication.twimg.com/tweet-result?id=' + tweetId + '&lang=en&token=' + syndicationToken(tweetId)
        const json = await fetchJsonEndpoint(endpoint, 'syndication')
        const info = normalizeSyndication(json, canonicalUrl)
        if (!info) throw tweetError('syndication 接口没有返回推文数据', 'TWEET_FETCH_FAILED')
        return info
      },
    },
    {
      label: 'vxtwitter',
      run: async () => {
        const json = await fetchJsonEndpoint('https://api.vxtwitter.com/i/status/' + tweetId, 'vxtwitter')
        const info = normalizeVxTweet(json, canonicalUrl)
        if (!info) throw tweetError('vxtwitter 接口没有返回推文数据', 'TWEET_FETCH_FAILED')
        return info
      },
    },
  ]

  let emptyMediaInfo = null
  for (const endpoint of endpoints) {
    try {
      const info = finalizeTweet(await endpoint.run(), canonicalUrl)
      if (info && info.media.length > 0) {
        rememberTweet(info)
        return ensureMedia(info)
      }
      if (info && info.media.length === 0) {
        // 某个接口成功但没解析出媒体：继续尝试其它接口，全部失败后再给「无媒体」结论
        emptyMediaInfo = info
        continue
      }
      endpointErrors.push({ label: endpoint.label, error: tweetError(endpoint.label + ' 接口没有返回推文数据', 'TWEET_FETCH_FAILED') })
    } catch (error) {
      endpointErrors.push({ label: endpoint.label, error })
      // 明确不存在/受保护时记录，但继续尝试其它接口（各接口可用性不同）
    }
  }

  if (emptyMediaInfo) {
    rememberTweet(emptyMediaInfo)
    throw tweetError('该推文没有可转换的媒体（没有 GIF、视频或图片）', 'NO_MEDIA')
  }

  const notFound = endpointErrors.find((item) => item.error && (item.error.notFound || item.error.code === 'TWEET_NOT_FOUND'))
  const notFoundCount = endpointErrors.filter((item) => item.error && (item.error.notFound || item.error.code === 'TWEET_NOT_FOUND')).length
  const protectedCount = endpointErrors.filter((item) => item.error && (item.error.protected || item.error.code === 'TWEET_PROTECTED')).length
  if (notFoundCount >= 2 || (notFound && endpointErrors.length === notFoundCount)) {
    throw tweetError('推文不存在或已被删除', 'TWEET_NOT_FOUND')
  }
  if (protectedCount >= 1) {
    throw tweetError('该推文受保护或账号不可用，无法读取', 'TWEET_PROTECTED')
  }
  const last = endpointErrors[endpointErrors.length - 1]
  const detail = last && last.error && last.error.message ? last.error.message : '未知错误'
  throw tweetError('网络请求失败，请检查网络后重试：' + detail, 'NETWORK_ERROR')
}

module.exports = { parseTweetUrl, fetch: fetchTweet, getCached, rememberTweet, clearCache, syndicationToken }
