'use strict'

/**
 * node:test 公共工具：临时目录、外部工具探测、测试夹具生成、手工 GIF 构造。
 * 说明：测试全部在纯 Node 环境运行（不 require electron），数据目录通过 XGIF_DATA_DIR 指向临时目录。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const LIB_DIR = path.join(PROJECT_ROOT, 'electron', 'lib')

function libPath(name) {
  return path.join(LIB_DIR, name)
}

/** 创建临时数据目录并在其生命周期内清理 */
function makeTempDataDir(prefix = 'xgif-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  process.env.XGIF_DATA_DIR = dir
  return dir
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }
}

/** 探测外部工具（复用主进程的 tools.cjs，支持 tools/bin 与 PATH） */
function tools() {
  return require(libPath('tools.cjs'))
}

function findTool(name) {
  try {
    return tools().resolve(name)
  } catch {
    return null
  }
}

function runBin(bin, args, options = {}) {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs || 120000,
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
  })
}

/**
 * 生成带 VFR 帧时长的 MP4 夹具（30ms/40ms 交替，模拟 X 上「GIF→MP4」的 stts 结构）。
 * 原理：lavfi 以 100fps 生成 N 帧，再用 setpts 把第 k 帧的时间戳设为
 * floor(k/2)*70 + (k%2)*30（毫秒），libx264 关闭 B 帧 + -fps_mode passthrough，
 * -video_track_timescale 1000 让 stts 的 delta 正好是 30/40。
 * @returns {{filePath:string, frameCount:number, expectedDurationsMs:number[]}}
 */
function makeVfrMp4({ ffmpeg, dir, frameCount = 18, width = 160, height = 120 }) {
  if (!ffmpeg) throw new Error('缺少 ffmpeg，无法生成测试夹具')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'vfr-' + frameCount + '-' + width + 'x' + height + '.mp4')
  const inputDuration = (frameCount / 100 + 0.2).toFixed(2)
  const filter = "setpts='(floor(N/2)*70+mod(N,2)*30)/1000/TB'"
  const result = runBin(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=' + width + 'x' + height + ':rate=100:duration=' + inputDuration,
    '-vf', filter,
    '-frames:v', String(frameCount),
    '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-video_track_timescale', '1000',
    filePath,
  ])
  if (result.status !== 0) throw new Error('生成 VFR MP4 夹具失败：' + String(result.stderr || '').slice(-500))
  const expectedDurationsMs = []
  for (let index = 0; index < frameCount; index += 1) expectedDurationsMs.push(index % 2 === 0 ? 30 : 40)
  return { filePath, frameCount, expectedDurationsMs }
}

/** 生成带音轨的普通 CFR MP4（用于 hasAudio 探测） */
function makeAvMp4({ ffmpeg, dir }) {
  if (!ffmpeg) throw new Error('缺少 ffmpeg，无法生成测试夹具')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'av.mp4')
  const result = runBin(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=12:duration=0.6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6',
    '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    filePath,
  ])
  if (result.status !== 0) throw new Error('生成带音轨 MP4 夹具失败：' + String(result.stderr || '').slice(-500))
  return filePath
}

// ---------------------------------------------------------------------------
// 合成图片（用于图片格式识别/尺寸解析测试，不依赖外部工具）
// ---------------------------------------------------------------------------

/** 生成最小合法头部图片 buffer，format 支持 jpg / png / gif / webp */
function buildTestImage(format, options = {}) {
  const width = options.width || 640
  const height = options.height || 480
  if (format === 'png') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdr = Buffer.alloc(25)
    ihdr.writeUInt32BE(13, 0)
    ihdr.write('IHDR', 4, 'latin1')
    ihdr.writeUInt32BE(width, 8)
    ihdr.writeUInt32BE(height, 12)
    ihdr[16] = 8
    ihdr[17] = 6
    return Buffer.concat([signature, ihdr])
  }
  if (format === 'gif') {
    const buffer = Buffer.alloc(16)
    buffer.write('GIF89a', 0, 'latin1')
    buffer.writeUInt16LE(width, 6)
    buffer.writeUInt16LE(height, 8)
    return buffer
  }
  if (format === 'jpg' || format === 'jpeg') {
    const buffer = Buffer.alloc(24)
    buffer[0] = 0xff
    buffer[1] = 0xd8
    buffer[2] = 0xff
    buffer[3] = 0xc0
    buffer.writeUInt16BE(0x11, 4)
    buffer[6] = 0x08
    buffer.writeUInt16BE(height, 7)
    buffer.writeUInt16BE(width, 9)
    buffer[11] = 3
    return buffer
  }
  if (format === 'webp') {
    const buffer = Buffer.alloc(30)
    buffer.write('RIFF', 0, 'latin1')
    buffer.writeUInt32LE(22, 4)
    buffer.write('WEBP', 8, 'latin1')
    buffer.write('VP8X', 12, 'latin1')
    buffer.writeUInt32LE(10, 16)
    buffer.writeUIntLE(width - 1, 24, 3)
    buffer.writeUIntLE(height - 1, 27, 3)
    return buffer
  }
  throw new Error('不支持的测试图片格式：' + format)
}

