import { describe, expect, test } from './_testkit'
import {
  countConvertibleMedia,
  extractTweetId,
  historyMediaToTweetMedia,
  isConvertibleKind,
  isTweetUrl,
  mediaKindLabel,
  mediaSizeLabel,
  normalizeTweetInput,
} from './tweet'
import type { TweetMedia } from '../shared/types'

const MEDIA: TweetMedia[] = [
  {
    id: 'm1',
    kind: 'gif',
    sourceUrl: 'https://video.twimg.com/a.mp4',
    thumbnailUrl: null,
    width: 480,
    height: 270,
    durationSec: 3,
    variants: [],
  },
  {
    id: 'm2',
    kind: 'video',
    sourceUrl: 'https://video.twimg.com/b.mp4',
    thumbnailUrl: null,
    width: 1280,
    height: 720,
    durationSec: 12,
    variants: [],
  },
  {
    id: 'm3',
    kind: 'photo',
    sourceUrl: 'https://pbs.twimg.com/c.jpg',
    thumbnailUrl: null,
    width: 1200,
    height: 800,
    durationSec: null,
    variants: [],
  },
]

describe('isTweetUrl', () => {
  test('接受 x.com / twitter.com 的 status 链接', () => {
    expect(isTweetUrl('https://x.com/jack/status/20')).toBeTruthy()
    expect(isTweetUrl('x.com/jack/status/20')).toBeTruthy()
    expect(isTweetUrl('https://twitter.com/foo/statuses/1234567890?s=20')).toBeTruthy()
    expect(isTweetUrl('https://mobile.twitter.com/a/status/12345')).toBeTruthy()
    expect(isTweetUrl('http://x.com/a/status/12345')).toBeTruthy()
  })

  test('拒绝非推文链接', () => {
    expect(isTweetUrl('')).toBeFalsy()
    expect(isTweetUrl('   ')).toBeFalsy()
    expect(isTweetUrl('https://example.com/a/status/123')).toBeFalsy()
    expect(isTweetUrl('https://x.com/jack')).toBeFalsy()
    expect(isTweetUrl('https://x.com/jack/status')).toBeFalsy()
    expect(isTweetUrl('not a url')).toBeFalsy()
  })
})

describe('extractTweetId', () => {
  test('抽取状态 id', () => {
    expect(extractTweetId('https://x.com/jack/status/20')).toBe('20')
    expect(extractTweetId('https://twitter.com/a/statuses/1234567890?s=20')).toBe('1234567890')
    expect(extractTweetId('https://x.com/jack')).toBeNull()
    expect(extractTweetId(null)).toBeNull()
  })
})

describe('normalizeTweetInput', () => {
  test('空输入给出中文提示', () => {
    const result = normalizeTweetInput('')
    expect(result.ok).toBeFalsy()
    if (!result.ok) expect(result.error).toContain('请输入')
  })

  test('格式错误给出中文提示', () => {
    const result = normalizeTweetInput('https://example.com/a/status/1')
    expect(result.ok).toBeFalsy()
    if (!result.ok) expect(result.error).toContain('链接格式')
  })

  test('规范化主机、协议并去掉查询串', () => {
    const result = normalizeTweetInput('twitter.com/foo/status/1234567890?s=20&t=abc#x')
    expect(result.ok).toBeTruthy()
    if (result.ok) {
      expect(result.url).toBe('https://x.com/foo/status/1234567890')
      expect(result.tweetId).toBe('1234567890')
    }
    const xUrl = normalizeTweetInput('https://x.com/jack/status/20')
    if (xUrl.ok) expect(xUrl.url).toBe('https://x.com/jack/status/20')
  })
})

describe('媒体工具', () => {
  test('媒体类型中文名与可转换判定', () => {
    expect(mediaKindLabel('gif')).toBe('动图')
    expect(mediaKindLabel('video')).toBe('视频')
    expect(mediaKindLabel('photo')).toBe('图片')
    expect(isConvertibleKind('gif')).toBeTruthy()
    expect(isConvertibleKind('video')).toBeTruthy()
    expect(isConvertibleKind('photo')).toBeFalsy()
  })

  test('统计可转换媒体数量', () => {
    expect(countConvertibleMedia(MEDIA)).toBe(2)
    expect(countConvertibleMedia([])).toBe(0)
    expect(countConvertibleMedia(null)).toBe(0)
  })

  test('尺寸文案', () => {
    expect(mediaSizeLabel(1080, 1920)).toBe('1080 × 1920')
    expect(mediaSizeLabel(null, null)).toBe('尺寸未知')
  })

  test('历史媒体转为 TweetMedia', () => {
    const media = historyMediaToTweetMedia({
      id: 'm1',
      kind: 'gif',
      sourceUrl: 'https://video.twimg.com/a.mp4',
      thumbnailUrl: 'https://pbs.twimg.com/a.jpg',
      probe: { width: 480, height: 270, durationSec: 3.2 },
    })
    expect(media.id).toBe('m1')
    expect(media.width).toBe(480)
    expect(media.durationSec).toBe(3.2)
    expect(media.variants).toEqual([])

    const empty = historyMediaToTweetMedia({
      id: 'm2',
      kind: 'video',
      sourceUrl: 'https://video.twimg.com/b.mp4',
      thumbnailUrl: null,
      probe: null,
    })
    expect(empty.width).toBeNull()
    expect(empty.height).toBeNull()
    expect(empty.durationSec).toBeNull()
  })
})