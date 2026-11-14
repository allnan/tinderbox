'use strict'

/** gif.cjs 纯函数：延时分配、名义帧率、抽帧参数、输出命名（不依赖外部工具） */

const test = require('node:test')
const assert = require('node:assert/strict')

const helpers = require('./helpers.cjs')
const gif = require(helpers.libPath('gif.cjs'))

test('computeDelaysCs：30/40ms 交替 → 3/4cs', () => {
  const delays = gif.computeDelaysCs([30, 40, 30, 40])
  assert.deepEqual(delays, [3, 4, 3, 4])
  assert.equal(delays.reduce((sum, cs) => sum + cs, 0) * 10, 140)
})

test('computeDelaysCs：66.67ms（15fps）累计分配不漂移', () => {
  const durations = new Array(39).fill(1000 / 15)
  const delays = gif.computeDelaysCs(durations)
  assert.equal(delays.length, 39)
  assert.ok(delays.every((cs) => cs === 6 || cs === 7), '15fps 应为 6/7cs 交替')
  const totalMs = delays.reduce((sum, cs) => sum + cs, 0) * 10
  assert.ok(Math.abs(totalMs - 2600) <= 10, '总时长应约为 2600ms，实际 ' + totalMs)
})

test('computeDelaysCs：小于 20ms 的帧被夹到最小 2cs', () => {
  assert.deepEqual(gif.computeDelaysCs([5, 5, 5]), [2, 2, 2])
  assert.equal(gif.MIN_DELAY_CS, 2)
})

test('computeDelaysCs：speed 直接作用于延时', () => {
  assert.deepEqual(gif.computeDelaysCs([100, 100], { speed: 2 }), [5, 5])
  assert.deepEqual(gif.computeDelaysCs([100, 100], { speed: 0.5 }), [20, 20])
})

test('computeNominalFps：夹在 1-100 且保留 3 位小数', () => {
  assert.equal(gif.computeNominalFps(1000 / 28.125), 28.125)
  assert.equal(gif.computeNominalFps(5), 100)
  assert.equal(gif.computeNominalFps(100), 10)
  assert.ok(gif.computeNominalFps(0) > 0)
})

test('groupDurations：抽帧数量少于源帧数时按时间合并', () => {
  assert.deepEqual(gif.groupDurations([30, 40, 30, 40], 2), [70, 70])
  assert.deepEqual(gif.groupDurations([30, 40, 30, 40], 4), [30, 40, 30, 40])
  const merged = gif.groupDurations([10, 10, 10, 10, 10], 3)
  assert.equal(merged.length, 3)
  assert.equal(merged.reduce((sum, value) => sum + value, 0), 50)
})

test('buildExtractArgs：fps=source 使用 passthrough 且不重采样', () => {
  const args = gif.buildExtractArgs({ inputPath: 'in.mp4', framesDir: 'frames', fps: 'source', targetWidth: 720, sourceWidth: 720 })
  assert.ok(args.includes('-fps_mode'))
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'passthrough')
  assert.ok(!args.includes('-vf'), '无缩放时不应生成 -vf')
  assert.ok(args[args.length - 1].endsWith('%06d.png'))
})

test('buildExtractArgs：fps=source + 缩放 → scale 滤镜与 passthrough 并存', () => {
  const args = gif.buildExtractArgs({ inputPath: 'in.mp4', framesDir: 'frames', fps: 'source', targetWidth: 480, sourceWidth: 720 })
  const vfIndex = args.indexOf('-vf')
  assert.ok(vfIndex >= 0)
  assert.equal(args[vfIndex + 1], 'scale=480:-2:flags=lanczos')
  assert.ok(args.includes('-fps_mode'))
})

test('buildExtractArgs：数字 fps → fps 滤镜 + scale 滤镜', () => {
  const args = gif.buildExtractArgs({ inputPath: 'in.mp4', framesDir: 'frames', fps: 15, targetWidth: 360, sourceWidth: 720 })
  const vfIndex = args.indexOf('-vf')
  assert.equal(args[vfIndex + 1], 'fps=15,scale=360:-2:flags=lanczos')
  assert.ok(!args.includes('-fps_mode'))
})

