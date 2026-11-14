'use strict'

/**
 * gif.cjs 集成测试：用 ffmpeg 现场生成的 VFR MP4 夹具跑完整流水线
 * （prepare 缓存 → 探测 → 抽帧 → gifski 编码 → 还原逐帧延时 → 探测 → 输出 → 历史）。
 * 数据目录通过 XGIF_DATA_DIR 指向临时目录；缺少 ffmpeg/gifski 时自动跳过。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const helpers = require('./helpers.cjs')

const dataDir = helpers.makeTempDataDir('xgif-pipeline-')
const ffmpeg = helpers.findTool('ffmpeg')
const gifski = helpers.findTool('gifski')
const skip = ffmpeg && gifski ? false : '缺少 ffmpeg 或 gifski 工具'

const gif = require(helpers.libPath('gif.cjs'))
const gifprobe = require(helpers.libPath('gifprobe.cjs'))
const mp4probe = require(helpers.libPath('mp4probe.cjs'))
const tweet = require(helpers.libPath('tweet.cjs'))
const history = require(helpers.libPath('history.cjs'))
const jobs = require(helpers.libPath('jobs.cjs'))
const { DEFAULT_PARAMS } = require(helpers.libPath('defaults.cjs'))

const TWEET_ID = 'fixture-tweet'
const MEDIA_ID = 'fixture-1'
const fixtureDir = path.join(dataDir, 'fixtures')
const cacheMediaDir = path.join(dataDir, 'cache', 'media')

const mediaItem = {
  id: MEDIA_ID,
  kind: 'gif',
  sourceUrl: 'https://example.com/fixture.mp4',
  thumbnailUrl: null,
  width: 160,
  height: 120,
  durationSec: null,
  variants: [],
}

let fixturePath = null

function ensureFixture() {
  if (fixturePath) return fixturePath
  const built = helpers.makeVfrMp4({ ffmpeg, dir: fixtureDir, frameCount: 18 })
  fs.mkdirSync(cacheMediaDir, { recursive: true })
  fixturePath = path.join(cacheMediaDir, MEDIA_ID + '.mp4')
  fs.copyFileSync(built.filePath, fixturePath)
  // 输出目录按 screenName 分组；没有真实推文缓存时用 x 兜底，这里注入一条缓存保证目录可预期
  tweet.rememberTweet({
    id: TWEET_ID,
    url: 'https://x.com/tester/status/' + TWEET_ID,
    author: { name: '测试作者', screenName: 'tester', avatarUrl: null, verified: false },
    text: '测试推文',
    createdAt: null,
    media: [mediaItem],
    source: 'fxtwitter',
    fetchedAt: new Date().toISOString(),
  })
  return fixturePath
}

function countGifFiles() {
  // 产品升级后输出目录为 <userData>/media
  const dir = path.join(dataDir, 'media')
  let count = 0
  function walk(current) {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.gif$/i.test(entry.name)) count += 1
    }
  }
  walk(dir)
  return count
}

function baseParams(overrides = {}) {
  return { ...DEFAULT_PARAMS, ...overrides }
}

test.after(() => helpers.removeTempDir(dataDir))

test('source 预设：帧数与源一致、30/40ms 延时还原、文件名/目录/历史正确', { skip }, async () => {
  ensureFixture()
  const result = await gif.convert({ jobId: 'pipe-source', tweetId: TWEET_ID, media: mediaItem, params: baseParams(), presetId: 'source' })

  assert.equal(result.info.frameCount, 18)
  assert.equal(result.info.width, 160)
  assert.equal(result.info.height, 120)
  assert.equal(result.presetId, 'source')
  assert.equal(result.sourceProbe.frameCount, 18)
  const delays = result.info.frameDelaysMs
  assert.deepEqual(delays.slice(0, 16), [30, 40, 30, 40, 30, 40, 30, 40, 30, 40, 30, 40, 30, 40, 30, 40])
  assert.equal(delays.reduce((sum, value) => sum + value, 0), 600)
  assert.ok(Math.abs(result.info.durationSec * 1000 - result.sourceProbe.durationSec * 1000) <= 20, '总时长误差应 ≤20ms')

  assert.ok(fs.existsSync(result.gifPath))
  assert.ok(result.info.sizeBytes > 0)
  const expectedDir = path.join(dataDir, 'media', 'tester', TWEET_ID)
  assert.equal(path.dirname(result.gifPath), expectedDir)
  assert.match(path.basename(result.gifPath), /^tester_fixture-tweet_1_160x120_source_\d{8}-\d{6}(-\d+)?\.gif$/)

  const probed = await gifprobe.probe(result.gifPath)
  assert.equal(probed.frameCount, 18)
  assert.equal(probed.loopCount, 0)
  assert.deepEqual(probed.frameDelaysMs, result.info.frameDelaysMs)

  const info = await gif.info(result.gifPath)
  assert.equal(info.path, path.resolve(result.gifPath))
  assert.equal(info.frameCount, 18)
  assert.deepEqual(info.frameDelaysMs, result.info.frameDelaysMs)

  const entries = await history.list()
  const entry = entries.find((item) => item.id === TWEET_ID)
  assert.ok(entry, '应写入历史')
  assert.equal(entry.author.screenName, 'tester')
  assert.ok(entry.results.some((item) => item.gifPath === result.gifPath))
})

test('数字 fps：按累计时间分配延时，总时长不漂移', { skip }, async () => {
  ensureFixture()
  const probe = await mp4probe.probe(fixturePath)
  const result = await gif.convert({ jobId: 'pipe-fps10', tweetId: TWEET_ID, media: mediaItem, params: baseParams({ fps: 10 }), presetId: null })
  const expectedFrames = Math.round(probe.durationSec * 10)
  assert.equal(result.info.frameCount, expectedFrames)
  const totalMs = result.info.frameDelaysMs.reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(totalMs - probe.durationSec * 1000) <= 20, '总时长应接近源时长，实际 ' + totalMs)
  assert.ok(result.info.frameDelaysMs.every((value) => value >= 20), '每帧延时不得小于 2cs')
})

test('宽度限制：启用 lanczos 缩放并输出目标宽度', { skip }, async () => {
  ensureFixture()
  const result = await gif.convert({ jobId: 'pipe-width80', tweetId: TWEET_ID, media: mediaItem, params: baseParams({ width: 80 }), presetId: null })
  assert.equal(result.info.width, 80)
  assert.equal(result.info.height, 60)
  assert.equal(result.info.frameCount, 18)
})

test('循环次数：loopCount=2 写入 NETSCAPE 扩展', { skip }, async () => {
  ensureFixture()
  const result = await gif.convert({ jobId: 'pipe-loop2', tweetId: TWEET_ID, media: mediaItem, params: baseParams({ width: 80, loopCount: 2 }), presetId: null })
  const probed = await gifprobe.probe(result.gifPath)
  assert.equal(probed.loopCount, 2)
})

test('速度：speed=2 时延时减半（受最小 2cs 约束）', { skip }, async () => {
  ensureFixture()
  const result = await gif.convert({ jobId: 'pipe-speed2', tweetId: TWEET_ID, media: mediaItem, params: baseParams({ width: 80, speed: 2 }), presetId: null })
  assert.equal(result.info.frameCount, 18)
  assert.ok(result.info.frameDelaysMs.every((value) => value === 20), '30/40ms 除以 2 后均受限于最小 2cs')
})

test('ffmpeg 两遍调色板编码路径可用（备选编码器）', { skip }, async () => {
  ensureFixture()
  const result = await gif.convert({
    jobId: 'pipe-ffmpeg',
    tweetId: TWEET_ID,
    media: mediaItem,
    params: baseParams({ encoder: 'ffmpeg', width: 80, colors: 64, dither: 'bayer' }),
    presetId: null,
  })
  assert.equal(result.info.frameCount, 18)
  assert.equal(result.info.width, 80)
  assert.deepEqual(result.info.frameDelaysMs.slice(0, 4), [30, 40, 30, 40])
})

test('取消：jobs.cancel 在抽帧阶段终止任务并返回 CANCELLED', { skip }, async () => {
  ensureFixture()
  const jobId = 'pipe-cancel-' + Date.now()
  const before = countGifFiles()
  await assert.rejects(
    () =>
      gif.convert({
        jobId,
        tweetId: TWEET_ID,
        media: mediaItem,
        params: baseParams(),
        presetId: 'source',
        onProgress: (progress) => {
          if (progress.phase === 'extract' && progress.percent >= 8) jobs.cancel(jobId)
        },
      }),
    (error) => {
      assert.equal(error.code, 'CANCELLED')
      return true
    },
  )
  assert.equal(countGifFiles(), before, '取消后不应留下输出 GIF')
})

// ---------------------------------------------------------------------------
// task-9 回归：编码器实际输出帧数少于抽帧数时，自动按时间比例重新归一延时而不是失败
// ---------------------------------------------------------------------------

test('回归：编码器帧数少于抽帧数时自动重新归一延时', { skip }, async () => {
  ensureFixture()

  // 1) 用真实 ffmpeg 抽 18 帧，再用 gifski 只编码前 10 帧，作为「编码器少帧」的替身文件
  const framesDir = path.join(dataDir, 'regression-frames')
  fs.rmSync(framesDir, { recursive: true, force: true })
  fs.mkdirSync(framesDir, { recursive: true })
  const extractArgs = gif.buildExtractArgs({ inputPath: fixturePath, framesDir, fps: 'source', targetWidth: 160, sourceWidth: 160 })
  const extractResult = helpers.runBin(ffmpeg, extractArgs)
  assert.equal(extractResult.status, 0, '抽帧失败：' + String(extractResult.stderr || '').slice(-300))
  const pngFiles = fs.readdirSync(framesDir).filter((name) => name.endsWith('.png')).sort()
  assert.ok(pngFiles.length >= 12, '夹具抽帧数量不足')

  const smallGif = path.join(dataDir, 'regression-small.gif')
  const encodeResult = helpers.runBin(gifski, ['-o', smallGif, '--fps', '28', '--quality', '80', ...pngFiles.slice(0, 10)], { cwd: framesDir })
  assert.equal(encodeResult.status, 0, 'gifski 编码失败：' + String(encodeResult.stderr || '').slice(-300))

  const realProbe = gifprobe.probe
  const realPatchDelays = gifprobe.patchDelays
  const smallInfo = await realProbe(smallGif)
  assert.equal(smallInfo.frameCount, 10)

  // 2) 用替身文件模拟「编码器少帧」：gif.cjs 探测 encoded.gif 时报告 10 帧
  const captured = []
  let fakeProbeCalls = 0
  const fakeProbe = async (filePath) => {
    const name = String(filePath)
    if (name.endsWith('encoded.gif') || name.endsWith('delayed.gif')) {
      fakeProbeCalls += 1
      const delaysCs = captured.length > 0 ? captured[captured.length - 1].delays : smallInfo.frameDelaysCs
      return {
        ...smallInfo,
        path: name,
        sizeBytes: 1,
        frameCount: delaysCs.length,
        frameDelaysCs: delaysCs.slice(),
        frameDelaysMs: delaysCs.map((cs) => cs * 10),
        durationSec: Math.round((delaysCs.reduce((sum, cs) => sum + cs, 0) / 100) * 1000) / 1000,
        fps: 0,
      }
    }
    return realProbe(filePath)
  }
  const fakePatchDelays = async (srcPath, dstPath, delays, options) => {
    captured.push({ srcPath: String(srcPath), delays: delays.slice(), options })
    fs.copyFileSync(smallGif, dstPath)
    return {
      frameCount: delays.length,
      delayCs: delays.slice(),
      durationMs: delays.reduce((sum, cs) => sum + cs, 0) * 10,
      loopCount: options && options.loopCount,
    }
  }

  const progressMessages = []
  try {
    gifprobe.probe = fakeProbe
    gifprobe.patchDelays = fakePatchDelays
    const result = await gif.convert({
      jobId: 'regress-encoded-frames-' + Date.now(),
      tweetId: TWEET_ID,
      media: mediaItem,
      params: baseParams(),
      presetId: 'source',
      onProgress: (progress) => progressMessages.push(progress.message || ''),
    })

    assert.ok(fakeProbeCalls >= 2, '应分别探测 encoded.gif 与 delayed.gif')
    assert.equal(captured.length, 1, '应只调用一次 patchDelays（已按实际帧数归一）')
    assert.equal(captured[0].delays.length, 10, '延时数量应等于编码器实际帧数')
    const delaysTotalMs = captured[0].delays.reduce((sum, cs) => sum + cs, 0) * 10
    assert.ok(delaysTotalMs >= 560 && delaysTotalMs <= 620, '总时长应接近源 590ms，实际 ' + delaysTotalMs)
    assert.ok(progressMessages.join('|').includes('编码器帧数 10'), '应提示编码器帧数不一致并自动处理')
    assert.ok(progressMessages.join('|').includes('不一致'))
    assert.equal(result.info.frameCount, 10)
    assert.ok(Math.abs(result.info.durationSec * 1000 - 590) <= 20, '输出时长应与源一致，实际 ' + result.info.durationSec * 1000)
    assert.ok(fs.existsSync(result.gifPath), '应正常输出 GIF')
  } finally {
    gifprobe.probe = realProbe
    gifprobe.patchDelays = realPatchDelays
  }
})

// ---------------------------------------------------------------------------
// task-10：autoSave（转换前自动保存源媒体）与 sourceSaved
// ---------------------------------------------------------------------------

test('autoSave：转换前自动保存源媒体，history 同时有 savedMedia 与 results，且幂等', { skip }, async () => {
  ensureFixture()
  const autoTweetId = 'autosave-tweet'
  const autoMediaId = 'fixture-auto'
  const autoMedia = {
    id: autoMediaId,
    kind: 'gif',
    sourceUrl: 'https://example.com/auto.mp4',
    thumbnailUrl: null,
    width: 160,
    height: 120,
    durationSec: null,
    variants: [],
  }
  const autoCachePath = path.join(cacheMediaDir, autoMediaId + '.mp4')
  fs.copyFileSync(fixturePath, autoCachePath)
  tweet.rememberTweet({
    id: autoTweetId,
    url: 'https://x.com/tester/status/' + autoTweetId,
    author: { name: '测试作者', screenName: 'tester', avatarUrl: null, verified: false },
    text: '自动保存测试',
    createdAt: null,
    media: [autoMedia],
    source: 'fxtwitter',
    fetchedAt: new Date().toISOString(),
  })

  // 如果转换过程中发生任何网络请求，说明没有复用已保存媒体
  const network = require(helpers.libPath('network.cjs'))
  const realNetworkFetch = network.fetch
  const networkCalls = []
  network.fetch = async (url) => {
    networkCalls.push(String(url))
    throw new Error('autoSave 路径不应发起网络请求（应复用缓存/已保存文件）')
  }

  try {
    const params = baseParams({ width: 80 })
    const first = await gif.convert({ jobId: 'autosave-1', tweetId: autoTweetId, media: autoMedia, params, presetId: 'source', autoSave: true })
    assert.ok(first.sourceSaved, '首次 autoSave 转换应返回 sourceSaved')
    assert.equal(first.sourceSaved.id, autoTweetId + ':' + autoMediaId + ':mp4')
    assert.ok(fs.existsSync(first.sourceSaved.filePath), '源媒体文件应已保存')
    assert.ok(fs.existsSync(first.gifPath), 'GIF 应正常输出')

    let entry = (await history.list()).find((item) => item.id === autoTweetId)
    assert.ok(entry, '应写入历史分组')
    assert.equal(entry.savedMedia.length, 1, '历史中应有 1 条 savedMedia')
    assert.equal(entry.savedMedia[0].id, first.sourceSaved.id)
    assert.equal(entry.results.length, 1, '历史中应有 1 条 GIF 结果')

    // 第二次 autoSave：幂等，不新增 savedMedia 记录
    const second = await gif.convert({ jobId: 'autosave-2', tweetId: autoTweetId, media: autoMedia, params, presetId: 'source', autoSave: true })
    assert.equal(second.sourceSaved.id, first.sourceSaved.id)
    entry = (await history.list()).find((item) => item.id === autoTweetId)
    assert.equal(entry.savedMedia.length, 1, '重复 autoSave 不应新增记录')
    assert.equal(entry.results.length, 2, '第二次转换应新增 1 条 GIF 结果')

    // 第三次 autoSave=false：已保存时也应返回 sourceSaved
    const third = await gif.convert({ jobId: 'autosave-3', tweetId: autoTweetId, media: autoMedia, params, presetId: 'source', autoSave: false })
    assert.ok(third.sourceSaved, '已保存媒体在非 autoSave 转换时也应返回 sourceSaved')
    assert.equal(third.sourceSaved.id, first.sourceSaved.id)

    assert.deepEqual(networkCalls, [], 'autoSave/已保存路径不应发起网络请求')
  } finally {
    network.fetch = realNetworkFetch
  }
})

test('autoSave：未解析推文（无缓存）时返回可展示的 TWEET_NOT_FOUND 错误', { skip }, async () => {
  ensureFixture()
  const mediaItem = {
    id: 'nofetch-media',
    kind: 'gif',
    sourceUrl: 'https://example.com/nofetch.mp4',
    thumbnailUrl: null,
    width: 160,
    height: 120,
    durationSec: null,
    variants: [],
  }
  await assert.rejects(
    () =>
      gif.convert({ jobId: 'autosave-nofetch', tweetId: 'unknown-tweet', media: mediaItem, params: baseParams({ width: 80 }), presetId: 'source', autoSave: true }),
    (error) => {
      assert.equal(error.code, 'TWEET_NOT_FOUND')
      assert.match(error.message, /请先解析推文/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// task-38：动画 WebP 输出分支
// ---------------------------------------------------------------------------

test('format=webp：输出动画 WebP，帧数/逐帧延时与 GIF 一致', { skip }, async () => {
  ensureFixture()
  const webpModule = require(helpers.libPath('webp.cjs'))
  const params = baseParams({ width: 160 })
  const gifResult = await gif.convert({ jobId: 'webp-gif-ref', tweetId: TWEET_ID, media: mediaItem, params, presetId: 'source' })
  const webpResult = await gif.convert({ jobId: 'webp-convert', tweetId: TWEET_ID, media: mediaItem, params, presetId: 'source', format: 'webp' })

  assert.equal(webpResult.format, 'webp')
  assert.match(webpResult.gifPath, /\.webp$/)
  assert.ok(fs.existsSync(webpResult.gifPath), 'WebP 文件应存在')
  assert.equal(webpResult.info.frameCount, 18)
  assert.ok(Math.abs(webpResult.info.durationSec * 1000 - 600) <= 50, '时长应约 600ms，实际 ' + webpResult.info.durationSec * 1000)
  assert.deepEqual(webpResult.info.frameDelaysMs, gifResult.info.frameDelaysMs, 'WebP 逐帧延时应与 GIF 完全一致')

  const probed = await webpModule.probe(webpResult.gifPath)
  assert.equal(probed.animated, true)
  assert.equal(probed.frameCount, 18)
  assert.equal(probed.loopCount, 0)
  assert.deepEqual(probed.frameDelaysMs, gifResult.info.frameDelaysMs)
  assert.equal(probed.width, 160)
  assert.equal(probed.height, 120)

  const info = await gif.info(webpResult.gifPath)
  assert.equal(info.frameCount, 18)
  assert.deepEqual(info.frameDelaysMs, gifResult.info.frameDelaysMs)
  assert.equal(info.fileName.endsWith('.webp'), true)
})

test('format=webp：loopCount 映射到 WebP ANIM 循环次数', { skip }, async () => {
  ensureFixture()
  const webpModule = require(helpers.libPath('webp.cjs'))
  const params = baseParams({ width: 160 })
  for (const [loopCount, expected] of [[0, 0], [3, 3], [-1, 1]]) {
    const result = await gif.convert({ jobId: 'webp-loop-' + loopCount, tweetId: TWEET_ID, media: mediaItem, params: { ...params, loopCount }, presetId: null, format: 'webp' })
    const probed = await webpModule.probe(result.gifPath)
    assert.equal(probed.loopCount, expected, 'loopCount=' + loopCount + ' 应映射为 ' + expected)
  }
})

test('format 非法值在开始转换前抛出中文错误', async () => {
  await assert.rejects(
    () => gif.convert({ jobId: 'bad-format', tweetId: TWEET_ID, media: mediaItem, params: baseParams(), presetId: null, format: 'mp4' }),
    (error) => {
      assert.equal(error.code, 'CONVERT_FAILED')
      assert.match(error.message, /不支持的输出格式/)
      assert.match(error.message, /gif \/ webp/)
      return true
    },
  )
})
