'use strict'

/** gifprobe：GIF 解析、延时修补、NETSCAPE 循环读写与读回校验 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const helpers = require('./helpers.cjs')
const gifprobe = require(helpers.libPath('gifprobe.cjs'))

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgif-gifprobe-'))

function writeTemp(name, buffer) {
  const target = path.join(tempDir, name)
  fs.writeFileSync(target, buffer)
  return target
}

test.after(() => helpers.removeTempDir(tempDir))

test('probe 解析逻辑屏幕/帧数/逐帧延时/循环次数', async () => {
  const file = writeTemp('basic.gif', helpers.buildTestGif({ delaysCs: [3, 4, 5], loopCount: 0, width: 32, height: 24 }))
  const info = await gifprobe.probe(file)
  assert.equal(info.width, 32)
  assert.equal(info.height, 24)
  assert.equal(info.frameCount, 3)
  assert.deepEqual(info.frameDelaysMs, [30, 40, 50])
  assert.deepEqual(info.frameDelaysCs, [3, 4, 5])
  assert.equal(info.durationSec, 0.12)
  assert.equal(info.loopCount, 0)
  assert.equal(info.sizeBytes, fs.statSync(file).size)
  assert.ok(info.fps > 0)
})

test('probe：未写 NETSCAPE 时 loopCount 为 -1', async () => {
  const file = writeTemp('noloop.gif', helpers.buildTestGif({ delaysCs: [3], loopCount: null }))
  const info = await gifprobe.probe(file)
  assert.equal(info.loopCount, -1)
})

test('patchDelays：按毫秒重写延时并读回校验', async () => {
  const source = writeTemp('patch-src.gif', helpers.buildTestGif({ delaysCs: [3, 3, 3], loopCount: 0 }))
  const target = path.join(tempDir, 'patch-dst.gif')
  const result = await gifprobe.patchDelays(source, target, [30, 40, 50], { unit: 'ms', loopCount: 0 })
  assert.deepEqual(result.delayCs, [3, 4, 5])
  assert.equal(result.durationMs, 120)
  const info = await gifprobe.probe(target)
  assert.deepEqual(info.frameDelaysMs, [30, 40, 50])
  assert.equal(info.loopCount, 0)
})

test('patchDelays：按厘秒重写延时、支持不循环（-1）与指定循环次数', async () => {
  const source = writeTemp('loop-src.gif', helpers.buildTestGif({ delaysCs: [10, 10], loopCount: 0 }))
  const noLoop = path.join(tempDir, 'loop-none.gif')
  await gifprobe.patchDelays(source, noLoop, [2, 3], { unit: 'cs', loopCount: -1 })
  assert.equal((await gifprobe.probe(noLoop)).loopCount, -1)
  const loop7 = path.join(tempDir, 'loop-7.gif')
  await gifprobe.patchDelays(source, loop7, [2, 3], { unit: 'cs', loopCount: 7 })
  assert.equal((await gifprobe.probe(loop7)).loopCount, 7)
})

test('patchDelays：源 GIF 没有 NETSCAPE 时能插入循环扩展', async () => {
  const source = writeTemp('insert-ns.gif', helpers.buildTestGif({ delaysCs: [3], loopCount: null }))
  const target = path.join(tempDir, 'insert-ns-out.gif')
  await gifprobe.patchDelays(source, target, [5], { unit: 'cs', loopCount: 0 })
  assert.equal((await gifprobe.probe(target)).loopCount, 0)
})

test('patchDelays：没有 GCE 的 GIF 会自动插入图形控制扩展', async () => {
  const source = writeTemp('nogce.gif', helpers.buildTestGifWithoutGce([3, 4]))
  const target = path.join(tempDir, 'nogce-out.gif')
  await gifprobe.patchDelays(source, target, [50, 60], { unit: 'ms', loopCount: 0 })
  const info = await gifprobe.probe(target)
  assert.deepEqual(info.frameDelaysMs, [50, 60])
  assert.equal(info.frameCount, 2)
})

test('patchDelays：延时数量与帧数不一致时抛 GIF_INVALID', async () => {
  const source = writeTemp('mismatch.gif', helpers.buildTestGif({ delaysCs: [3, 4, 5], loopCount: 0 }))
  await assert.rejects(() => gifprobe.patchDelays(source, path.join(tempDir, 'x.gif'), [30, 40], { loopCount: 0 }), (error) => {
    assert.equal(error.code, 'GIF_INVALID')
    assert.match(error.message, /不一致/)
    // task-9：严格校验保持不变，但错误信息要给出可操作提示
    assert.match(error.message, /重试|更换预设/)
    return true
  })
})

test('patchLoop：只改循环次数，不改延时', async () => {
  const source = writeTemp('patchloop.gif', helpers.buildTestGif({ delaysCs: [3, 4], loopCount: 0 }))
  const target = path.join(tempDir, 'patchloop-out.gif')
  await gifprobe.patchLoop(source, target, 5)
  const info = await gifprobe.probe(target)
  assert.equal(info.loopCount, 5)
  assert.deepEqual(info.frameDelaysMs, [30, 40])
})

test('probe 对非 GIF 文件抛出中文错误（GIF_INVALID）', async () => {
  const bogus = writeTemp('bogus.gif', Buffer.from('not a gif at all'))
  await assert.rejects(() => gifprobe.probe(bogus), (error) => {
    assert.equal(error.code, 'GIF_INVALID')
    assert.match(error.message, /不是有效的 GIF/)
    return true
  })
})