test('buildOutputFileName：命名规则与安全文件名', () => {
  const date = new Date(2026, 10, 11, 12, 34, 56)
  const name = gif.buildOutputFileName({
    screenName: 'hardestgifs',
    tweetId: '2116630142135275663',
    mediaIndex: 2,
    width: 480,
    height: 480,
    presetId: 'balanced',
    date,
  })
  assert.equal(name, 'hardestgifs_2116630142135275663_2_480x480_balanced_20261111-123456.gif')
  const custom = gif.buildOutputFileName({ screenName: 'a/b:c', tweetId: '1', mediaIndex: 1, width: 64, height: 64, presetId: null, date })
  assert.equal(custom, 'a-b-c_1_1_64x64_custom_20261111-123456.gif')
  assert.doesNotMatch(custom, /[\\/:*?"<>|]/)
  // 动画 WebP 扩展名
  const webpName = gif.buildOutputFileName({
    screenName: 'hardestgifs',
    tweetId: '2116630142135275663',
    mediaIndex: 2,
    width: 480,
    height: 480,
    presetId: 'balanced',
    format: 'webp',
    date,
  })
  assert.equal(webpName, 'hardestgifs_2116630142135275663_2_480x480_balanced_20261111-123456.webp')
})

// ---------------------------------------------------------------------------
// 帧数对齐 / 重新归一（task-9 回归）
// ---------------------------------------------------------------------------

test('alignFrameDurations：目标帧数等于源数组长度时原样返回', () => {
  const durations = [30, 40, 30, 40]
  const aligned = gif.alignFrameDurations(durations, 4, 0.14)
  assert.deepEqual(aligned, durations)
  assert.notEqual(aligned, durations, '应返回副本，避免后续修改污染源数据')
})

test('alignFrameDurations：目标帧数更少时按时间比例合并且总时长不变', () => {
  const durations = []
  for (let index = 0; index < 86; index += 1) durations.push(index % 2 === 0 ? 30 : 40)
  const sourceTotal = durations.reduce((sum, value) => sum + value, 0)
  const aligned = gif.alignFrameDurations(durations, 84, sourceTotal / 1000)
  assert.equal(aligned.length, 84)
  const alignedTotal = aligned.reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(alignedTotal - sourceTotal) < 0.001, '合并后总时长应不变')
})

test('alignFrameDurations：目标帧数更多时按源总时长均匀分配，总时长不漂移', () => {
  const durations = Array.from({ length: 84 }, (_, index) => (index % 2 === 0 ? 30 : 40))
  const sourceTotal = durations.reduce((sum, value) => sum + value, 0)
  const aligned = gif.alignFrameDurations(durations, 86, sourceTotal / 1000)
  assert.equal(aligned.length, 86)
  const alignedTotal = aligned.reduce((sum, value) => sum + value, 0)
  assert.ok(Math.abs(alignedTotal - sourceTotal) <= 5, '目标更多时应按总时长均匀分配，实际 ' + alignedTotal)
})

test('alignFrameDurations：无源时长时用总时长均匀分配', () => {
  const aligned = gif.alignFrameDurations([], 10, 1.2)
  assert.equal(aligned.length, 10)
  assert.ok(aligned.every((value) => Math.abs(value - 120) < 0.001))
})

test('resolveDelaysForFrames：编码后 84 帧（源 86 帧）时总时长对齐', () => {
  const durations = Array.from({ length: 86 }, (_, index) => (index % 2 === 0 ? 30 : 40))
  const sourceTotal = durations.reduce((sum, value) => sum + value, 0)
  const sourceProbe = { frameCount: 86, frameDurationsMs: durations, durationSec: sourceTotal / 1000 }
  const plan = gif.resolveDelaysForFrames(sourceProbe, 84, { fps: 'source', preserveTiming: true, speed: 1 })
  assert.equal(plan.delaysCs.length, 84)
  assert.equal(plan.aligned, true)
  const totalMs = plan.delaysCs.reduce((sum, cs) => sum + cs, 0) * 10
  assert.ok(Math.abs(totalMs - sourceTotal) <= 20, '总时长应接近源 ' + sourceTotal + 'ms，实际 ' + totalMs)
})

test('resolveDelaysForFrames：帧数一致时等价于 computeDelaysCs', () => {
  const durations = [30, 40, 30, 40, 30]
  const sourceProbe = { frameCount: 5, frameDurationsMs: durations, durationSec: 0.17 }
  const plan = gif.resolveDelaysForFrames(sourceProbe, 5, { fps: 'source', preserveTiming: true, speed: 1 })
  assert.deepEqual(plan.delaysCs, gif.computeDelaysCs(durations))
})

test('resolveDelaysForFrames：数字 fps / 不保留时序时按源总时长均匀分配', () => {
  const durations = Array.from({ length: 72 }, () => 35.5)
  const sourceProbe = { frameCount: 72, frameDurationsMs: durations, durationSec: 2.56 }
  const numeric = gif.resolveDelaysForFrames(sourceProbe, 39, { fps: 15, preserveTiming: true, speed: 1 })
  assert.equal(numeric.delaysCs.length, 39)
  const numericTotal = numeric.delaysCs.reduce((sum, cs) => sum + cs, 0) * 10
  assert.ok(Math.abs(numericTotal - 2560) <= 20, '数字 fps 总时长应接近源，实际 ' + numericTotal)

  const noTiming = gif.resolveDelaysForFrames(sourceProbe, 39, { fps: 'source', preserveTiming: false, speed: 1 })
  assert.equal(noTiming.delaysCs.length, 39)
  const noTimingTotal = noTiming.delaysCs.reduce((sum, cs) => sum + cs, 0) * 10
  assert.ok(Math.abs(noTimingTotal - 2560) <= 20)
})
