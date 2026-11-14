'use strict'

/**
 * 纯 JS MP4 探测（不依赖 ffprobe）。
 *
 * 解析 moov/trak/mdia/mdhd/hdlr/minf/stbl/stts/stsz/stsd/tkhd/mvhd，
 * 返回 MediaProbe：宽高、时长、帧数、平均帧率、逐帧时长（来自 stts decode delta）、是否有音轨。
 *
 * 设计要点：
 * - X 的「GIF」MP4 用 stts 的每帧 decode 时长保存了原 GIF 的逐帧延时（实测 30ms/40ms 交替），
 *   因此 frameDurationsMs 是还原播放节奏的唯一可靠来源；
 * - 先尝试纯 JS 解析，失败时才回退系统 PATH 中的 ffprobe（若存在），最后回退 ffmpeg -i 文本解析；
 * - 内部一致性：frameCount 一律等于 frameDurationsMs.length（时间轴以 stts 为准）；
 *   stts 与 stsz 样本数不一致时在 warnings 中记录，不再取两者较大值；
 * - 所有错误信息为可直接展示的中文。
 */

const fsp = require('node:fs/promises')
const { spawnSync } = require('node:child_process')

/** 视频帧数上限，防止损坏文件导致内存爆炸 */
const MAX_FRAMES = 200000

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf'])

function probeError(message, detail) {
  const error = new Error(message + (detail ? '（' + detail + '）' : ''))
  error.code = 'PROBE_FAILED'
  return error
}

/** 读取一个 box 头：{ type, start, payloadStart, end }，越界/损坏返回 null */
function readBox(buffer, offset, end) {
  if (offset + 8 > end) return null
  let size = buffer.readUInt32BE(offset)
  const type = buffer.toString('latin1', offset + 4, offset + 8)
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > end) return null
    size = Number(buffer.readBigUInt64BE(offset + 8))
    headerSize = 16
  } else if (size === 0) {
    size = end - offset
  }
  const boxEnd = offset + size
  if (!Number.isFinite(size) || size < headerSize || boxEnd > end) return null
  return { type, start: offset, payloadStart: offset + headerSize, end: boxEnd }
}

/** 依次产出某范围内的直接子 box */
function* childBoxes(buffer, start, end) {
  let offset = start
  while (offset + 8 <= end) {
    const box = readBox(buffer, offset, end)
    if (!box) return
    yield box
    offset = box.end
  }
}

function findChild(buffer, parent, type) {
  for (const child of childBoxes(buffer, parent.payloadStart, parent.end)) {
    if (child.type === type) return child
  }
  return null
}

function findChildren(buffer, parent, type) {
  const result = []
  for (const child of childBoxes(buffer, parent.payloadStart, parent.end)) {
    if (child.type === type) result.push(child)
  }
  return result
}

function findTopLevel(buffer, type) {
  for (const box of childBoxes(buffer, 0, buffer.length)) {
    if (box.type === type) return box
  }
  return null
}

/** 解析 mvhd/mdhd 的 timescale 与 duration */
function readTimescaleDuration(buffer, box) {
  const version = buffer.readUInt8(box.payloadStart)
  const base = box.payloadStart + 4
  const offset = base + (version === 1 ? 16 : 8)
  if (offset + (version === 1 ? 12 : 8) > box.end) return null
  const timescale = buffer.readUInt32BE(offset)
  const duration = version === 1 ? Number(buffer.readBigUInt64BE(offset + 4)) : buffer.readUInt32BE(offset + 4)
  return { version, timescale, duration }
}

/** tkhd 中的宽高（16.16 定点数） */
function readTkhdSize(buffer, box) {
  const version = buffer.readUInt8(box.payloadStart)
  // version/flags(4) + 时间字段 + track_id(4) + reserved(4) + duration(4/8) + reserved(8)
  // + layer(2) + alternate_group(2) + volume(2) + reserved(2) + matrix(36) => 宽高各 4 字节
  const offset = box.payloadStart + 4 + (version === 1 ? 32 : 20) + 8 + 2 + 2 + 2 + 2 + 36
  if (offset + 8 > box.end) return null
  return {
    width: buffer.readUInt32BE(offset) / 65536,
    height: buffer.readUInt32BE(offset + 4) / 65536,
  }
}

