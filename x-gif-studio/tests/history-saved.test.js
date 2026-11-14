'use strict'

/**
 * history.cjs：savedMedia（已保存原始媒体）相关能力与旧数据兼容。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const helpers = require('./helpers.cjs')

const dataDir = helpers.makeTempDataDir('xgif-history-')
const history = require(helpers.libPath('history.cjs'))

const TWEET_ID = '1900000000000000001'

function tweetInfo() {
  return {
    id: TWEET_ID,
    url: 'https://x.com/tester/status/' + TWEET_ID,
    author: { name: 'Tester', screenName: 'tester', avatarUrl: null, verified: false },
    text: '测试推文',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function mediaItem(mediaId = 'm1', kind = 'gif') {
  return { id: mediaId, kind, sourceUrl: 'https://video.twimg.com/x/' + mediaId + '.mp4', thumbnailUrl: null, width: 160, height: 120, durationSec: 0.6, variants: [] }
}

function savedItem(overrides = {}) {
  return {
    id: TWEET_ID + ':m1:mp4',
    tweetId: TWEET_ID,
    mediaId: 'm1',
    mediaKind: 'gif',
    format: 'mp4',
    filePath: path.join(dataDir, 'gifs', 'tester', TWEET_ID, 'tester_' + TWEET_ID + '_1_160x120.mp4'),
    fileName: 'tester_' + TWEET_ID + '_1_160x120.mp4',
    width: 160,
    height: 120,
    durationSec: 0.6,
    sizeBytes: 1234,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

test.after(() => helpers.removeTempDir(dataDir))

test('旧版 history.json（无 savedMedia）读取时补 []，GIF 结果不受影响', async () => {
  const legacyPath = path.join(dataDir, 'history.json')
  const legacy = {
    version: 1,
    entries: {
      [TWEET_ID]: {
        id: TWEET_ID,
        tweetUrl: 'https://x.com/tester/status/' + TWEET_ID,
        author: { name: 'Tester', screenName: 'tester', avatarUrl: null, verified: false },
        text: '旧数据',
        tweetCreatedAt: null,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
        media: [],
        results: [{ id: 'r1', gifPath: path.join(dataDir, 'old.gif'), info: { fileName: 'old.gif' }, createdAt: '2026-01-01T00:00:00.000Z' }],
      },
    },
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(legacyPath, JSON.stringify(legacy), 'utf8')

  const entries = await history.list()
  const entry = entries.find((item) => item.id === TWEET_ID)
  assert.ok(entry, '应读取到旧记录')
  assert.deepEqual(entry.savedMedia, [], '旧记录 savedMedia 应兜底为 []')
  assert.equal(entry.results.length, 1)
  assert.equal(entry.results[0].id, 'r1')
})

test('recordSaved：创建分组、写入 savedMedia 并更新 media.localPath', async () => {
  const saved = savedItem()
  fs.mkdirSync(path.dirname(saved.filePath), { recursive: true })
  fs.writeFileSync(saved.filePath, Buffer.from('mp4-bytes'))
  const probe = { path: saved.filePath, width: 160, height: 120, durationSec: 0.6, frameCount: 18, fps: 30, frameDurationsMs: [30], hasAudio: false, sizeBytes: 9 }

  const entry = await history.recordSaved({ tweetInfo: tweetInfo(), media: mediaItem(), saved, probe })
  assert.equal(entry.id, TWEET_ID)
  assert.equal(entry.author.screenName, 'tester')
  assert.equal(entry.savedMedia.length, 1)
  assert.equal(entry.savedMedia[0].id, saved.id)
  assert.equal(entry.savedMedia[0].filePath, saved.filePath)
  assert.equal(entry.media.length, 1)
  assert.equal(entry.media[0].localPath, saved.filePath)
  assert.equal(entry.media[0].probe.frameCount, 18)
  assert.ok(Array.isArray(entry.results))

  // 重复记录同 id：更新而不是新增
  const updated = await history.recordSaved({ tweetInfo: tweetInfo(), media: mediaItem(), saved: { ...saved, sizeBytes: 4321 }, probe })
  assert.equal(updated.savedMedia.length, 1)
  assert.equal(updated.savedMedia[0].sizeBytes, 4321)
})

test('findSaved：按 tweetId + mediaId（+ 可选格式）读取，未命中返回 null', async () => {
  const saved = savedItem()
  fs.mkdirSync(path.dirname(saved.filePath), { recursive: true })
  fs.writeFileSync(saved.filePath, Buffer.from('x'))
  await history.recordSaved({ tweetInfo: tweetInfo(), media: mediaItem(), saved, probe: null })

  const found = await history.findSaved(TWEET_ID, 'm1')
  assert.equal(found.id, saved.id)
  assert.equal((await history.findSaved(TWEET_ID, 'm1', 'mp4')).id, saved.id)
  assert.equal(await history.findSaved(TWEET_ID, 'm1', 'jpg'), null)
  assert.equal(await history.findSaved(TWEET_ID, 'nope'), null)
  assert.equal(await history.findSaved('nope', 'm1'), null)
})

test('removeSaved：删除记录与文件、清理 media.localPath，且幂等', async () => {
  const savedId = TWEET_ID + ':photo1:jpg'
  const filePath = path.join(dataDir, 'gifs', 'tester', TWEET_ID, 'photo.jpg')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.from('jpg'))
  const saved = savedItem({ id: savedId, mediaId: 'photo1', mediaKind: 'photo', format: 'jpg', filePath, fileName: 'photo.jpg', durationSec: null })
  await history.recordSaved({ tweetInfo: tweetInfo(), media: mediaItem('photo1', 'photo'), saved, probe: null })

  assert.equal(await history.removeSaved(TWEET_ID, savedId), true)
  assert.equal(fs.existsSync(filePath), false, 'removeSaved 应删除文件')
  const entry = await history.get(TWEET_ID)
  assert.ok(!entry.savedMedia.some((item) => item.id === savedId))
  assert.ok(entry.media.every((item) => item.localPath !== filePath))
  // 幂等：再次删除不报错
  assert.equal(await history.removeSaved(TWEET_ID, savedId), true)
  assert.equal(await history.removeSaved('nope', savedId), true)
})

test('recordResult 与 savedMedia 共存：结果写入不会清空已保存媒体', async () => {
  const result = {
    id: 'result-1',
    tweetId: TWEET_ID,
    mediaId: 'm1',
    gifPath: path.join(dataDir, 'r1.gif'),
    info: { path: path.join(dataDir, 'r1.gif'), fileName: 'r1.gif', width: 160, height: 120, sizeBytes: 10, frameCount: 2, durationSec: 0.1, fps: 20, frameDelaysMs: [50, 50] },
    params: {},
    presetId: 'source',
    createdAt: new Date().toISOString(),
    copies: [],
    sourceProbe: null,
    sourceSaved: null,
  }
  const entry = await history.recordResult({ tweetInfo: tweetInfo(), media: mediaItem(), prepared: null, result })
  assert.ok(Array.isArray(entry.savedMedia), 'recordResult 后 savedMedia 字段仍在')
  assert.ok(entry.results.some((item) => item.id === 'result-1'))
  // 内存中的 savedMedia 不应被 recordResult 清空（此前 findSaved 写入的记录仍在）
  assert.ok(Array.isArray(entry.savedMedia))
})


test('remove：deleteFiles=true 同时删除媒体文件，false 保留文件', async () => {
  // 重新建立一条记录与一个真实文件
  const saved = savedItem({
    id: TWEET_ID + ':m9:mp4',
    mediaId: 'm9',
    filePath: path.join(dataDir, 'gifs', 'tester', TWEET_ID, 'tester_' + TWEET_ID + '_9_160x120.mp4'),
  })
  fs.mkdirSync(path.dirname(saved.filePath), { recursive: true })
  fs.writeFileSync(saved.filePath, Buffer.from('mp4-bytes'))
  await history.recordSaved({
    tweetInfo: tweetInfo(),
    media: mediaItem('m9'),
    saved,
    probe: { path: saved.filePath, width: 160, height: 120, durationSec: 0.6, frameCount: 18, fps: 30, frameDurationsMs: [30], hasAudio: false, sizeBytes: 9 },
  })

  const removed = await history.remove(TWEET_ID, { deleteFiles: true })
  assert.ok(removed.deletedFiles >= 1, '应至少删除 1 个媒体文件')
  assert.equal(fs.existsSync(saved.filePath), false, '媒体文件应被删除')
  assert.equal(await history.get(TWEET_ID), null, '历史记录应被移除')
})

test('remove：默认保留文件', async () => {
  const saved = savedItem({
    id: TWEET_ID + ':m10:mp4',
    mediaId: 'm10',
    filePath: path.join(dataDir, 'gifs', 'tester', TWEET_ID, 'keep.mp4'),
  })
  fs.mkdirSync(path.dirname(saved.filePath), { recursive: true })
  fs.writeFileSync(saved.filePath, Buffer.from('keep-me'))
  await history.recordSaved({
    tweetInfo: tweetInfo(),
    media: mediaItem('m10'),
    saved,
    probe: { path: saved.filePath, width: 160, height: 120, durationSec: 0.6, frameCount: 18, fps: 30, frameDurationsMs: [30], hasAudio: false, sizeBytes: 7 },
  })

  await history.remove(TWEET_ID)
  assert.equal(fs.existsSync(saved.filePath), true, '不传 deleteFiles 时应保留文件')
  assert.equal(await history.get(TWEET_ID), null)
})
