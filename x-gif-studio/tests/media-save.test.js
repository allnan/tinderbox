'use strict'

/**
 * media.cjs#save：原始媒体保存（视频/GIF 的 mp4、图片）、命名/去重/历史写入，
 * 以及图片格式识别与尺寸解析的纯函数测试。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const helpers = require('./helpers.cjs')

const dataDir = helpers.makeTempDataDir('xgif-save-')
const media = require(helpers.libPath('media.cjs'))
const tweet = require(helpers.libPath('tweet.cjs'))
const history = require(helpers.libPath('history.cjs'))
const network = require(helpers.libPath('network.cjs'))

const realFetch = network.fetch

function restoreFetch() {
  network.fetch = realFetch
}

/** 用网络桩返回一个图片响应（图片保存路径需要下载） */
function stubImageFetch(buffer, headers = {}) {
  const calls = []
  network.fetch = async (url) => {
    calls.push(String(url))
    return new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(buffer.length), ...headers },
    })
  }
  return calls
}

function stubMp4Fetch(buffer) {
  const calls = []
  network.fetch = async (url) => {
    calls.push(String(url))
    return new Response(buffer, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': String(buffer.length) },
    })
  }
  return calls
}

function rememberTweet(tweetId, mediaItems) {
  tweet.rememberTweet({
    id: tweetId,
    url: 'https://x.com/tester/status/' + tweetId,
    author: { name: 'Tester', screenName: 'tester', avatarUrl: null, verified: false },
    text: '保存测试',
    createdAt: null,
    media: mediaItems,
    source: 'fxtwitter',
    fetchedAt: new Date().toISOString(),
  })
}

function outputDir() {
  // 产品升级后输出目录为 <userData>/media（paths.outputDir）
  return path.join(dataDir, 'media')
}

test.after(() => {
  restoreFetch()
  helpers.removeTempDir(dataDir)
})

// ---------------------------------------------------------------------------
// 纯函数：图片格式识别 / 尺寸解析
// ---------------------------------------------------------------------------

test('detectImageFormat：按魔数识别 jpg/png/gif/webp', () => {
  assert.equal(media.detectImageFormat(helpers.buildTestImage('jpg')), 'jpg')
  assert.equal(media.detectImageFormat(helpers.buildTestImage('png')), 'png')
  assert.equal(media.detectImageFormat(helpers.buildTestImage('gif')), 'gif')
  assert.equal(media.detectImageFormat(helpers.buildTestImage('webp')), 'webp')
  assert.equal(media.detectImageFormat(Buffer.from('not an image at all')), null)
  assert.equal(media.detectImageFormat(Buffer.alloc(0)), null)
})

test('parseImageDimensions：解析各格式宽高，损坏数据返回 null 而不抛错', () => {
  assert.deepEqual(media.parseImageDimensions(helpers.buildTestImage('jpg', { width: 640, height: 480 }), 'jpg'), { width: 640, height: 480 })
  assert.deepEqual(media.parseImageDimensions(helpers.buildTestImage('png', { width: 320, height: 200 }), 'png'), { width: 320, height: 200 })
  assert.deepEqual(media.parseImageDimensions(helpers.buildTestImage('gif', { width: 120, height: 90 }), 'gif'), { width: 120, height: 90 })
  assert.deepEqual(media.parseImageDimensions(helpers.buildTestImage('webp', { width: 800, height: 600 }), 'webp'), { width: 800, height: 600 })
  assert.deepEqual(media.parseImageDimensions(Buffer.from('broken'), 'jpg'), { width: null, height: null })
  assert.deepEqual(media.parseImageDimensions(Buffer.alloc(0), 'png'), { width: null, height: null })
})

test('buildSaveFileName：作者/推文/序号/尺寸安全命名', () => {
  assert.equal(
    media.buildSaveFileName({ screenName: 'tester', tweetId: '123', mediaIndex: 2, width: 160, height: 120, ext: 'mp4' }),
    'tester_123_2_160x120.mp4',
  )
  assert.equal(
    media.buildSaveFileName({ screenName: 'a/b:c', tweetId: '123', mediaIndex: 1, width: null, height: null, ext: 'jpg' }),
    'a-b-c_123_1_media.jpg',
  )
})

// ---------------------------------------------------------------------------
// 视频/GIF（mp4）保存
// ---------------------------------------------------------------------------

