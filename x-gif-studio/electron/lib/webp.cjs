'use strict'

/**
 * 动画 WebP 解析与逐帧时长修补。
 *
 * 容器结构（RIFF/WEBP）：
 *   RIFF <size> WEBP
 *   ├─ VP8X  扩展信息（画布宽高、flags；flags 的 0x02 位表示动画）
 *   ├─ ANIM  动画控制（背景色 + 循环次数，0 = 无限循环）
 *   └─ ANMF × N 帧：x(3) y(3) w-1(3) h-1(3) duration(3, 毫秒) flags(1) + 帧数据块
 *
 * 提供：
 * - probe / probeBuffer：帧数、逐帧延时（毫秒）、画布宽高、循环次数、总时长；
 * - patchDelays：按期望的逐帧毫秒延时重写 ANMF duration 并读回校验。
 *
 * ffmpeg 的 concat demuxer 会把 duration 量化到图像输入的默认帧时长网格（约 40ms），
 * 因此编码后必须用本模块把 ANMF 时长改写为精确值（与 GIF 的 patchDelays 同一思路）。
 */

const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')

const ANIMATION_FLAG = 0x02
const MAX_DURATION_MS = 0xffffff

function webpError(message) {
  const error = new Error(message)
  error.code = 'WEBP_INVALID'
  return error
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

/** 解析 RIFF/WebP 容器，返回 probe 数据（内部还会返回帧的写入偏移，供 patchDelays 使用） */
function parseContainer(buffer) {
  if (!buffer || buffer.length < 16) throw webpError('不是有效的 WebP 文件（文件过短）')
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') {
    throw webpError('不是有效的 WebP 文件（缺少 RIFF/WEBP 标识）')
  }
  const riffSize = buffer.readUInt32LE(4)
  if (riffSize + 8 > buffer.length + 1) throw webpError('WebP 文件不完整（RIFF 长度超出文件大小）')

  let width = null
  let height = null
  let bitmapWidth = null
  let bitmapHeight = null
  let loopCount = null
  let animated = false
  let sawAnimChunk = false
  const frames = []
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const payload = offset + 8
    if (payload + size > buffer.length) throw webpError('WebP 数据块不完整（' + fourcc + '）')
    if (fourcc === 'VP8X') {
      if (size < 10) throw webpError('WebP 的 VP8X 块不完整')
      const flags = buffer[payload]
      animated = Boolean(flags & ANIMATION_FLAG)
      width = 1 + readUInt24LE(buffer, payload + 4)
      height = 1 + readUInt24LE(buffer, payload + 7)
    } else if (fourcc === 'ANIM') {
      if (size < 6) throw webpError('WebP 的 ANIM 块不完整')
      sawAnimChunk = true
      loopCount = buffer.readUInt16LE(payload + 4)
    } else if (fourcc === 'ANMF') {
      if (size < 16) throw webpError('WebP 的 ANMF 帧块不完整')
      frames.push({
        durationMs: readUInt24LE(buffer, payload + 12),
        durationOffset: payload + 12,
        width: 1 + readUInt24LE(buffer, payload + 6),
        height: 1 + readUInt24LE(buffer, payload + 9),
      })
    } else if (fourcc === 'VP8 ') {
      // 静态有损 WebP 的位流：3 字节帧标签 + 起始码 9D 01 2A + 14 位宽高
      if (size >= 10 && buffer[payload + 3] === 0x9d && buffer[payload + 4] === 0x01 && buffer[payload + 5] === 0x2a) {
        bitmapWidth = buffer.readUInt16LE(payload + 6) & 0x3fff
        bitmapHeight = buffer.readUInt16LE(payload + 8) & 0x3fff
      }
    } else if (fourcc === 'VP8L') {
      // 静态无损 WebP：0x2F 签名 + 14 位宽高（各减 1）
      if (size >= 5 && buffer[payload] === 0x2f) {
        const bits = buffer.readUInt32LE(payload + 1)
        bitmapWidth = (bits & 0x3fff) + 1
        bitmapHeight = ((bits >>> 14) & 0x3fff) + 1
      }
    }
    offset = payload + size + (size % 2)
  }

  if (!(width > 0) || !(height > 0)) {
    if (frames.length > 0) {
      width = frames[0].width
      height = frames[0].height
    } else if (bitmapWidth > 0 && bitmapHeight > 0) {
      width = bitmapWidth
      height = bitmapHeight
    } else {
      throw webpError('无法从 WebP 中读取画布尺寸')
    }
  }

  const frameDelaysMs = frames.map((frame) => frame.durationMs)
  const totalMs = frameDelaysMs.reduce((sum, value) => sum + value, 0)
  const isAnimation = sawAnimChunk || frames.length > 1 || animated
  return {
    format: 'webp',
    width,
    height,
    frameCount: frames.length > 0 ? frames.length : 1,
    frameDelaysMs: frames.length > 0 ? frameDelaysMs : [0],
    durationSec: Math.round((totalMs / 1000) * 1000) / 1000,
    loopCount: isAnimation ? loopCount : null,
    animated: isAnimation,
    frames,
  }
}

