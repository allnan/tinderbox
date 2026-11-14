'use strict'

/**
 * 纯 JS GIF 解析与延时修补。
 *
 * 提供：
 * - probe(filePath) / probeBuffer(buffer)：逻辑屏幕宽高、帧数、逐帧延时（GCE）、循环次数、体积；
 * - patchDelays(src, dst, delays, options)：把每帧延时重写为指定值（ms 或 cs），并按需写入/移除
 *   NETSCAPE2.0 循环扩展；写完后读回校验，不一致直接抛错；
 * - patchLoop(src, dst, loopCount)：仅改写循环次数。
 *
 * 约束：GIF 延时单位为 1/100 秒（厘秒）；本模块只负责写值与校验，最小 2cs 的业务规则由调用方保证。
 */

const fsp = require('node:fs/promises')
const path = require('node:path')

const HEADER_LENGTH = 13
const EXTENSION = 0x21
const IMAGE = 0x2c
const TRAILER = 0x3b
const GCE_LABEL = 0xf9
const APP_LABEL = 0xff
const NETSCAPE = 'NETSCAPE2.0'

function gifError(message) {
  const error = new Error(message)
  error.code = 'GIF_INVALID'
  return error
}

function skipSubBlocks(buffer, offset) {
  let cursor = offset
  while (cursor < buffer.length) {
    const size = buffer[cursor]
    cursor += 1
    if (size === 0) return cursor
    cursor += size
  }
  throw gifError('GIF 数据块不完整，文件可能已损坏')
}

/** 解析单个扩展块，返回 { end, label, subBlocksStart } */
function readExtension(buffer, offset) {
  if (offset + 2 > buffer.length) throw gifError('GIF 扩展块不完整')
  const label = buffer[offset + 1]
  const end = skipSubBlocks(buffer, offset + 2)
  return { end, label, dataStart: offset + 2 }
}

function readSubBlocks(buffer, start) {
  const blocks = []
  let cursor = start
  while (cursor < buffer.length) {
    const size = buffer[cursor]
    cursor += 1
    if (size === 0) return { blocks, end: cursor }
    if (cursor + size > buffer.length) throw gifError('GIF 数据块不完整')
    blocks.push(buffer.subarray(cursor, cursor + size))
    cursor += size
  }
  throw gifError('GIF 数据块不完整')
}

/**
 * 解析 GIF 结构。
 * @returns {{version:string,width:number,height:number,packed:number,globalColorTableEnd:number,loopCount:number,
 *   loopOffset:number|null,netscapeOffset:number|null,frames:Array<{delayCs:number|null,delayOffset:number|null,imageStart:number}>}}
 */