test('media.save：视频/GIF 保存到输出目录、写历史，重复保存幂等', async () => {
  const tweetId = '1900000000000000002'
  const mediaItem = {
    id: 'v1',
    kind: 'gif',
    sourceUrl: 'https://video.twimg.com/tweet_video/v1.mp4',
    thumbnailUrl: null,
    width: 160,
    height: 120,
    durationSec: 0.63,
    variants: [],
  }
  rememberTweet(tweetId, [mediaItem])

  // 预制缓存 mp4（纯 JS 可解析，不依赖 ffmpeg）
  const cacheDir = path.join(dataDir, 'cache', 'media')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cachePath = path.join(cacheDir, 'v1.mp4')
  const mp4Buffer = helpers.buildSyntheticMp4({ width: 160, height: 120, timescale: 1000, sttsEntries: [[9, 30], [9, 40]], sampleCount: 18, durationUnits: 630 })
  fs.writeFileSync(cachePath, mp4Buffer)

  const first = await media.save({ jobId: 'save-v1-1', tweetId, media: mediaItem })
  assert.equal(first.newFile, true)
  assert.equal(first.saved.id, tweetId + ':v1:mp4')
  assert.equal(first.saved.format, 'mp4')
  assert.equal(first.saved.mediaKind, 'gif')
  assert.match(first.saved.fileName, /^tester_1900000000000000002_1_160x120\.mp4$/)
  assert.equal(first.saved.width, 160)
  assert.equal(first.saved.height, 120)
  assert.ok(Math.abs(first.saved.durationSec - 0.63) < 0.01)
  assert.ok(fs.existsSync(first.saved.filePath), '保存文件应存在')
  assert.equal(path.dirname(first.saved.filePath), path.join(outputDir(), 'tester', tweetId))
  assert.equal(fs.readFileSync(first.saved.filePath).equals(mp4Buffer), true, '文件内容应与源 mp4 一致')
  // 保存必须始终 copyFile，保留 cache/media 原始缓存（settings.keepOriginalMp4 语义）
  assert.ok(fs.existsSync(cachePath), '保存后 cache/media 下的原始 mp4 缓存应保留')
  assert.equal(fs.readFileSync(cachePath).equals(mp4Buffer), true, '缓存内容不应被修改')

  const entries = await history.list()
  const entry = entries.find((item) => item.id === tweetId)
  assert.ok(entry, '应写入历史分组')
  assert.equal(entry.savedMedia.length, 1)
  assert.equal(entry.savedMedia[0].id, first.saved.id)
  assert.equal(entry.media[0].localPath, first.saved.filePath)

  // 第二次保存：命中已有记录，不重复写文件
  const second = await media.save({ jobId: 'save-v1-2', tweetId, media: mediaItem })
  assert.equal(second.newFile, false)
  assert.equal(second.saved.filePath, first.saved.filePath)
  assert.ok(fs.existsSync(cachePath), '重复保存后缓存仍应保留')
  const afterSecond = (await history.list()).find((item) => item.id === tweetId)
  assert.equal(afterSecond.savedMedia.length, 1)
})

test('media.save：文件缺失时从保留的缓存补回；缓存也缺失时才重新下载', async () => {
  const tweetId = '1900000000000000004'
  const mediaItem = { id: 'v4', kind: 'video', sourceUrl: 'https://video.twimg.com/tweet_video/v4.mp4', thumbnailUrl: null, width: 160, height: 120, durationSec: 0.63, variants: [] }
  rememberTweet(tweetId, [mediaItem])
  const cacheDir = path.join(dataDir, 'cache', 'media')
  fs.mkdirSync(cacheDir, { recursive: true })
  const cachePath = path.join(cacheDir, 'v4.mp4')
  const mp4Buffer = helpers.buildSyntheticMp4({ width: 160, height: 120, timescale: 1000, sttsEntries: [[18, 35]], sampleCount: 18, durationUnits: 630 })
  fs.writeFileSync(cachePath, mp4Buffer)

  const first = await media.save({ jobId: 'save-v4-1', tweetId, media: mediaItem })
  assert.equal(first.newFile, true)
  assert.ok(fs.existsSync(cachePath), '保存后缓存应保留')

  const calls = stubMp4Fetch(mp4Buffer)
  try {
    // 输出文件被删除：缓存还在 → 直接从缓存补回，不应发起网络请求
    fs.rmSync(first.saved.filePath, { force: true })
    const restored = await media.save({ jobId: 'save-v4-2', tweetId, media: mediaItem })
    assert.equal(restored.newFile, true)
    assert.equal(restored.saved.filePath, first.saved.filePath)
    assert.ok(fs.existsSync(restored.saved.filePath))
    assert.equal(calls.length, 0, '缓存仍在时应从缓存补回，不重新下载')

    // 缓存与输出都被删除后 force=true：只能重新下载并覆盖同一路径
    fs.rmSync(cachePath, { force: true })
    fs.rmSync(first.saved.filePath, { force: true })
    const forced = await media.save({ jobId: 'save-v4-3', tweetId, media: mediaItem, force: true })
    assert.equal(forced.newFile, true)
    assert.equal(forced.saved.filePath, first.saved.filePath)
    assert.ok(fs.existsSync(forced.saved.filePath))
    assert.equal(fs.existsSync(cachePath), true, '重新下载后缓存也会写入（下次保存可复用）')
    assert.ok(calls.length >= 1, '缓存与输出都缺失时应重新下载')
  } finally {
    restoreFetch()
  }
})

// ---------------------------------------------------------------------------
// 图片保存
// ---------------------------------------------------------------------------