/** hdlr 的 handler_type：vide / soun / text ... */
function readHandlerType(buffer, box) {
  if (box.payloadStart + 12 > box.end) return null
  return buffer.toString('latin1', box.payloadStart + 8, box.payloadStart + 12)
}

/** stsd 第一个视频 sample entry 的宽高 */
function readStsdSize(buffer, box) {
  const count = buffer.readUInt32BE(box.payloadStart + 4)
  if (count < 1) return null
  const entryOffset = box.payloadStart + 8
  if (entryOffset + 36 > box.end) return null
  return {
    width: buffer.readUInt16BE(entryOffset + 32),
    height: buffer.readUInt16BE(entryOffset + 34),
  }
}

/** 展开 stts 为逐帧 decode 时长（毫秒） */
function readSttsDurations(buffer, box, timescale) {
  if (!timescale || timescale <= 0) return null
  const count = buffer.readUInt32BE(box.payloadStart + 4)
  if (count < 0 || count > 100000) return null
  const durations = []
  let offset = box.payloadStart + 8
  for (let i = 0; i < count; i += 1) {
    if (offset + 8 > box.end) return null
    const sampleCount = buffer.readUInt32BE(offset)
    const delta = buffer.readUInt32BE(offset + 4)
    offset += 8
    if (sampleCount === 0) continue
    if (durations.length + sampleCount > MAX_FRAMES) return null
    const ms = Math.round((delta / timescale) * 1000 * 1000) / 1000
    for (let j = 0; j < sampleCount; j += 1) durations.push(ms)
  }
  return durations
}

function readStszCount(buffer, box) {
  if (box.payloadStart + 12 > box.end) return null
  return buffer.readUInt32BE(box.payloadStart + 8)
}

/** 从 stbl 解析视频轨道的尺寸/时长信息 */
function parseVideoTrak(buffer, trak) {
  const tkhd = findChild(buffer, trak, 'tkhd')
  const mdia = findChild(buffer, trak, 'mdia')
  if (!mdia) return null
  const hdlr = findChild(buffer, mdia, 'hdlr')
  const mdhd = findChild(buffer, mdia, 'mdhd')
  const minf = findChild(buffer, mdia, 'minf')
  const stbl = minf ? findChild(buffer, minf, 'stbl') : null
  const handler = hdlr ? readHandlerType(buffer, hdlr) : null
  const timing = mdhd ? readTimescaleDuration(buffer, mdhd) : null
  const stts = stbl ? findChild(buffer, stbl, 'stts') : null
  const stsz = stbl ? findChild(buffer, stbl, 'stsz') : null
  const stsd = stbl ? findChild(buffer, stbl, 'stsd') : null
  const durations = stts && timing ? readSttsDurations(buffer, stts, timing.timescale) : null
  return {
    handler,
    timing,
    tkhd: tkhd ? readTkhdSize(buffer, tkhd) : null,
    stsd: stsd ? readStsdSize(buffer, stsd) : null,
    durations,
    sampleCount: stsz ? readStszCount(buffer, stsz) : null,
  }
}

/**
 * 用纯 JS 解析 MP4 buffer。
 * @returns {MediaProbe}（不含 sizeBytes，由 probe 补充）
 */