function parseGif(buffer) {
  if (!buffer || buffer.length < HEADER_LENGTH) throw gifError('不是有效的 GIF 文件（文件过短）')
  const version = buffer.toString('latin1', 0, 6)
  if (version !== 'GIF87a' && version !== 'GIF89a') throw gifError('不是有效的 GIF 文件（文件头不是 GIF87a/GIF89a）')
  const width = buffer.readUInt16LE(6)
  const height = buffer.readUInt16LE(8)
  const packed = buffer.readUInt8(10)
  if (!(width > 0) || !(height > 0)) throw gifError('GIF 尺寸无效')
  let offset = HEADER_LENGTH
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1))
  if (offset > buffer.length) throw gifError('GIF 全局调色板不完整')

  const frames = []
  let loopCount = -1
  let loopOffset = null
  let netscapeOffset = null
  let pendingGce = null
  let sawTrailer = false

  while (offset < buffer.length) {
    const marker = buffer[offset]
    if (marker === EXTENSION) {
      const extensionStart = offset
      const { end, label, dataStart } = readExtension(buffer, offset)
      if (label === GCE_LABEL) {
        // GCE: 0x21 0xF9 0x04 <packed> <delayLo> <delayHi> <transparent> 0x00
        if (dataStart + 4 > end) throw gifError('GIF 图形控制扩展不完整')
        // dataStart 指向块长度字节（0x04），其后依次为 packed、delayLo、delayHi、transparent
        const delayCs = buffer.readUInt16LE(dataStart + 2)
        pendingGce = { delayCs, delayOffset: dataStart + 2, start: extensionStart, end }
      } else if (label === APP_LABEL) {
        const { blocks } = readSubBlocks(buffer, dataStart)
        if (blocks.length >= 2 && blocks[0].toString('latin1') === NETSCAPE) {
          netscapeOffset = extensionStart
          if (blocks[1] && blocks[1].length >= 3) {
            loopCount = blocks[1].readUInt16LE(1)
            // 子块内容为 0x01 lo hi，其在原 buffer 中的偏移 = 该子块数据起点 + 1
            let cursor = dataStart
            for (const block of blocks) {
              if (block === blocks[1]) {
                loopOffset = cursor + 1 + 1
                break
              }
              cursor += 1 + block.length
            }
          }
        }
      }
      offset = end
      continue
    }
    if (marker === IMAGE) {
      const imageStart = offset
      if (offset + 10 > buffer.length) throw gifError('GIF 图像块不完整')
      const localPacked = buffer.readUInt8(offset + 9)
      offset += 10
      if (localPacked & 0x80) offset += 3 * (1 << ((localPacked & 0x07) + 1))
      if (offset >= buffer.length) throw gifError('GIF 图像数据缺失')
      offset += 1 // LZW 最小码长
      offset = skipSubBlocks(buffer, offset)
      frames.push({
        delayCs: pendingGce ? pendingGce.delayCs : null,
        delayOffset: pendingGce ? pendingGce.delayOffset : null,
        imageStart,
      })
      pendingGce = null
      continue
    }
    if (marker === TRAILER) {
      sawTrailer = true
      offset += 1
      break
    }
    // 未知字节：尝试跳到下一个可能的块，避免死循环
    offset += 1
  }
  if (!sawTrailer) throw gifError('GIF 文件缺少结束标记（文件可能被截断）')
  if (frames.length === 0) throw gifError('GIF 文件里没有图像帧')

  return {
    version,
    width,
    height,
    packed,
    globalColorTableEnd: HEADER_LENGTH + (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0),
    loopCount,
    loopOffset,
    netscapeOffset,
    frames,
  }
}

/** 把解析结果整理为探测数据（不读取文件本身） */
function summarize(parsed, buffer) {
  const delaysCs = parsed.frames.map((frame) => (Number.isInteger(frame.delayCs) ? frame.delayCs : 0))
  const frameDelaysMs = delaysCs.map((cs) => cs * 10)
  const durationMs = frameDelaysMs.reduce((total, ms) => total + ms, 0)
  const frameCount = parsed.frames.length
  const durationSec = durationMs / 1000
  return {
    version: parsed.version,
    width: parsed.width,
    height: parsed.height,
    frameCount,
    frameDelaysCs: delaysCs,
    frameDelaysMs,
    durationSec: Math.round(durationSec * 1000) / 1000,
    fps: durationSec > 0 ? Math.round((frameCount / durationSec) * 1000) / 1000 : 0,
    loopCount: parsed.loopCount,
    hasGlobalColorTable: Boolean(parsed.packed & 0x80),
    sizeBytes: buffer ? buffer.length : 0,
  }
}

function probeBuffer(buffer) {
  return summarize(parseGif(buffer), buffer)
}

async function probe(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw gifError('缺少 GIF 文件路径')
  let buffer
  try {
    buffer = await fsp.readFile(filePath)
  } catch {
    throw gifError('GIF 文件不存在或无法读取：' + filePath)
  }
  return probeBuffer(buffer)
}

// ---------------------------------------------------------------------------
// 延时/循环修补
// ---------------------------------------------------------------------------