// ---------------------------------------------------------------------------
// 合成 MP4（用于 mp4probe 的一致性/异常盒测试，不依赖 ffmpeg）
// ---------------------------------------------------------------------------

function u32(...values) {
  const buffer = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => buffer.writeUInt32BE(value >>> 0, index * 4))
  return buffer
}

function box(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value >>> 0, 0)
  return buffer
}

/**
 * 构造一个最小但可被 mp4probe 解析的 MP4 buffer。
 * 通过 sttsEntries（[sampleCount, delta] 列表）与 sampleCount（stsz 采样数）可刻意制造不一致场景。
 * @param {{width?:number,height?:number,timescale?:number,sttsEntries?:Array<[number,number]>,sampleCount?:number|null,durationUnits?:number|null}} options
 */
function buildSyntheticMp4(options = {}) {
  const width = options.width || 160
  const height = options.height || 120
  const timescale = options.timescale || 1000
  const sttsEntries = Array.isArray(options.sttsEntries) ? options.sttsEntries : []
  const totalSamples = sttsEntries.reduce((sum, entry) => sum + (entry[0] || 0), 0)
  const totalDelta = sttsEntries.reduce((sum, entry) => sum + (entry[0] || 0) * (entry[1] || 0), 0)
  const sampleCount = options.sampleCount === undefined ? totalSamples : options.sampleCount
  const durationUnits = options.durationUnits === undefined || options.durationUnits === null ? totalDelta || 500 : options.durationUnits

  // mvhd：version/flags 4 + 时间字段 + timescale@12 + duration@16
  const mvhdPayload = Buffer.alloc(100)
  mvhdPayload.writeUInt32BE(timescale, 12)
  mvhdPayload.writeUInt32BE(durationUnits, 16)
  const mvhd = box('mvhd', mvhdPayload)

  // tkhd：v0 payload 84，宽高在 payload+76 / +80（16.16 定点）
  const tkhdPayload = Buffer.alloc(84)
  tkhdPayload.writeUInt32BE(width * 65536, 76)
  tkhdPayload.writeUInt32BE(height * 65536, 80)
  const tkhd = box('tkhd', tkhdPayload)

  // mdhd：v0 payload 24，timescale@12、duration@16
  const mdhdPayload = Buffer.alloc(24)
  mdhdPayload.writeUInt32BE(timescale, 12)
  mdhdPayload.writeUInt32BE(durationUnits, 16)
  const mdhd = box('mdhd', mdhdPayload)

  // hdlr：handler_type 在 payload+8
  const hdlrPayload = Buffer.alloc(24)
  hdlrPayload.write('vide', 8, 'latin1')
  const hdlr = box('hdlr', hdlrPayload)

  // stsd：entry_count 后跟 36 字节 avc1 sample entry，宽高在 entry+32/+34
  const sampleEntry = Buffer.alloc(36)
  sampleEntry.writeUInt32BE(36, 0)
  sampleEntry.write('avc1', 4, 'latin1')
  sampleEntry.writeUInt16BE(1, 14)
  sampleEntry.writeUInt16BE(width, 32)
  sampleEntry.writeUInt16BE(height, 34)
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(4), u32(1), sampleEntry]))

  // stts：version/flags 4 + entry_count 4 + entries
  const sttsPayload = Buffer.concat([
    Buffer.alloc(4),
    u32(sttsEntries.length),
    ...sttsEntries.map(([count, delta]) => Buffer.concat([u32(count), u32(delta)])),
  ])
  const stts = box('stts', sttsPayload)

  // stsz：version/flags 4 + sample_size 4 + sample_count 4
  const stsz = box('stsz', Buffer.concat([Buffer.alloc(4), u32(0), u32(sampleCount)]))

  const stbl = box('stbl', Buffer.concat([stsd, stts, stsz]))
  const minf = box('minf', stbl)
  const mdia = box('mdia', Buffer.concat([mdhd, hdlr, minf]))
  const trak = box('trak', Buffer.concat([tkhd, mdia]))
  const moov = box('moov', Buffer.concat([mvhd, trak]))
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), u32(512), Buffer.from('isomiso2', 'latin1')]))
  return Buffer.concat([ftyp, moov])
}