function probeBuffer(buffer, options = {}) {
  if (!buffer || buffer.length < 16) throw probeError('媒体文件不完整，无法解析 MP4 结构')
  const moov = findTopLevel(buffer, 'moov')
  if (!moov) throw probeError('媒体文件不是标准的 MP4（缺少 moov 盒子）')
  const mvhd = findChild(buffer, moov, 'mvhd')
  const movieTiming = mvhd ? readTimescaleDuration(buffer, mvhd) : null
  const traks = findChildren(buffer, moov, 'trak').map((trak) => parseVideoTrak(buffer, trak))
  const videoTrak = traks.find((item) => item && item.handler === 'vide' && (item.durations || item.stsd))
  if (!videoTrak) throw probeError('媒体文件里没有视频轨')
  const hasAudio = traks.some((item) => item && item.handler === 'soun')

  // 帧数与逐帧时长必须内部一致：时间轴以 stts（time-to-sample）为唯一来源，
  // frameCount 一律等于 frameDurationsMs.length，不再取 max(stts, stsz)（真实样本曾出现
  // stts 86 条 / stsz 84 个的异常文件，取大值会让下游拿到 86 个延时但只能抽出 84 帧）。
  const warnings = []
  let frameDurationsMs = videoTrak.durations && videoTrak.durations.length > 0 ? videoTrak.durations.slice() : null
  const sttsCount = frameDurationsMs ? frameDurationsMs.length : 0
  const sampleCount = Number(videoTrak.sampleCount) || 0
  let frameCount = sttsCount
  if (sttsCount > 0 && sampleCount > 0 && sampleCount !== sttsCount) {
    warnings.push('MP4 的 stts 帧时长条目数（' + sttsCount + '）与 stsz 采样数（' + sampleCount + '）不一致，已按 stts 时间轴为准')
  }
  if (!frameCount && sampleCount > 0) frameCount = sampleCount

  const timing = videoTrak.timing
  const trackSeconds = timing && timing.timescale > 0 ? timing.duration / timing.timescale : 0
  const movieSeconds = movieTiming && movieTiming.timescale > 0 ? movieTiming.duration / movieTiming.timescale : 0
  let durationSec = trackSeconds || movieSeconds

  if (frameDurationsMs) {
    const sumSeconds = frameDurationsMs.reduce((total, ms) => total + ms, 0) / 1000
    // stts 之和与容器时长理论上一致；容器时长缺失时用逐帧累加
    if (!durationSec) durationSec = sumSeconds
  }
  if (!frameCount) throw probeError('无法从 MP4 中读取视频帧数')
  if (!(durationSec > 0) && frameDurationsMs) {
    durationSec = frameDurationsMs.reduce((total, ms) => total + ms, 0) / 1000
  }
  if (!frameDurationsMs) {
    const uniform = durationSec > 0 ? (durationSec * 1000) / frameCount : 0
    frameDurationsMs = new Array(frameCount).fill(Math.round(uniform * 1000) / 1000)
  }

  const size = videoTrak.stsd && videoTrak.stsd.width > 0 ? videoTrak.stsd : videoTrak.tkhd
  const width = size && Number.isFinite(size.width) ? Math.round(size.width) : 0
  const height = size && Number.isFinite(size.height) ? Math.round(size.height) : 0
  if (!(width > 0) || !(height > 0)) throw probeError('无法从 MP4 中读取视频尺寸')

  const fps = durationSec > 0 ? frameCount / durationSec : 0
  return {
    width,
    height,
    durationSec: Math.round(durationSec * 1000) / 1000,
    frameCount,
    fps: Math.round(fps * 1000) / 1000,
    frameDurationsMs,
    hasAudio,
    timescale: timing ? timing.timescale : null,
    /** 解析期间的告警（例如 stts 与 stsz 帧数不一致），不影响使用但建议记录 */
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 回退方案：ffprobe / ffmpeg（仅纯 JS 解析失败时使用）
// ---------------------------------------------------------------------------

function runQuiet(bin, args, timeoutMs = 30000) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
}

/** 解析 ffprobe JSON，无法取得逐帧时长时按平均时长补齐 */
function probeWithFfprobe(filePath) {
  const result = runQuiet('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,avg_frame_rate,r_frame_rate,duration',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ])
  if (result.error || result.status !== 0 || !result.stdout) return null
  let json
  try {
    json = JSON.parse(result.stdout)
  } catch {
    return null
  }
  const stream = (json.streams || [])[0]
  if (!stream) return null
  const width = Number(stream.width) || 0
  const height = Number(stream.height) || 0
  if (!(width > 0) || !(height > 0)) return null
  let durationSec = Number(stream.duration) || Number(json.format && json.format.duration) || 0
  const fpsText = String(stream.avg_frame_rate || stream.r_frame_rate || '0/0')
  const [num, den] = fpsText.split('/').map(Number)
  const fps = den ? num / den : 0
  let frameCount = Number(stream.nb_frames) || 0
  if (!frameCount && durationSec > 0 && fps > 0) frameCount = Math.round(durationSec * fps)
  if (!frameCount) return null
  if (!(durationSec > 0) && fps > 0) durationSec = frameCount / fps
  const uniform = frameCount ? (durationSec * 1000) / frameCount : 0
  return {
    width,
    height,
    durationSec: Math.round(durationSec * 1000) / 1000,
    frameCount,
    fps: Math.round(fps * 1000) / 1000 || Math.round((frameCount / (durationSec || 1)) * 1000) / 1000,
    frameDurationsMs: new Array(frameCount).fill(Math.round(uniform * 1000) / 1000),
    hasAudio: false,
    timescale: null,
    warnings: [],
  }
}

