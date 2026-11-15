import { describe, expect, test } from './_testkit'
import type { GifResult, HistoryEntry } from '../shared/types'
import {
  countHistoryResults,
  filterHistoryEntries,
  historyPreviewPath,
  latestResult,
  sortHistoryEntries,
  sortResults,
  summarizeTweetText,
  totalHistorySize,
} from './history'

function makeResult(id: string, createdAt: string, size = 1000, path = 'C:\\out\\a.gif'): GifResult {
  return {
    id,
    tweetId: 't1',
    mediaId: 'm1',
    gifPath: path,
    info: {
      path,
      fileName: id + '.gif',
      width: 480,
      height: 270,
      sizeBytes: size,
      frameCount: 10,
      durationSec: 3,
      fps: 12,
      frameDelaysMs: [],
    },
    params: {
      encoder: 'gifski',
      width: null,
      fps: 'source',
      colors: 256,
      quality: 92,
      dither: 'sierra2_4a',
      preserveTiming: true,
      optimize: false,
      lossy: 0,
      speed: 1,
      loopCount: 0,
    },
    presetId: 'source',
    createdAt,
    copies: [],
    sourceProbe: null,
    sourceSaved: null,
  }
}

const ENTRIES: HistoryEntry[] = [
  {
    id: 't1',
    tweetUrl: 'https://x.com/jack/status/1',
    author: { name: 'Jack', screenName: 'jack', avatarUrl: null, verified: false },
    text: 'Hello GIF world',
    tweetCreatedAt: '2026-11-01T00:00:00.000Z',
    fetchedAt: '2026-11-10T00:00:00.000Z',
    lastOpenedAt: '2026-11-10T00:00:00.000Z',
    media: [],
    savedMedia: [],
    results: [makeResult('r1', '2026-11-10T00:00:00.000Z', 1000), makeResult('r2', '2026-11-10T02:00:00.000Z', 2000)],
  },
  {
    id: 't2',
    tweetUrl: 'https://x.com/alice/status/2',
    author: { name: 'Alice', screenName: 'alice_x', avatarUrl: null, verified: true },
    text: '另一个推文内容',
    tweetCreatedAt: null,
    fetchedAt: '2026-11-11T00:00:00.000Z',
    lastOpenedAt: '2026-11-11T00:00:00.000Z',
    media: [
      { id: 'm9', kind: 'gif', sourceUrl: 'https://video.twimg.com/x.mp4', thumbnailUrl: 'https://pbs.twimg.com/t.jpg', localPath: null, probe: null },
    ],
    savedMedia: [],
    results: [],
  },
]

describe('filterHistoryEntries', () => {
  test('空查询返回全部', () => {
    expect(filterHistoryEntries(ENTRIES, '').length).toBe(2)
    expect(filterHistoryEntries(ENTRIES, '   ').length).toBe(2)
  })

  test('匹配作者、屏幕名、正文、链接（大小写不敏感）', () => {
    expect(filterHistoryEntries(ENTRIES, 'jack').length).toBe(1)
    expect(filterHistoryEntries(ENTRIES, 'JACK').length).toBe(1)
    expect(filterHistoryEntries(ENTRIES, 'alice_x').length).toBe(1)
    expect(filterHistoryEntries(ENTRIES, '推文内容').length).toBe(1)
    expect(filterHistoryEntries(ENTRIES, 'https://x.com/jack/status/1').length).toBe(1)
    expect(filterHistoryEntries(ENTRIES, '不存在').length).toBe(0)
  })
})

describe('统计与排序', () => {
  test('结果数量与总体积', () => {
    expect(countHistoryResults(ENTRIES)).toBe(2)
    expect(totalHistorySize(ENTRIES)).toBe(3000)
    expect(countHistoryResults([])).toBe(0)
    expect(totalHistorySize([])).toBe(0)
  })

  test('按最后打开时间倒序', () => {
    const sorted = sortHistoryEntries([...ENTRIES].reverse())
    expect(sorted[0].id).toBe('t2')
    expect(sorted[1].id).toBe('t1')
  })

  test('无效时间不抛异常', () => {
    const broken: HistoryEntry[] = [{ ...ENTRIES[0], lastOpenedAt: 'bad', fetchedAt: 'bad' }]
    expect(sortHistoryEntries(broken).length).toBe(1)
  })
})

describe('分组摘要', () => {
  test('latestResult 取最新创建的结果', () => {
    expect(latestResult(ENTRIES[0])?.id).toBe('r2')
    expect(latestResult(ENTRIES[1])).toBeNull()
  })

  test('historyPreviewPath 优先 GIF 路径，其次媒体缩略图', () => {
    expect(historyPreviewPath(ENTRIES[0])).toBe('C:\\out\\a.gif')
    expect(historyPreviewPath(ENTRIES[1])).toBe('https://pbs.twimg.com/t.jpg')
  })

  test('sortResults 按创建时间倒序', () => {
    expect(sortResults(ENTRIES[0].results).map((item) => item.id)).toEqual(['r2', 'r1'])
  })

  test('正文折叠与截断', () => {
    expect(summarizeTweetText('a  b\nc')).toBe('a b c')
    const long = summarizeTweetText('x'.repeat(200), 20)
    expect(long.length).toBe(20)
    expect(long.endsWith('…')).toBeTruthy()
    expect(summarizeTweetText('')).toBe('')
  })
})