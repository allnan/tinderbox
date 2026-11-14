'use strict'

/**
 * webp.cjs：动画 WebP 容器解析（RIFF/ANMF）与逐帧时长修补。
 * 用 ffmpeg 现场生成测试帧与动画 WebP（不依赖网络）；缺少 ffmpeg 时跳过。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const helpers = require('./helpers.cjs')
const webp = require(helpers.libPath('webp.cjs'))

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgif-webp-'))
const ffmpeg = helpers.findTool('ffmpeg')
const skip = ffmpeg ? false : '缺少 ffmpeg 工具（tools/bin 或 PATH）'
const framesDir = path.join(tempDir, 'frames')

function runFfmpeg(args, cwd) {
  return helpers.runBin(ffmpeg, args, { cwd, timeoutMs: 120000 })
}

/** 生成 N 帧测试 PNG，并用 concat 列表编码为动画 WebP */
function makeAnimatedWebp({ name = 'anim.webp', frameCount = 4, loopCount = 0, durationPerFrame = 100 } = {}) {
  fs.mkdirSync(framesDir, { recursive: true })
  const rawDir = path.join(tempDir, 'raw-' + name)
  fs.rmSync(rawDir, { recursive: true, force: true })
  fs.mkdirSync(rawDir, { recursive: true })
  const gen = runFfmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=' + (frameCount / 10 + 0.2), '-frames:v', String(frameCount), path.join(rawDir, '%03d.png')])
  assert.equal(gen.status, 0, '生成测试帧失败：' + String(gen.stderr || '').slice(-300))
  const files = fs.readdirSync(rawDir).filter((item) => item.endsWith('.png')).sort()
  const listDir = path.join(tempDir, 'list-' + name)
  fs.rmSync(listDir, { recursive: true, force: true })
  fs.mkdirSync(listDir, { recursive: true })
  const lines = []
  for (const file of files) {
    fs.copyFileSync(path.join(rawDir, file), path.join(listDir, file))
    lines.push("file '" + file + "'")
    lines.push('duration ' + (durationPerFrame / 1000).toFixed(6))
  }
  fs.writeFileSync(path.join(listDir, 'list.txt'), lines.join('\n') + '\n', 'utf8')
  const outPath = path.join(tempDir, name)
  const encode = runFfmpeg(
    ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(listDir, 'list.txt'), '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '80', '-loop', String(loopCount), '-fps_mode', 'passthrough', outPath],
    tempDir,
  )
  assert.equal(encode.status, 0, '编码动画 WebP 失败：' + String(encode.stderr || '').slice(-300))
  return { file: outPath, frameCount: files.length, listDir }
}

test.after(() => helpers.removeTempDir(tempDir))

test('probe：解析动画 WebP 的帧数/宽高/循环次数', { skip }, async () => {
  const { file, frameCount } = makeAnimatedWebp({ name: 'probe-anim.webp', frameCount: 4, loopCount: 5 })
  const info = await webp.probe(file)
  assert.equal(info.format, 'webp')
  assert.equal(info.frameCount, frameCount)
  assert.equal(info.width, 160)
  assert.equal(info.height, 120)
  assert.equal(info.animated, true)
  assert.equal(info.loopCount, 5)
  assert.equal(info.frameDelaysMs.length, frameCount)
  assert.ok(info.durationSec > 0)
  assert.equal(info.sizeBytes, fs.statSync(file).size)
})

test('patchDelays：写入精确毫秒延时并读回校验', { skip }, async () => {
  const { file, frameCount } = makeAnimatedWebp({ name: 'patch-anim.webp', frameCount: 4 })
  const expected = [50, 60, 70, 80]
  assert.equal(expected.length, frameCount)
  const target = path.join(tempDir, 'patched.webp')
  const result = await webp.patchDelays(file, target, expected)
  assert.equal(result.frameCount, frameCount)
  assert.deepEqual(result.frameDelaysMs, expected)
  assert.equal(result.durationSec, 0.26)
  const readback = await webp.probe(target)
  assert.deepEqual(readback.frameDelaysMs, expected)
  assert.deepEqual(readback.frameDelaysMs, result.frameDelaysMs)
})

test('patchDelays：延时数量与帧数不一致时抛中文错误（WEBP_INVALID）', { skip }, async () => {
  const { file } = makeAnimatedWebp({ name: 'mismatch-anim.webp', frameCount: 3 })
  await assert.rejects(() => webp.patchDelays(file, path.join(tempDir, 'bad.webp'), [100, 200]), (error) => {
    assert.equal(error.code, 'WEBP_INVALID')
    assert.match(error.message, /不一致/)
    assert.match(error.message, /重试或更换参数/)
    return true
  })
})

test('probe：静态 WebP 没有动画帧，返回 frameCount=1 且 animated=false', { skip }, async () => {
  const staticPath = path.join(tempDir, 'static.webp')
  const result = runFfmpeg(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=1:duration=1', '-frames:v', '1', '-c:v', 'libwebp', '-q:v', '80', staticPath], tempDir)
  assert.equal(result.status, 0, '编码静态 WebP 失败：' + String(result.stderr || '').slice(-300))
  const info = await webp.probe(staticPath)
  assert.equal(info.animated, false)
  assert.equal(info.frameCount, 1)
  assert.deepEqual(info.frameDelaysMs, [0])
  assert.equal(info.width, 64)
  assert.equal(info.height, 48)
})

test('probe：非 WebP 文件抛出 WEBP_INVALID，缺失文件给出可读错误', async () => {
  const bogus = path.join(tempDir, 'bogus.webp')
  fs.writeFileSync(bogus, Buffer.from('this is not a webp file'))
  await assert.rejects(() => webp.probe(bogus), (error) => {
    assert.equal(error.code, 'WEBP_INVALID')
    assert.match(error.message, /不是有效的 WebP/)
    return true
  })
  await assert.rejects(() => webp.probe(path.join(tempDir, 'not-exists.webp')), (error) => {
    assert.equal(error.code, 'WEBP_INVALID')
    assert.match(error.message, /不存在或无法读取/)
    return true
  })
})
