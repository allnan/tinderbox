'use strict'

/** mp4probe：纯 JS MP4 解析（VFR stts、宽高、音轨、错误处理） */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const helpers = require('./helpers.cjs')
const mp4probe = require(helpers.libPath('mp4probe.cjs'))

const ffmpeg = helpers.findTool('ffmpeg')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgif-mp4probe-'))
const skip = ffmpeg ? false : '缺少 ffmpeg 工具（tools/bin 或 PATH）'
let vfrFixture = null

function fixture() {
  if (!vfrFixture) vfrFixture = helpers.makeVfrMp4({ ffmpeg, dir: tempDir, frameCount: 18 })
  return vfrFixture
}

test.after(() => helpers.removeTempDir(tempDir))

test('probe 解析 VFR MP4：宽高/帧数/逐帧时长（30/40ms 交替）', { skip }, async () => {
  const { filePath, frameCount, expectedDurationsMs } = fixture()
  const probe = await mp4probe.probe(filePath)
  assert.equal(probe.width, 160)
  assert.equal(probe.height, 120)
  assert.equal(probe.frameCount, frameCount)
  assert.equal(probe.frameDurationsMs.length, frameCount)
  assert.equal(probe.frameDurationsMs.length, probe.frameCount, '内部不变量：帧数必须等于逐帧时长数组长度')
  assert.deepEqual(probe.warnings, [], '正常样本不应产生告警')
  assert.deepEqual(probe.frameDurationsMs.slice(0, 16), expectedDurationsMs.slice(0, 16))
  const totalMs = probe.frameDurationsMs.reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(totalMs - 590) <= 5, '逐帧时长总和应约等于 590ms，实际 ' + totalMs)
  assert.ok(probe.durationSec > 0.55 && probe.durationSec < 0.65)
  assert.ok(probe.fps > 28 && probe.fps < 33)
  assert.equal(probe.hasAudio, false)
  assert.ok(probe.sizeBytes > 1000)
  assert.equal(probe.path, filePath)
})

test('probeBuffer 与 probe 结果一致', { skip }, async () => {
  const { filePath } = fixture()
  const fromFile = await mp4probe.probe(filePath)
  const fromBuffer = mp4probe.probeBuffer(fs.readFileSync(filePath))
  assert.equal(fromBuffer.width, fromFile.width)
  assert.equal(fromBuffer.height, fromFile.height)
  assert.equal(fromBuffer.frameCount, fromFile.frameCount)
  assert.equal(fromBuffer.frameCount, fromBuffer.frameDurationsMs.length)
  assert.deepEqual(fromBuffer.frameDurationsMs, fromFile.frameDurationsMs)
  assert.equal(fromBuffer.hasAudio, fromFile.hasAudio)
})

test('probe 能识别音轨', { skip }, async () => {
  const avPath = helpers.makeAvMp4({ ffmpeg, dir: tempDir })
  const probe = await mp4probe.probe(avPath)
  assert.equal(probe.hasAudio, true)
  assert.equal(probe.width, 96)
  assert.equal(probe.height, 64)
  assert.ok(probe.frameCount > 0)
})

test('probe 对无效文件抛出中文可展示错误（PROBE_FAILED）', async () => {
  const bogus = path.join(tempDir, 'bogus.mp4')
  fs.mkdirSync(tempDir, { recursive: true })
  fs.writeFileSync(bogus, Buffer.from('this is definitely not an mp4 file'))
  await assert.rejects(() => mp4probe.probe(bogus), (error) => {
    assert.equal(error.code, 'PROBE_FAILED')
    assert.match(error.message, /无法解析|不是标准|不完整|损坏/)
    return true
  })
  await assert.rejects(() => mp4probe.probe(path.join(tempDir, 'not-exists.mp4')), (error) => {
    assert.equal(error.code, 'PROBE_FAILED')
    assert.match(error.message, /不存在|无法读取/)
    return true
  })
})

// ---------------------------------------------------------------------------
// 帧数一致性回归：stts 与 stsz 不一致时以 stts 时间轴为准（用户实际遇到的 86 vs 84）
// ---------------------------------------------------------------------------

test('probeBuffer：stts 86 条 / stsz 84 个 → frameCount 以 stts 为准且带 warning', () => {
  const buffer = helpers.buildSyntheticMp4({
    width: 320,
    height: 240,
    timescale: 1000,
    sttsEntries: [[40, 40], [46, 40]], // 86 帧
    sampleCount: 84, // 故意少 2 个
    durationUnits: 3440,
  })
  const probe = mp4probe.probeBuffer(buffer)
  assert.equal(probe.frameCount, 86)
  assert.equal(probe.frameDurationsMs.length, 86)
  assert.equal(probe.width, 320)
  assert.equal(probe.height, 240)
  assert.equal(probe.durationSec, 3.44)
  assert.equal(probe.warnings.length, 1)
  assert.match(probe.warnings[0], /86.*84/)
})

test('probeBuffer：stts 84 条 / stsz 86 个 → frameCount 以 stts（84）为准', () => {
  const buffer = helpers.buildSyntheticMp4({
    timescale: 100,
    sttsEntries: [[42, 4], [42, 3]], // 84 帧
    sampleCount: 86,
    durationUnits: 294,
  })
  const probe = mp4probe.probeBuffer(buffer)
  assert.equal(probe.frameCount, 84)
  assert.equal(probe.frameDurationsMs.length, 84)
  assert.equal(probe.warnings.length, 1)
})

test('probeBuffer：stts 与 stsz 一致时不产生 warning', () => {
  const buffer = helpers.buildSyntheticMp4({
    timescale: 100,
    sttsEntries: [[30, 4], [42, 3]], // 72 帧
    sampleCount: 72,
    durationUnits: 246,
  })
  const probe = mp4probe.probeBuffer(buffer)
  assert.equal(probe.frameCount, 72)
  assert.equal(probe.frameDurationsMs.length, 72)
  assert.deepEqual(probe.warnings, [])
})

test('probeBuffer：缺少 stts 时用 stsz 采样数与容器时长补均匀延时', () => {
  const buffer = helpers.buildSyntheticMp4({
    timescale: 1000,
    sttsEntries: [],
    sampleCount: 10,
    durationUnits: 500,
  })
  const probe = mp4probe.probeBuffer(buffer)
  assert.equal(probe.frameCount, 10)
  assert.equal(probe.frameDurationsMs.length, 10)
  assert.ok(probe.frameDurationsMs.every((value) => Math.abs(value - 50) < 0.001))
  assert.equal(probe.durationSec, 0.5)
})

test('probeBuffer：所有返回值都满足 frameCount === frameDurationsMs.length', () => {
  const cases = [
    helpers.buildSyntheticMp4({ sttsEntries: [[1, 30], [1, 40]], sampleCount: 2 }),
    helpers.buildSyntheticMp4({ sttsEntries: [[5, 33.3]], sampleCount: 5 }),
    helpers.buildSyntheticMp4({ sttsEntries: [], sampleCount: 7, durationUnits: 700 }),
    helpers.buildSyntheticMp4({ sttsEntries: [[3, 10]], sampleCount: 99 }),
  ]
  for (const buffer of cases) {
    const probe = mp4probe.probeBuffer(buffer)
    assert.equal(probe.frameCount, probe.frameDurationsMs.length)
    assert.ok(Array.isArray(probe.warnings))
  }
})
