import { describe, expect, test } from './_testkit'
import type { HistoryEntry, SavedMedia, TweetMedia } from '../shared/types'
import {
  describeSavedMedia,
  findSavedMedia,
  historyMediaCounts,
  indexSavedMedia,
  mediaActionMenu,
  mediaKindName,
  savedFormatLabel,
  savedFormatSummary,
  savedStateOf,
} from './media-actions'

function savedOf(overrides: Partial<SavedMedia> = {}): SavedMedia {
  return {
    id: 's1',
    tweetId: 't1',
    mediaId: 'm1',
    mediaKind: 'gif',
    format: 'mp4',
    filePath: 'C:\\out\\a.mp4',
    fileName: 'a.mp4',
    width: 480,
    height: 480,
    durationSec: 2.5,
    sizeBytes: 257000,
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  }
}

const mediaOf = (kind: TweetMedia['kind']): TweetMedia => ({
  id: 'm1',
  kind,
  sourceUrl: 'https://video.twimg.com/a.mp4',
  thumbnailUrl: null,
  width: 480,
  height: 480,
  durationSec: kind === 'photo' ? null : 2.5,
  variants: [],
})

describe('savedFormatLabel / mediaKindName', () => {
  test('格式徽标文案', () => {
    expect(savedFormatLabel('mp4')).toBe('视频')
    expect(savedFormatLabel('jpg')).toBe('JPG')
    expect(savedFormatLabel('png')).toBe('PNG')
    expect(savedFormatLabel('webp')).toBe('WebP')
    expect(savedFormatLabel(null)).toBe('文件')
  })

  test('媒体类型中文名', () => {
    expect(mediaKindName('gif')).toBe('动图')
    expect(mediaKindName('video')).toBe('视频')
    expect(mediaKindName('photo')).toBe('图片')
  })
})

describe('findSavedMedia / indexSavedMedia / savedStateOf', () => {
  test('按 mediaId 查找与索引', () => {
    const list = [savedOf({ id: 'a', mediaId: 'm1' }), savedOf({ id: 'b', mediaId: 'm2', format: 'jpg' })]
    expect(findSavedMedia(list, 'm2')?.id).toBe('b')
    expect(findSavedMedia(list, 'm9')).toBeNull()
    expect(findSavedMedia(null, 'm1')).toBeNull()
    const index = indexSavedMedia(list)
    expect(index.m1.id).toBe('a')
    expect(index.m2.id).toBe('b')
    expect(indexSavedMedia(undefined)).toEqual({})
  })

  test('保存状态 saved / saving / unsaved', () => {
    const list = [savedOf({ mediaId: 'm1' })]
    expect(savedStateOf(list, 'm1')).toBe('saved')
    expect(savedStateOf(list, 'm2')).toBe('unsaved')
    expect(savedStateOf(list, 'm2', ['m2'])).toBe('saving')
    expect(savedStateOf([], 'm1', ['m1'])).toBe('saving')
  })
})

describe('describeSavedMedia', () => {
  test('格式 · 尺寸 · 时长 · 体积', () => {
    const text = describeSavedMedia(savedOf())
    expect(text).toContain('视频')
    expect(text).toContain('480 × 480')
    expect(text).toContain('2.5 秒')
    expect(text).toContain('251 KB')
  })

  test('图片没有时长，缺尺寸时省略', () => {
    const text = describeSavedMedia(savedOf({ format: 'jpg', durationSec: null, width: null, height: null }))
    expect(text).toContain('JPG')
    expect(text.includes('秒')).toBeFalsy()
    expect(text.includes('×')).toBeFalsy()
    expect(describeSavedMedia(null)).toBe('')
  })
})

describe('mediaActionMenu 状态机', () => {
  test('未保存的 GIF：保存 + 自动保存转换 + 复制链接', () => {
    const items = mediaActionMenu({ media: mediaOf('gif'), saved: null })
    expect(items.map((item) => item.id)).toEqual(['save', 'convert', 'copy-source'])
    expect(items[0].label).toBe('保存媒体')
    expect(items[1].label).toContain('未保存则自动保存')
    expect(items.every((item) => !item.disabled)).toBeTruthy()
  })

  test('已保存的 GIF：不再有保存项，改为打开文件位置 + 转换（使用已保存文件）+ 复制链接', () => {
    const items = mediaActionMenu({ media: mediaOf('gif'), saved: savedOf() })
    expect(items.map((item) => item.id)).toEqual(['reveal', 'convert', 'copy-source'])
    expect(items[0].label).toBe('打开文件位置')
    expect(items[1].label).toContain('使用已保存文件')
    expect(items.some((item) => item.id === 'save')).toBeFalsy()
  })

  test('图片：保存可用，转换禁用', () => {
    const items = mediaActionMenu({ media: mediaOf('photo'), saved: null })
    expect(items[0].disabled).toBeFalsy()
    expect(items[1].disabled).toBeTruthy()
    expect(items[1].label).toContain('不支持')
  })

  test('保存中：保存/转换禁用，复制链接仍可用', () => {
    const items = mediaActionMenu({ media: mediaOf('video'), saved: null, saving: true })
    expect(items[0].disabled).toBeTruthy()
    expect(items[1].disabled).toBeTruthy()
    expect(items[2].disabled).toBeFalsy()
  })
})

function entryOf(id: string, saved: SavedMedia[], results: HistoryEntry['results']): HistoryEntry {
  return {
    id,
    tweetUrl: 'https://x.com/a/status/' + id,
    author: { name: 'A', screenName: 'a', avatarUrl: null, verified: false },
    text: '',
    tweetCreatedAt: null,
    fetchedAt: '2026-11-11T00:00:00.000Z',
    lastOpenedAt: '2026-11-11T00:00:00.000Z',
    media: [],
    savedMedia: saved,
    results,
  }
}

describe('historyMediaCounts / savedFormatSummary', () => {
  test('按推文去重统计推文/媒体/GIF 数量', () => {
    const result = { id: 'r1' } as HistoryEntry['results'][number]
    const entries = [
      entryOf('t1', [savedOf({ id: 'a', mediaId: 'm1' })], [result]),
      entryOf('t1', [savedOf({ id: 'b', mediaId: 'm2' })], []),
      entryOf('t2', [], []),
    ]
    expect(historyMediaCounts(entries)).toEqual({ tweets: 2, savedMedia: 2, gifs: 1 })
    expect(historyMediaCounts([])).toEqual({ tweets: 0, savedMedia: 0, gifs: 0 })
    expect(historyMediaCounts(null)).toEqual({ tweets: 0, savedMedia: 0, gifs: 0 })
  })

  test('格式分组统计', () => {
    const list = [savedOf({ format: 'mp4' }), savedOf({ id: 'b', format: 'mp4' }), savedOf({ id: 'c', format: 'jpg' })]
    expect(savedFormatSummary(list)).toEqual([
      { format: '视频', count: 2 },
      { format: 'JPG', count: 1 },
    ])
    expect(savedFormatSummary([])).toEqual([])
  })
})