// ---------------------------------------------------------------------------
// 手工构造最小 GIF（不依赖 gifski，用于 gifprobe 单元测试）
// ---------------------------------------------------------------------------

function gceBlock(delayCs) {
  const block = Buffer.alloc(8)
  block[0] = 0x21
  block[1] = 0xf9
  block[2] = 0x04
  block[3] = 0x00 // 无透明色、disposal=0
  block.writeUInt16LE(delayCs & 0xffff, 4)
  block[6] = 0x00
  block[7] = 0x00
  return block
}

function imageBlock(width = 2, height = 2) {
  // 图像描述符 + 2x2 图像数据（LZW：2 位最小码长，clear=4、EOF=5、像素 0）
  const header = Buffer.alloc(10)
  header[0] = 0x2c
  header.writeUInt16LE(0, 1)
  header.writeUInt16LE(0, 3)
  header.writeUInt16LE(width, 5)
  header.writeUInt16LE(height, 7)
  header[9] = 0x00 // 无局部调色板、无交织
  const lzw = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])
  return Buffer.concat([header, lzw])
}

function netscapeBlock(loopCount) {
  return Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'latin1'),
    Buffer.from([0x03, 0x01, loopCount & 0xff, (loopCount >> 8) & 0xff, 0x00]),
  ])
}

/**
 * 构造最小 GIF89a。
 * @param {{delaysCs?:number[], loopCount?:number|null, width?:number, height?:number, withGce?:boolean}} options
 */
function buildTestGif(options = {}) {
  const delaysCs = options.delaysCs || [3, 4, 3]
  const width = options.width || 2
  const height = options.height || 2
  const parts = []
  parts.push(Buffer.from('GIF89a', 'latin1'))
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(width, 0)
  lsd.writeUInt16LE(height, 2)
  lsd[4] = 0x80 // 有全局调色板，2 色
  lsd[5] = 0x00
  lsd[6] = 0x00
  parts.push(lsd)
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff])) // 2 色全局调色板
  if (options.loopCount !== null && options.loopCount !== undefined) parts.push(netscapeBlock(Number(options.loopCount) || 0))
  for (const delay of delaysCs) {
    if (options.withGce !== false) parts.push(gceBlock(delay))
    parts.push(imageBlock(width, height))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

/** 生成无 GCE 的 GIF（用于验证 patchDelays 自动插入 GCE） */
function buildTestGifWithoutGce(delaysCs = [3, 4]) {
  const parts = []
  parts.push(Buffer.from('GIF89a', 'latin1'))
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(2, 0)
  lsd.writeUInt16LE(2, 2)
  lsd[4] = 0x80
  parts.push(lsd)
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]))
  for (let index = 0; index < delaysCs.length; index += 1) parts.push(imageBlock(2, 2))
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}

/** 是否存在网络（用于真实推文用例的动态跳过） */
async function hasNetwork() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const response = await fetch('https://api.fxtwitter.com/2/status/2116630142135275663', {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 xgif-test' },
    })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}

module.exports = {
  PROJECT_ROOT,
  LIB_DIR,
  libPath,
  tools,
  findTool,
  runBin,
  makeTempDataDir,
  removeTempDir,
  makeVfrMp4,
  makeAvMp4,
  buildSyntheticMp4,
  buildTestImage,
  buildTestGif,
  buildTestGifWithoutGce,
  hasNetwork,
}