/** 最后的兜底：解析 ffmpeg -i 的文本输出 */
function probeWithFfmpegText(filePath) {
  const result = runQuiet('ffmpeg', ['-hide_banner', '-i', filePath])
  const text = String(result.stderr || '')
  const videoLine = text.split(/\r?\n/).find((line) => /Stream #\d+:\d+.*: Video:/.test(line))
  if (!videoLine) return null
  const sizeMatch = videoLine.match(/(\d{2,5})x(\d{2,5})/)
  if (!sizeMatch) return null
  const width = Number(sizeMatch[1])
  const height = Number(sizeMatch[2])
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const durationSec = durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : 0
  const fpsMatch = videoLine.match(/(\d+(?:\.\d+)?)\s*fps/)
  const fps = fpsMatch ? Number(fpsMatch[1]) : 0
  let frameCount = 0
  if (durationSec > 0 && fps > 0) frameCount = Math.round(durationSec * fps)
  if (!frameCount) return null
  if (!(durationSec > 0)) return frameCount / fps
  const uniform = (durationSec * 1000) / frameCount
  return {
    width,
    height,
    durationSec: Math.round(durationSec * 1000) / 1000,
    frameCount,
    fps: Math.round(fps * 1000) / 1000,
    frameDurationsMs: new Array(frameCount).fill(Math.round(uniform * 1000) / 1000),
    hasAudio: /Audio:/.test(text),
    timescale: null,
    warnings: [],
  }
}

/**
 * 探测 MP4 文件。
 * @param {string} filePath
 * @returns {Promise<import('../src/shared/types').MediaProbe>}
 */
async function probe(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw probeError('缺少媒体文件路径')
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    throw probeError('媒体文件不存在或无法读取：' + filePath)
  }
  if (!stat.isFile() || stat.size < 16) throw probeError('媒体文件为空或已损坏')
  const buffer = await fsp.readFile(filePath)
  let parsed = null
  let jsError = null
  try {
    parsed = probeBuffer(buffer)
  } catch (error) {
    jsError = error
  }
  if (!parsed) {
    parsed = probeWithFfprobe(filePath) || probeWithFfmpegText(filePath)
  }
  if (!parsed) {
    throw probeError('无法解析媒体文件', jsError ? jsError.message : 'MP4 结构异常')
  }
  validFrameDurations(parsed.frameDurationsMs, filePath)
  return {
    path: filePath,
    sizeBytes: stat.size,
    ...parsed,
  }
}

function validFrameDurations(frameDurationsMs, filePath) {
  if (!Array.isArray(frameDurationsMs) || frameDurationsMs.length === 0) {
    throw probeError('无法从媒体文件读取逐帧时长', filePath)
  }
  for (const value of frameDurationsMs) {
    if (!Number.isFinite(value) || value < 0) throw probeError('媒体文件逐帧时长异常', filePath)
  }
}

module.exports = { probe, probeBuffer, probeError }