function buildNetscapeBlock(loopCount) {
  // 0x21 0xFF 0x0B "NETSCAPE2.0" 03 01 <loop lo> <loop hi> 00
  const block = Buffer.concat([
    Buffer.from([EXTENSION, APP_LABEL, 0x0b]),
    Buffer.from(NETSCAPE, 'latin1'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ])
  block.writeUInt16LE(loopCount & 0xffff, 16)
  return { block, loopOffset: 16 }
}

/**
 * 把延迟数组换算成厘秒整数。
 * @param {number[]} delays
 * @param {'ms'|'cs'} unit
 */
function normalizeDelays(delays, unit) {
  if (!Array.isArray(delays) || delays.length === 0) throw gifError('缺少要写入的帧延时数组')
  return delays.map((value, index) => {
    const number = Number(value)
    if (!Number.isFinite(number)) throw gifError('第 ' + (index + 1) + ' 帧延时不是有效数字')
    const cs = unit === 'cs' ? Math.round(number) : Math.round(number / 10)
    if (cs < 0 || cs > 65535) throw gifError('第 ' + (index + 1) + ' 帧延时超出 GIF 允许范围')
    return cs
  })
}

/**
 * 修补 GIF 每帧延时并（可选）写入循环次数。
 * @param {string} srcPath 源 GIF
 * @param {string} dstPath 目标 GIF（可以与源相同，内部先写临时文件再替换）
 * @param {number[]} delays 每帧延时（默认单位毫秒）
 * @param {{unit?:'ms'|'cs', loopCount?:number|null, minCs?:number}} options
 * @returns {Promise<{frameCount:number,delayCs:number[],durationMs:number,loopCount:number}>}
 */
async function patchDelays(srcPath, dstPath, delays, options = {}) {
  if (typeof srcPath !== 'string' || typeof dstPath !== 'string') throw gifError('缺少 GIF 文件路径')
  const source = await fsp.readFile(srcPath)
  const parsed = parseGif(source)
  const targetDelays = normalizeDelays(delays, options.unit === 'cs' ? 'cs' : 'ms')
  if (targetDelays.length !== parsed.frames.length) {
    throw gifError(
      '帧延时数量（' + targetDelays.length + '）与 GIF 帧数（' + parsed.frames.length + '）不一致；' +
        '这通常说明编码器输出帧数与抽帧数不同，请重试或更换预设（如仍失败请反馈该推文链接）',
    )
  }
  if (options.minCs && options.minCs > 0) {
    for (let i = 0; i < targetDelays.length; i += 1) {
      if (targetDelays[i] < options.minCs) targetDelays[i] = options.minCs
    }
  }

  const hasLoopOption = Object.prototype.hasOwnProperty.call(options, 'loopCount')
  const loopCount = hasLoopOption && Number.isFinite(Number(options.loopCount)) ? Math.round(Number(options.loopCount)) : null
  if (loopCount !== null && (loopCount < -1 || loopCount > 65535)) throw gifError('GIF 循环次数超出范围')

  const chunks = []
  const patches = []
  const emit = (buffer) => {
    const start = chunks.reduce((total, chunk) => total + chunk.length, 0)
    chunks.push(buffer)
    return start
  }
  const flushChunks = () => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const output = Buffer.allocUnsafe(total)
    let offset = 0
    for (const chunk of chunks) {
      chunk.copy(output, offset)
      offset += chunk.length
    }
    for (const patch of patches) patch(output)
    return output
  }

  emit(source.subarray(0, parsed.globalColorTableEnd))
  // 需要无限/有限循环但源文件没有 NETSCAPE 时，在全局调色板后插入
  if (hasLoopOption && loopCount !== null && loopCount >= 0 && parsed.netscapeOffset === null) {
    const { block } = buildNetscapeBlock(loopCount)
    emit(block)
  }

  let offset = parsed.globalColorTableEnd
  let pendingGce = null
  let frameIndex = 0

  const emitGce = (start, end, delayOffsetInBlock, delayCs) => {
    const gce = Buffer.from(source.subarray(start, end))
    const local = emit(gce)
    patches.push((output) => {
      // delayOffset 相对 gce 在输出中的起始
      output.writeUInt16LE(delayCs, local + delayOffsetInBlock)
    })
  }

  while (offset < source.length) {
    const marker = source[offset]
    if (marker === EXTENSION) {
      const { end, label, dataStart } = readExtension(source, offset)
      if (label === GCE_LABEL) {
        if (dataStart + 4 > end) throw gifError('GIF 图形控制扩展不完整')
        pendingGce = { start: offset, end, delayOffsetInBlock: dataStart + 2 - offset }
        offset = end
        continue
      }
      if (label === APP_LABEL) {
        const { blocks } = readSubBlocks(source, dataStart)
        if (blocks.length >= 2 && blocks[0].toString('latin1') === NETSCAPE) {
          if (hasLoopOption && loopCount !== null) {
            if (loopCount === -1) {
              // 不循环：整个 NETSCAPE 扩展移除
              offset = end
              continue
            }
            // 找到 loop 值在原 buffer 中的偏移
            let cursor = dataStart
            let valueOffset = null
            for (const block of blocks) {
              if (block === blocks[1]) {
                valueOffset = cursor + 1 + 1
                break
              }
              cursor += 1 + block.length
            }
            const appBlock = Buffer.from(source.subarray(offset, end))
            const blockStart = offset
            const local = emit(appBlock)
            patches.push((output) => {
              output.writeUInt16LE(loopCount, local + (valueOffset - blockStart))
            })
            offset = end
            continue
          }
          // 不修改循环：原样复制
          emit(source.subarray(offset, end))
          offset = end
          continue
        }
      }
      emit(source.subarray(offset, end))
      offset = end
      continue
    }
    if (marker === IMAGE) {
      if (pendingGce) {
        emitGce(pendingGce.start, pendingGce.end, pendingGce.delayOffsetInBlock, targetDelays[frameIndex])
        pendingGce = null
      } else {
        // 原文件该帧没有 GCE：插入一个无透明色、无处置的 GCE
        const gce = Buffer.from([EXTENSION, GCE_LABEL, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00])
        const delayCs = targetDelays[frameIndex]
        const local = emit(gce)
        patches.push((output) => output.writeUInt16LE(delayCs, local + 4))
      }
      const imageStart = offset
      if (offset + 10 > source.length) throw gifError('GIF 图像块不完整')
      const localPacked = source.readUInt8(offset + 9)
      offset += 10
      if (localPacked & 0x80) offset += 3 * (1 << ((localPacked & 0x07) + 1))
      if (offset >= source.length) throw gifError('GIF 图像数据缺失')
      offset += 1
      offset = skipSubBlocks(source, offset)
      emit(source.subarray(imageStart, offset))
      frameIndex += 1
      continue
    }
    if (marker === TRAILER) {
      if (pendingGce) {
        emit(source.subarray(pendingGce.start, pendingGce.end))
        pendingGce = null
      }
      emit(source.subarray(offset, offset + 1))
      offset += 1
      break
    }
    emit(source.subarray(offset, offset + 1))
    offset += 1
  }

  const output = flushChunks()
  const temporary = dstPath + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.mkdir(path.dirname(path.resolve(dstPath)), { recursive: true })
  await fsp.writeFile(temporary, output)
  await fsp.rename(temporary, dstPath)

  // 读回校验：延时与帧数必须与期望一致
  const verification = await probe(dstPath)
  const expectedMs = targetDelays.map((cs) => cs * 10)
  if (verification.frameCount !== targetDelays.length) {
    throw gifError('写入 GIF 延时后校验失败：帧数不一致')
  }
  const mismatch = verification.frameDelaysMs.findIndex((value, index) => value !== expectedMs[index])
  if (mismatch >= 0) {
    throw gifError('写入 GIF 延时后校验失败：第 ' + (mismatch + 1) + ' 帧延时不正确')
  }
  if (hasLoopOption && loopCount !== null && verification.loopCount !== loopCount) {
    throw gifError('写入 GIF 循环次数后校验失败')
  }
  return {
    frameCount: targetDelays.length,
    delayCs: targetDelays,
    durationMs: expectedMs.reduce((total, ms) => total + ms, 0),
    loopCount: hasLoopOption && loopCount !== null ? loopCount : verification.loopCount,
  }
}

/** 只改写循环次数，延时保持不变 */
async function patchLoop(srcPath, dstPath, loopCount) {
  const info = await probe(srcPath)
  return patchDelays(srcPath, dstPath, info.frameDelaysMs, { unit: 'ms', loopCount })
}

module.exports = { probe, probeBuffer, parseGif, patchDelays, patchLoop, summarize, gifError }