/** 从 buffer 探测（不读文件） */
function probeBuffer(buffer) {
  const parsed = parseContainer(buffer)
  return {
    format: parsed.format,
    width: parsed.width,
    height: parsed.height,
    frameCount: parsed.frameCount,
    frameDelaysMs: parsed.frameDelaysMs,
    durationSec: parsed.durationSec,
    loopCount: parsed.loopCount,
    animated: parsed.animated,
    sizeBytes: buffer.length,
  }
}

/** 探测动画 WebP 文件 */
async function probe(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw webpError('缺少 WebP 文件路径')
  let buffer
  try {
    buffer = await fsp.readFile(filePath)
  } catch {
    throw webpError('WebP 文件不存在或无法读取：' + filePath)
  }
  return probeBuffer(buffer)
}

/**
 * 把动画 WebP 的逐帧时长改写为指定毫秒数组，并读回校验。
 * @param {string} srcPath
 * @param {string} dstPath 目标路径（可与源相同，内部先写临时文件再替换）
 * @param {number[]} delaysMs
 * @returns {Promise<{frameCount:number, frameDelaysMs:number[], durationSec:number}>}
 */
async function patchDelays(srcPath, dstPath, delaysMs) {
  if (typeof srcPath !== 'string' || typeof dstPath !== 'string') throw webpError('缺少 WebP 文件路径')
  if (!Array.isArray(delaysMs) || delaysMs.length === 0) throw webpError('缺少要写入的逐帧延时数组')
  const buffer = await fsp.readFile(srcPath).catch(() => {
    throw webpError('WebP 文件不存在或无法读取：' + srcPath)
  })
  const parsed = parseContainer(buffer)
  if (!parsed.animated || parsed.frames.length === 0) throw webpError('不是动画 WebP，无法写入逐帧延时')
  if (parsed.frames.length !== delaysMs.length) {
    throw webpError(
      '帧延时数量（' + delaysMs.length + '）与 WebP 帧数（' + parsed.frames.length + '）不一致；' +
        '这通常说明编码器输出帧数与抽帧数不同，请重试或更换参数',
    )
  }
  const normalized = delaysMs.map((value, index) => {
    const ms = Math.round(Number(value))
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DURATION_MS) {
      throw webpError('第 ' + (index + 1) + ' 帧延时超出 WebP 允许范围（0-16777215ms）')
    }
    return ms
  })
  const output = Buffer.from(buffer)
  for (let index = 0; index < parsed.frames.length; index += 1) {
    const offset = parsed.frames[index].durationOffset
    output[offset] = normalized[index] & 0xff
    output[offset + 1] = (normalized[index] >> 8) & 0xff
    output[offset + 2] = (normalized[index] >> 16) & 0xff
  }
  const temporary = dstPath + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.mkdir(path.dirname(path.resolve(dstPath)), { recursive: true })
  try {
    await fsp.writeFile(temporary, output)
    await fsp.rm(dstPath, { force: true })
    await fsp.rename(temporary, dstPath)
  } catch (error) {
    try {
      await fsp.rm(temporary, { force: true })
    } catch {
      /* 忽略清理失败 */
    }
    throw error
  }

  const verification = await probe(dstPath)
  const mismatch = verification.frameDelaysMs.findIndex((value, index) => value !== normalized[index])
  if (mismatch >= 0) throw webpError('写入 WebP 帧延时后校验失败：第 ' + (mismatch + 1) + ' 帧不正确')
  return {
    frameCount: verification.frameCount,
    frameDelaysMs: verification.frameDelaysMs,
    durationSec: verification.durationSec,
  }
}

module.exports = { probe, probeBuffer, patchDelays, webpError }