function photoItem(mediaId = 'p1') {
  return {
    id: mediaId,
    kind: 'photo',
    sourceUrl: 'https://pbs.twimg.com/media/' + mediaId + '.jpg?name=orig',
    thumbnailUrl: null,
    width: 640,
    height: 480,
    durationSec: null,
    variants: [],
  }
}

test('media.save：图片按魔数识别格式与尺寸，保存为 jpg 并写历史', async () => {
  const tweetId = '1900000000000000003'
  const mediaItem = photoItem('p1')
  rememberTweet(tweetId, [mediaItem])
  const jpeg = helpers.buildTestImage('jpg', { width: 640, height: 480 })
  const calls = stubImageFetch(jpeg)
  try {
    const result = await media.save({ jobId: 'save-p1', tweetId, media: mediaItem })
    assert.equal(result.newFile, true)
    assert.equal(result.saved.format, 'jpg')
    assert.match(result.saved.fileName, /^tester_1900000000000000003_1_640x480\.jpg$/)
    assert.equal(result.saved.width, 640)
    assert.equal(result.saved.height, 480)
    assert.equal(result.saved.durationSec, null)
    assert.equal(result.saved.mediaKind, 'photo')
    assert.ok(fs.existsSync(result.saved.filePath))
    assert.equal(fs.readFileSync(result.saved.filePath).equals(jpeg), true)
    assert.equal(calls.length, 1)

    const entry = (await history.list()).find((item) => item.id === tweetId)
    assert.equal(entry.savedMedia.length, 1)
    assert.equal(entry.savedMedia[0].format, 'jpg')

    // 幂等：再次保存命中记录，不再发起网络请求
    const again = await media.save({ jobId: 'save-p1-2', tweetId, media: mediaItem })
    assert.equal(again.newFile, false)
    assert.equal(calls.length, 1, '命中历史记录时不应重新下载')
  } finally {
    restoreFetch()
  }
})

test('media.save：同名文件存在但没有历史记录时追加 -2，避免误覆盖', async () => {
  const tweetId = '1900000000000000005'
  const mediaItem = photoItem('p2')
  rememberTweet(tweetId, [mediaItem])
  const tweetDir = path.join(outputDir(), 'tester', tweetId)
  fs.mkdirSync(tweetDir, { recursive: true })
  const existingPath = path.join(tweetDir, 'tester_' + tweetId + '_1_640x480.jpg')
  fs.writeFileSync(existingPath, Buffer.from('existing-file'))

  const jpeg = helpers.buildTestImage('jpg', { width: 640, height: 480 })
  stubImageFetch(jpeg)
  try {
    const result = await media.save({ jobId: 'save-p2', tweetId, media: mediaItem })
    assert.equal(result.newFile, true)
    assert.notEqual(result.saved.filePath, existingPath)
    assert.match(result.saved.fileName, /-2\.jpg$/)
    assert.equal(fs.readFileSync(existingPath, 'utf8'), 'existing-file', '原有同名文件不应被覆盖')
    assert.ok(fs.existsSync(result.saved.filePath))
  } finally {
    restoreFetch()
  }
})

test('media.save：无法识别的图片格式 / HTML 响应 / 超大图片都给出中文错误', async () => {
  const tweetId = '1900000000000000006'
  const mediaItem = photoItem('p3')
  rememberTweet(tweetId, [mediaItem])

  network.fetch = async () => new Response(Buffer.from('this is not an image'), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  try {
    await assert.rejects(() => media.save({ jobId: 'save-p3-1', tweetId, media: mediaItem }), (error) => {
      assert.equal(error.code, 'UNSUPPORTED_MEDIA')
      assert.match(error.message, /无法识别的图片格式/)
      return true
    })
  } finally {
    restoreFetch()
  }

  network.fetch = async () => new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  try {
    await assert.rejects(() => media.save({ jobId: 'save-p3-2', tweetId, media: mediaItem }), (error) => {
      assert.match(error.message, /图片下载被拒绝|不是图片/)
      return true
    })
  } finally {
    restoreFetch()
  }

  const jpeg = helpers.buildTestImage('jpg')
  network.fetch = async () => new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(60 * 1024 * 1024) } })
  try {
    await assert.rejects(() => media.save({ jobId: 'save-p3-3', tweetId, media: mediaItem }), (error) => {
      assert.equal(error.code, 'MEDIA_TOO_LARGE')
      assert.match(error.message, /50MB/)
      return true
    })
  } finally {
    restoreFetch()
  }
})

test('media.save：推文缓存缺失时提示先解析推文（TWEET_NOT_FOUND）', async () => {
  const mediaItem = photoItem('p4')
  await assert.rejects(() => media.save({ jobId: 'save-p4', tweetId: '1900000000000000099', media: mediaItem }), (error) => {
    assert.equal(error.code, 'TWEET_NOT_FOUND')
    assert.match(error.message, /请先解析推文/)
    return true
  })
})
