'use strict'

/**
 * GIF 转换流水线（详见 docs/GIF转换技术方案.md 第 2 节）。
 *
 * 核心思路：X 的「GIF」实际是 MP4，且 MP4 的 stts 逐帧时长保存了原 GIF 的延时。
 * 因此默认流水线为：
 *   ffmpeg 抽全部帧（-fps_mode passthrough，不重采样）
 *   → gifski 编码（--no-sort 保序、--fps 名义帧率、--repeat 循环）
 *   → gifprobe.patchDelays 按 stts 还原逐帧延时（厘秒、最小 2cs）
 *   → 可选 gifsicle 极限压缩（默认关闭；实测会使高光/毛发偏色，仅作高级选项）
 *   → gifprobe 探测 → 写入输出目录 → 历史记录 → GifResult。
 *
 * 进度阶段（整体百分比）：
 *   若缓存未命中：download 0-4 → probe 4-6 → thumbnail 6-8
 *   extract 8-55 → encode 55-90 → optimize 90-96 → finalize 96-100
 */

const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const paths = require('./paths.cjs')
const settings = require('./settings.cjs')
const tools = require('./tools.cjs')
const jobs = require('./jobs.cjs')
const history = require('./history.cjs')
const tweet = require('./tweet.cjs')
const mp4probe = require('./mp4probe.cjs')
const gifprobe = require('./gifprobe.cjs')
const webp = require('./webp.cjs')
const media = require('./media.cjs')
const { normalizeParams } = require('./defaults.cjs')

const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000
const ENCODE_TIMEOUT_MS = 10 * 60 * 1000
const OPTIMIZE_TIMEOUT_MS = 3 * 60 * 1000
const GIFSKI_MAX_FPS = 100

/** GIF 规范：<2cs 的延时会被很多查看器按 10cs 处理，因此统一夹到 2cs */
const MIN_DELAY_CS = 2

function convertError(stage, message, cause, label) {
  const error = new Error((label || 'GIF') + ' 转换失败（' + stage + '阶段）：' + message)
  error.code = (cause && cause.code) || 'CONVERT_FAILED'
  error.stage = stage
  if (cause && cause.stderr) error.stderr = cause.stderr
  return error
}

/** WebP 的 -loop 取值：muxer 只接受 0-65535（0 = 无限循环），-1（不循环）映射为 1（播放一次） */
function loopToWebp(loopCount) {
  const value = Number(loopCount)
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 1
  return Math.min(65535, Math.max(0, Math.round(value)))
}

/** 取进程错误输出的尾部，避免错误信息过长 */
function tailOf(result, lines = 6) {
  const text = String((result && (result.stderr || result.stdout)) || '').trim()
  if (!text) return ''
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join(' / ')
}

// ---------------------------------------------------------------------------
// 时间轴计算（供编码前使用，也便于单测）
// ---------------------------------------------------------------------------

/**
 * 把每帧毫秒时长换算成 GIF 厘秒延时。
 * 采用「累计时间 + 四舍五入 + 最小 2cs」的分配方式：即使帧时长不是 10ms 的整数倍
 * （例如 15fps 的 66.67ms），总时长也不会漂移；速度倍率直接作用于时长。
 * @param {number[]} frameDurationsMs
 * @param {{speed?:number, minCs?:number}} options
 * @returns {number[]} 厘秒数组
 */
function computeDelaysCs(frameDurationsMs, options = {}) {
  if (!Array.isArray(frameDurationsMs) || frameDurationsMs.length === 0) return []
  const speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1
  const minCs = Number.isFinite(options.minCs) && options.minCs > 0 ? options.minCs : MIN_DELAY_CS
  const delays = []
  let cumulativeMs = 0
  let assignedCs = 0
  for (const duration of frameDurationsMs) {
    cumulativeMs += Math.max(0, Number(duration) || 0) / speed
    let cs = Math.round(cumulativeMs / 10) - assignedCs
    if (cs < minCs) cs = minCs
    delays.push(cs)
    assignedCs += cs
  }
  // 最小延时可能让总时长变长：把偏差尽量摊回后续帧（保持单调，不产生负延时）
  return delays
}

/** 平均帧时长（毫秒） */
function averageFrameDuration(frameDurationsMs, fallbackDurationSec, frameCount) {
  if (Array.isArray(frameDurationsMs) && frameDurationsMs.length > 0) {
    const total = frameDurationsMs.reduce((sum, value) => sum + (Number(value) || 0), 0)
    if (total > 0) return total / frameDurationsMs.length
  }
  if (fallbackDurationSec > 0 && frameCount > 0) return (fallbackDurationSec * 1000) / frameCount
  return 0
}

/**
 * gifski 名义帧率：只影响初始时长（最终延时会被 patchDelays 覆盖），
 * 但 gifski 限制 1-100，必须夹紧并保留 3 位小数。
 */
function computeNominalFps(averageMs) {
  if (!(averageMs > 0)) return 25
  const fps = 1000 / averageMs
  const clamped = Math.min(GIFSKI_MAX_FPS, Math.max(1, fps))
  return Math.round(clamped * 1000) / 1000
}

/** 数字 fps 模式：把源总时长按输出帧数均匀分配（保持总时长） */
function uniformDurations(durationSec, frameCount) {
  const count = Math.max(1, Math.round(frameCount))
  const totalMs = Math.max(1, (Number(durationSec) || 0) * 1000)
  return new Array(count).fill(totalMs / count)
}

/** 抽帧数量与源帧数不一致时：按时间比例把源帧时长合并成目标帧数 */
function groupDurations(frameDurationsMs, targetCount) {
  const count = Math.max(1, Math.round(targetCount))
  const durations = Array.isArray(frameDurationsMs) ? frameDurationsMs.map((value) => Number(value) || 0) : []
  if (durations.length === 0) return new Array(count).fill(0)
  if (durations.length === count) return durations.slice()
  const total = durations.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) return new Array(count).fill(0)
  const result = []
  let cursor = 0
  let accumulated = 0
  for (let index = 0; index < count; index += 1) {
    const targetEnd = (total * (index + 1)) / count
    let groupTotal = 0
    while (cursor < durations.length && (accumulated < targetEnd || groupTotal === 0)) {
      accumulated += durations[cursor]
      groupTotal += durations[cursor]
      cursor += 1
      if (cursor >= durations.length) break
      if (accumulated >= targetEnd) break
    }
    result.push(groupTotal)
  }
  // 理论上前面的循环会消耗完所有帧；若仍有剩余（浮点误差），并入最后一帧
  let rest = 0
  while (cursor < durations.length) {
    rest += durations[cursor]
    cursor += 1
  }
  if (rest > 0) result[result.length - 1] += rest
  return result
}

/**
 * 把源逐帧时长对齐到目标帧数（用于抽帧数/编码后帧数与源不一致的兜底）。
 * - 数量一致：原样返回；
 * - 目标更少：按时间比例合并相邻帧，保留 VFR 节奏与总时长；
 * - 目标更多（编码器重复帧/抽帧异常）：无法判断重复发生在哪一帧，按源总时长均匀分配，保证总时长不漂移。
 * @param {number[]} frameDurationsMs
 * @param {number} targetFrames
 * @param {number} durationSec 源总时长（秒），用于目标帧数多于源帧数时兜底
 * @returns {number[]}
 */
function alignFrameDurations(frameDurationsMs, targetFrames, durationSec) {
  const frames = Math.max(0, Math.round(Number(targetFrames) || 0))
  if (frames <= 0) return []
  const durations = Array.isArray(frameDurationsMs)
    ? frameDurationsMs.map((value) => Math.max(0, Number(value) || 0))
    : []
  if (durations.length === frames && durations.length > 0) return durations.slice()
  if (durations.length === 0) return uniformDurations(durationSec, frames)
  if (durations.length > frames) return groupDurations(durations, frames)
  return uniformDurations(durationSec, frames)
}

/**
 * 按目标帧数生成 GIF 厘秒延时（编码器输出帧数与抽帧数不一致时使用）。
 * fps='source' 且保留时序时按源逐帧时长对齐；否则按源总时长在目标帧数上均匀分配。
 * @param {{frameDurationsMs?:number[], durationSec?:number}} sourceProbe
 * @param {number} targetFrames
 * @param {{fps?:('source'|number), preserveTiming?:boolean, speed?:number}} options
 * @returns {{delaysCs:number[], durationsMs:number[], aligned:boolean}}
 */
function resolveDelaysForFrames(sourceProbe, targetFrames, options = {}) {
  const fps = options.fps === 'source' ? 'source' : Math.max(1, Math.round(Number(options.fps) || 15))
  const preserveTiming = Boolean(options.preserveTiming) !== false && fps === 'source'
  const speed = Number.isFinite(options.speed) && options.speed > 0 ? options.speed : 1
  const frames = Math.max(0, Math.round(Number(targetFrames) || 0))
  const sourceDurations = Array.isArray(sourceProbe && sourceProbe.frameDurationsMs) ? sourceProbe.frameDurationsMs : []
  const durationSec = Number(sourceProbe && sourceProbe.durationSec) || 0
  let durationsMs
  if (preserveTiming && sourceDurations.length > 0) {
    durationsMs = alignFrameDurations(sourceDurations, frames, durationSec)
  } else {
    durationsMs = uniformDurations(durationSec, frames)
  }
  const delaysCs = computeDelaysCs(durationsMs, { speed })
  return { delaysCs, durationsMs, aligned: frames !== sourceDurations.length }
}

// ---------------------------------------------------------------------------
// 抽帧
// ---------------------------------------------------------------------------

function buildExtractArgs({ inputPath, framesDir, fps, targetWidth, sourceWidth }) {
  const args = ['-v', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', inputPath]
  const filters = []
  if (fps !== 'source') filters.push('fps=' + fps)
  if (targetWidth > 0 && targetWidth < sourceWidth) filters.push('scale=' + targetWidth + ':-2:flags=lanczos')
  if (filters.length > 0) args.push('-vf', filters.join(','))
  else if (fps === 'source') {
    // 不缩放、不重采样：显式声明 passthrough（ffmpeg 9 移除了旧参数 -vsync，等价语义）
  }
  if (fps === 'source') args.push('-fps_mode', 'passthrough')
  args.push(path.join(framesDir, '%06d.png'))
  return args
}

async function extractFrames({ job, signal, inputPath, framesDir, fps, targetWidth, sourceWidth, expectedFrames }) {
  await fsp.rm(framesDir, { recursive: true, force: true })
  await fsp.mkdir(framesDir, { recursive: true })
  const ffmpeg = tools.resolveRequired('ffmpeg')
  const args = buildExtractArgs({ inputPath, framesDir, fps, targetWidth, sourceWidth })
  const report = (frame) => {
    const total = Math.max(1, expectedFrames || 0)
    const ratio = Math.max(0, Math.min(1, frame / total))
    job.progress('extract', 8 + ratio * 47, '正在抽取视频帧（' + frame + (expectedFrames ? '/' + expectedFrames : '') + '）…')
  }
  let lastFrame = 0
  let result
  try {
    result = await tools.runProcess(ffmpeg, args, {
      signal,
      timeoutMs: EXTRACT_TIMEOUT_MS,
      onStdoutLine: (line) => {
        const match = line.match(/^frame=(\d+)/)
        if (match) {
          const frame = Number(match[1])
          if (frame !== lastFrame) {
            lastFrame = frame
            report(frame)
          }
        }
      },
    })
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    throw convertError('抽帧', 'ffmpeg 执行失败：' + (error && error.message ? error.message : String(error)), error)
  }
  if (result.code !== 0) {
    throw convertError('抽帧', tailOf(result) || 'ffmpeg 退出码 ' + result.code)
  }
  const entries = await fsp.readdir(framesDir)
  const frameFiles = entries.filter((name) => /\.png$/i.test(name)).sort()
  if (frameFiles.length === 0) throw convertError('抽帧', '没有抽取到任何视频帧（源文件可能没有视频轨）')
  return frameFiles
}

// ---------------------------------------------------------------------------
// 编码
// ---------------------------------------------------------------------------

function loopToRepeat(loopCount) {
  const value = Number(loopCount)
  if (!Number.isFinite(value)) return 0
  if (value < 0) return -1
  return Math.max(0, Math.round(value))
}

async function encodeWithGifski({ job, signal, framesDir, frameFiles, outputPath, nominalFps, quality, width, loopCount }) {
  const gifski = tools.resolveRequired('gifski')
  const args = [
    '-o', outputPath,
    '--fps', nominalFps.toFixed(3),
    '--quality', String(Math.round(quality)),
    '--repeat', String(loopToRepeat(loopCount)),
    '--no-sort',
  ]
  if (width > 0) args.push('--width', String(Math.round(width)))
  args.push(...frameFiles)
  let lastPercent = -1
  const report = (frame, total) => {
    const ratio = total > 0 ? Math.max(0, Math.min(1, frame / total)) : 0
    const percent = 55 + ratio * 35
    if (percent !== lastPercent) {
      lastPercent = percent
      job.progress('encode', percent, total > 0 ? '正在编码 GIF（' + frame + '/' + total + ' 帧）…' : '正在编码 GIF…')
    }
  }
  let result
  try {
    result = await tools.runProcess(gifski, args, {
      cwd: framesDir,
      signal,
      timeoutMs: ENCODE_TIMEOUT_MS,
      // gifski 1.32 把进度写到 stdout，且用 \r 刷新而不是换行
      onStdoutChunk: (chunk) => {
        const matches = String(chunk).matchAll(/Frame\s+(\d+)\s*\/\s*(\d+)/g)
        let found = false
        for (const match of matches) {
          found = true
          report(Number(match[1]), Number(match[2]))
        }
        if (!found) {
          const single = String(chunk).match(/Frame\s+(\d+)\s*\/\s*(\d+)/)
          if (single) report(Number(single[1]), Number(single[2]))
        }
      },
    })
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    throw convertError('编码', 'gifski 执行失败：' + (error && error.message ? error.message : String(error)), error)
  }
  if (result.code !== 0) {
    throw convertError('编码', 'gifski 退出码 ' + result.code + (tailOf(result) ? '：' + tailOf(result) : ''))
  }
  const stat = await fsp.stat(outputPath).catch(() => null)
  if (!stat || stat.size === 0) throw convertError('编码', 'gifski 没有生成 GIF 文件')
  job.progress('encode', 90, 'GIF 编码完成')
  return outputPath
}

async function encodeWithFfmpeg({ job, signal, framesDir, frameFiles, outputPath, nominalFps, quality, colors, dither, loopCount }) {
  const ffmpeg = tools.resolveRequired('ffmpeg')
  const palettePath = path.join(framesDir, 'palette.png')
  const frameRate = String(nominalFps)
  const inputPattern = path.join(framesDir, '%06d.png')
  const paletteArgs = [
    '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats',
    '-framerate', frameRate, '-i', inputPattern,
    '-vf', 'palettegen=stats_mode=diff:max_colors=' + Math.max(2, Math.min(256, Math.round(colors))),
    palettePath,
  ]
  let last = 0
  let result
  try {
    result = await tools.runProcess(ffmpeg, paletteArgs, {
      signal,
      timeoutMs: ENCODE_TIMEOUT_MS,
      onStdoutLine: (line) => {
        const match = line.match(/^frame=(\d+)/)
        if (match && Number(match[1]) !== last) {
          last = Number(match[1])
          const ratio = Math.max(0, Math.min(1, last / Math.max(1, frameFiles.length)))
          job.progress('encode', 55 + ratio * 15, '正在生成调色板…')
        }
      },
    })
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    throw convertError('编码', '调色板生成失败：' + (error && error.message ? error.message : String(error)), error)
  }
  if (result.code !== 0 || !fs.existsSync(palettePath)) throw convertError('编码', '调色板生成失败：' + (tailOf(result) || '未知错误'))

  const loop = loopToRepeat(loopCount)
  const ditherMode = ['sierra2_4a', 'bayer', 'none'].includes(dither) ? dither : 'sierra2_4a'
  const encodeArgs = [
    '-v', 'error', '-y', '-progress', 'pipe:1', '-nostats',
    '-framerate', frameRate, '-i', inputPattern,
    '-i', palettePath,
    '-lavfi', 'paletteuse=dither=' + ditherMode + ':diff_mode=rectangle',
    '-loop', String(loop),
    outputPath,
  ]
  try {
    result = await tools.runProcess(ffmpeg, encodeArgs, {
      signal,
      timeoutMs: ENCODE_TIMEOUT_MS,
      onStdoutLine: (line) => {
        const match = line.match(/^frame=(\d+)/)
        if (match && Number(match[1]) !== last) {
          last = Number(match[1])
          const ratio = Math.max(0, Math.min(1, last / Math.max(1, frameFiles.length)))
          job.progress('encode', 70 + ratio * 20, '正在用 ffmpeg 编码 GIF（' + last + '/' + frameFiles.length + ' 帧）…')
        }
      },
    })
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    throw convertError('编码', 'ffmpeg 编码失败：' + (error && error.message ? error.message : String(error)), error)
  }
  if (result.code !== 0) throw convertError('编码', 'ffmpeg 编码失败：' + (tailOf(result) || '退出码 ' + result.code))
  const stat = await fsp.stat(outputPath).catch(() => null)
  if (!stat || stat.size === 0) throw convertError('编码', 'ffmpeg 没有生成 GIF 文件')
  job.progress('encode', 90, 'GIF 编码完成')
  return outputPath
}

/**
 * 用 ffmpeg concat + libwebp_anim 编码动画 WebP。
 *
 * 说明：concat demuxer 的 duration 会被量化到图像输入约 40ms 的帧时长网格，
 * 且 \-fps_mode vfr 会因此丢帧（实测 94 帧源只剩 83 帧）；
 * 这里用 \-fps_mode passthrough 保留全部帧，编码后由 webp.patchDelays
 * 把 ANMF duration 改写为精确值（与 GIF 的 patchDelays 思路一致）。
 */
async function encodeWithWebp({ job, signal, framesDir, frameFiles, outputPath, delaysMs, quality, loopCount }) {
  const ffmpeg = tools.resolveRequired('ffmpeg')
  const listPath = path.join(framesDir, 'webp-concat.txt')
  const lines = []
  for (let index = 0; index < frameFiles.length; index += 1) {
    lines.push("file '" + frameFiles[index] + "'")
    lines.push('duration ' + ((Number(delaysMs[index]) || 0) / 1000).toFixed(6))
  }
  await fsp.writeFile(listPath, lines.join('\n') + '\n', 'utf8')
  const args = [
    '-v', 'error', '-y',
    '-progress', 'pipe:1', '-nostats',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'libwebp_anim',
    '-lossless', '0',
    '-q:v', String(Math.round(quality)),
    '-loop', String(loopToWebp(loopCount)),
    '-fps_mode', 'passthrough',
    outputPath,
  ]
  let lastFrame = 0
  let result
  try {
    result = await tools.runProcess(ffmpeg, args, {
      cwd: framesDir,
      signal,
      timeoutMs: ENCODE_TIMEOUT_MS,
      onStdoutLine: (line) => {
        const match = line.match(/^frame=(\d+)/)
        if (match && Number(match[1]) !== lastFrame) {
          lastFrame = Number(match[1])
          const ratio = Math.max(0, Math.min(1, lastFrame / Math.max(1, frameFiles.length)))
          job.progress('encode', 55 + ratio * 35, '正在编码 WebP（' + lastFrame + '/' + frameFiles.length + ' 帧）…')
        }
      },
    })
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    throw convertError('编码', 'ffmpeg 编码 WebP 失败：' + (error && error.message ? error.message : String(error)), error, 'WebP')
  }
  if (result.code !== 0) {
    throw convertError('编码', 'ffmpeg 编码 WebP 失败：' + (tailOf(result) || '退出码 ' + result.code), null, 'WebP')
  }
  const stat = await fsp.stat(outputPath).catch(() => null)
  if (!stat || stat.size === 0) throw convertError('编码', 'ffmpeg 没有生成 WebP 文件', null, 'WebP')
  job.progress('encode', 90, 'WebP 编码完成')
  return outputPath
}

// ---------------------------------------------------------------------------
// gifsicle 极限压缩（高级选项，默认关闭）
// ---------------------------------------------------------------------------

async function optimizeWithGifsicle({ job, signal, inputPath, outputPath, lossy, colors }) {
  const gifsicle = tools.resolve('gifsicle')
  if (!gifsicle) return null
  const args = ['-O3']
  const lossyValue = Math.round(Number(lossy) || 0)
  if (lossyValue > 0) args.push('--lossy=' + lossyValue)
  const colorValue = Math.round(Number(colors) || 256)
  if (colorValue < 256) args.push('--colors', String(Math.max(2, colorValue)))
  args.push(inputPath, '-o', outputPath)
  job.progress('optimize', 91, '正在用 gifsicle 压缩体积…')
  let result
  try {
    result = await tools.runProcess(gifsicle, args, { signal, timeoutMs: OPTIMIZE_TIMEOUT_MS })
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    return null
  }
  if (result.code !== 0) return null
  const stat = await fsp.stat(outputPath).catch(() => null)
  if (!stat || stat.size === 0) return null
  job.progress('optimize', 95, 'gifsicle 压缩完成')
  return outputPath
}

// ---------------------------------------------------------------------------
// 输出命名
// ---------------------------------------------------------------------------

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

const KNOWN_PRESETS = new Set(['source', 'balanced', 'small', 'mini'])

function presetSegment(presetId) {
  if (typeof presetId === 'string' && KNOWN_PRESETS.has(presetId)) return presetId
  return 'custom'
}

/**
 * 生成输出文件名：
 * <screenName>_<tweetId>_<media序号>_<宽>x<高>_<preset|custom>_<时间戳>.<gif|webp>
 * @param {{format?:('gif'|'webp')}} [payload] format 缺省 gif（兼容旧调用）
 */
function buildOutputFileName({ screenName, tweetId, mediaIndex, width, height, presetId, date, format }) {
  const screen = paths.safeName(screenName, 'x')
  const stamp = formatTimestamp(date || new Date())
  const mediaPart = paths.safeName(String(mediaIndex || 1), '1')
  const extension = format === 'webp' ? 'webp' : 'gif'
  return screen + '_' + tweetId + '_' + mediaPart + '_' + width + 'x' + height + '_' + presetSegment(presetId) + '_' + stamp + '.' + extension
}

async function uniquePath(dir, fileName) {
  let candidate = path.join(dir, fileName)
  let index = 2
  while (fs.existsSync(candidate)) {
    const ext = path.extname(fileName)
    candidate = path.join(dir, fileName.slice(0, -ext.length) + '-' + index + ext)
    index += 1
    if (index > 99) break
  }
  return candidate
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function mergeProgress(job) {
  return (progress) => {
    if (!progress) return
    let percent = 0
    if (progress.phase === 'download') percent = (Math.max(0, progress.percent) / 100) * 4
    else if (progress.phase === 'probe') percent = 4 + (Math.max(0, progress.percent) / 100) * 2
    else if (progress.phase === 'thumbnail') percent = 6 + (Math.max(0, progress.percent) / 100) * 2
    job.progress(progress.phase, percent, progress.message)
  }
}

function pickTwitterInfo(tweetId) {
  const cached = tweet.getCached(tweetId)
  return cached || null
}

function synthesizeTweetInfo(tweetId) {
  const cached = pickTwitterInfo(tweetId)
  if (cached) return cached
  return {
    id: tweetId,
    url: 'https://x.com/i/status/' + tweetId,
    author: { name: '', screenName: 'x', avatarUrl: null, verified: false },
    text: '',
    createdAt: null,
  }
}

/**
 * 执行一次 GIF 转换。
 * @param {{jobId?:string, tweetId:string, media:import('../src/shared/types').TweetMedia,
 *   params?:Partial<import('../src/shared/types').GifParams>, presetId?:string|null,
 *   onProgress?:(progress:import('../src/shared/types').JobProgress)=>void,
 *   mediaIndex?:number, force?:boolean, autoSave?:boolean}} request
 * @returns {Promise<import('../src/shared/types').GifResult>}
 */
async function convert(request = {}) {
  const { tweetId } = request
  const mediaItem = request.media
  if (!tweetId) throw convertError('准备', '缺少推文 id')
  if (!mediaItem || !mediaItem.sourceUrl) throw convertError('准备', '缺少要转换的媒体信息，请重新解析推文')
  if (mediaItem.kind === 'photo') throw convertError('准备', '图片不支持转换为 GIF，请选择 GIF 或视频')

  // 输出格式：缺省 gif；仅接受 gif / webp（与 src/shared/types.ts 的 AnimFormat 一致）
  const requestedFormat = request.format
  let format = 'gif'
  if (requestedFormat !== undefined && requestedFormat !== null && requestedFormat !== '') {
    if (requestedFormat !== 'gif' && requestedFormat !== 'webp') {
      throw convertError('准备', '不支持的输出格式：' + String(requestedFormat) + '（仅支持 gif / webp）')
    }
    format = requestedFormat
  }
  const formatLabel = format === 'webp' ? 'WebP' : 'GIF'

  const params = normalizeParams(request.params)
  const presetId = typeof request.presetId === 'string' && request.presetId ? request.presetId : null
  const job = new jobs.Job(request.jobId, 'gif', request.onProgress)
  const controller = new AbortController()
  const untrack = job.track({ kill: () => controller.abort() })
  const signal = controller.signal
  let stage = '准备'
  let framesDir = null

  try {
    job.progress('queued', 0, '正在准备转换任务…')

    // 1. 工具检查（GIF 默认用 gifski；WebP 只用 ffmpeg 的 libwebp_anim）
    const encoder = params.encoder === 'ffmpeg' ? 'ffmpeg' : 'gifski'
    if (format === 'gif' && encoder === 'gifski') tools.resolveRequired('gifski')
    tools.resolveRequired('ffmpeg')
    const gifsicleAvailable = format === 'gif' && Boolean(tools.resolve('gifsicle'))

    // 2. 准备媒体：优先复用「已保存的原始媒体」；autoSave 时若未保存则先保存
    stage = '准备媒体'
    job.progress('download', 0, '正在准备媒体…')
    let sourceSaved = null
    try {
      sourceSaved = await history.findSaved(String(tweetId), String(mediaItem.id))
    } catch {
      sourceSaved = null
    }
    if (sourceSaved && (!sourceSaved.filePath || !fs.existsSync(sourceSaved.filePath))) sourceSaved = null

    if (!sourceSaved && request.autoSave) {
      job.progress('download', 0, '正在自动保存源媒体…')
      const saveResult = await media.save({
        jobId: job.jobId,
        tweetId,
        media: mediaItem,
        job,
        signal,
        onProgress: (progress) => {
          // 自动保存进度映射到转换任务整体 0-8%
          let percent = 0
          if (progress.phase === 'download') percent = Math.max(0, progress.percent) * 0.05
          else if (progress.phase === 'probe') percent = 5 + Math.max(0, progress.percent) * 0.02
          else if (progress.phase === 'finalize' || progress.phase === 'done') percent = 7 + Math.max(0, progress.percent) * 0.01
          job.progress(progress.phase, Math.min(8, percent), progress.message)
        },
      })
      sourceSaved = saveResult.saved
      job.throwIfCancelled()
    }

    let prepared
    if (sourceSaved) {
      // 已保存媒体：直接探测输出目录中的原文件，不再重复下载
      job.progress('probe', 4, '使用已保存的原始媒体：' + sourceSaved.fileName)
      const savedProbe = await mp4probe.probe(sourceSaved.filePath)
      prepared = {
        mediaId: paths.safeName(String(mediaItem.id || 'media'), 'media'),
        localPath: sourceSaved.filePath,
        thumbnailPath: null,
        probe: savedProbe,
      }
    } else {
      prepared = await media.prepare({
        jobId: job.jobId,
        tweetId,
        media: mediaItem,
        job,
        signal,
        onProgress: mergeProgress(job),
        force: Boolean(request.force),
      })
    }
    job.throwIfCancelled()
    const sourceProbe = prepared.probe
    if (!(sourceProbe.frameCount > 0)) throw convertError('准备媒体', '源媒体没有可用的视频帧')

    // 3. 计算抽帧参数
    const sourceWidth = Math.max(1, sourceProbe.width)
    const sourceHeight = Math.max(1, sourceProbe.height)
    const targetWidth = params.width ? Math.min(sourceWidth, Math.max(16, Math.round(params.width))) : sourceWidth
    const fps = params.fps === 'source' ? 'source' : Math.max(1, Math.round(Number(params.fps) || 15))
    const avgMs = averageFrameDuration(sourceProbe.frameDurationsMs, sourceProbe.durationSec, sourceProbe.frameCount)
    const nominalFps = computeNominalFps(avgMs)
    const expectedFrames = fps === 'source' ? sourceProbe.frameCount : Math.max(1, Math.round(sourceProbe.durationSec * fps))

    // 4. 抽帧
    stage = '抽帧'
    const cacheDir = await settings.getCacheDir()
    const hash = crypto
      .createHash('sha1')
      .update(JSON.stringify({ mediaId: mediaItem.id, fps, targetWidth, timestamp: Date.now() }))
      .digest('hex')
      .slice(0, 10)
    framesDir = path.join(cacheDir, 'frames', prepared.mediaId + '-' + hash)
    job.progress('extract', 8, '开始抽取视频帧…')
    const frameFiles = await extractFrames({
      job,
      signal,
      inputPath: prepared.localPath,
      framesDir,
      fps,
      targetWidth,
      sourceWidth,
      expectedFrames,
    })
    job.throwIfCancelled()
    const actualFrames = frameFiles.length

    // 5. 计算逐帧延时
    //    必须以「源逐帧时长数组长度」为准（不能只看 sourceProbe.frameCount）：
    //    mp4probe 已保证 frameCount === frameDurationsMs.length，但这里仍对旧缓存/第三方数据兜底，
    //    避免出现「抽帧 84 帧却直接套用 86 个时长」的错配。
    stage = '计时'
    const preserveTiming = boolOr(params.preserveTiming, true) && fps === 'source'
    const delayPlan = resolveDelaysForFrames(sourceProbe, actualFrames, {
      fps,
      preserveTiming,
      speed: params.speed,
    })
    let delaysCs = delayPlan.delaysCs
    if (Array.isArray(sourceProbe.warnings) && sourceProbe.warnings.length > 0) {
      job.progress('probe', 70, sourceProbe.warnings[0])
    }
    job.progress(
      'extract',
      55,
      '抽帧完成：共 ' + actualFrames + ' 帧' + (preserveTiming && delayPlan.aligned ? '（源帧数不一致，已按时间比例对齐）' : ''),
    )

    // 6. 编码（GIF：gifski / ffmpeg 两遍法；WebP：ffmpeg concat + libwebp_anim）
    stage = '编码'
    const encodedPath = path.join(framesDir, format === 'webp' ? 'encoded.webp' : 'encoded.gif')
    job.progress('encode', 55, format === 'webp' ? '正在编码 WebP…' : '正在编码 GIF…')
    if (format === 'webp') {
      // WebP 忽略 colors/dither/optimize/encoder，只使用 params.quality
      await encodeWithWebp({
        job,
        signal,
        framesDir,
        frameFiles,
        outputPath: encodedPath,
        delaysMs: delaysCs.map((cs) => cs * 10),
        quality: params.quality,
        loopCount: params.loopCount,
      })
    } else if (encoder === 'gifski') {
      await encodeWithGifski({
        job,
        signal,
        framesDir,
        frameFiles,
        outputPath: encodedPath,
        nominalFps,
        quality: params.quality,
        width: targetWidth,
        loopCount: params.loopCount,
      })
    } else {
      await encodeWithFfmpeg({
        job,
        signal,
        framesDir,
        frameFiles,
        outputPath: encodedPath,
        nominalFps,
        quality: params.quality,
        colors: params.colors,
        dither: params.dither,
        loopCount: params.loopCount,
      })
    }
    job.throwIfCancelled()

    let finalSource = null
    let finalInfo = null
    let targetDelaysCs = delaysCs

    if (format === 'webp') {
      // 6W. WebP 编码后校验：帧数不对齐时按时间比例重分配，再把 ANMF 时长改写为精确毫秒
      stage = '编码校验'
      const encodedProbe = await webp.probe(encodedPath).catch((error) => {
        throw convertError('编码', '无法读取编码后的 WebP：' + (error && error.message ? error.message : String(error)), error, 'WebP')
      })
      if (!(encodedProbe.frameCount > 0)) throw convertError('编码', '编码器没有生成任何 WebP 帧', null, 'WebP')
      let targetDelaysMs = delaysCs.map((cs) => cs * 10)
      if (encodedProbe.frameCount !== targetDelaysMs.length) {
        targetDelaysMs = resolveDelaysForFrames(sourceProbe, encodedProbe.frameCount, {
          fps,
          preserveTiming,
          speed: params.speed,
        }).delaysCs.map((cs) => cs * 10)
        const message =
          '编码器帧数 ' + encodedProbe.frameCount + ' 与抽帧 ' + actualFrames + ' 不一致，已按时间比例还原时长'
        job.progress('encode', 90, message)
        job.progress('finalize', 90, message)
      }

      stage = '还原逐帧延时'
      const delayedWebpPath = path.join(framesDir, 'delayed.webp')
      job.progress('finalize', 90, '正在写入 WebP 逐帧延时…')
      await webp.patchDelays(encodedPath, delayedWebpPath, targetDelaysMs)
      finalSource = delayedWebpPath

      // 收尾校验：帧数必须与延时数量一致；总时长与期望差值 >50ms 视为失败
      stage = '收尾'
      job.progress('finalize', 96, '正在校验 WebP 输出…')
      let webpInfo = await webp.probe(finalSource)
      if (webpInfo.frameCount !== targetDelaysMs.length) {
        targetDelaysMs = resolveDelaysForFrames(sourceProbe, webpInfo.frameCount, {
          fps,
          preserveTiming,
          speed: params.speed,
        }).delaysCs.map((cs) => cs * 10)
        const repairedPath = path.join(framesDir, 'final-delays.webp')
        await webp.patchDelays(finalSource, repairedPath, targetDelaysMs)
        finalSource = repairedPath
        webpInfo = await webp.probe(finalSource)
        job.progress('finalize', 97, '最终帧数 ' + webpInfo.frameCount + ' 已重新分配逐帧延时')
      }
      if (webpInfo.frameCount !== targetDelaysMs.length) {
        throw convertError(
          '收尾',
          '输出 WebP 帧数（' + webpInfo.frameCount + '）与逐帧延时数量（' + targetDelaysMs.length + '）不一致；请重试或更换参数',
          null,
          'WebP',
        )
      }
      if (fps === 'source' && webpInfo.frameCount !== actualFrames) {
        job.progress('finalize', 97, '提示：编码器输出 ' + webpInfo.frameCount + ' 帧，与抽帧 ' + actualFrames + ' 帧不同（已按时间比例还原时长）')
      }
      const expectedDurationMs = targetDelaysMs.reduce((sum, ms) => sum + ms, 0)
      const durationDelta = Math.abs(webpInfo.frameDelaysMs.reduce((sum, ms) => sum + ms, 0) - expectedDurationMs)
      if (durationDelta > 50) {
        throw convertError('收尾', 'WebP 总时长与期望相差 ' + Math.round(durationDelta) + 'ms（超过 50ms）', null, 'WebP')
      }
      const sourceDelta = Math.abs(webpInfo.frameDelaysMs.reduce((sum, ms) => sum + ms, 0) - Number(sourceProbe.durationSec) * 1000)
      if (sourceDelta > 50) job.progress('finalize', 98, '提示：WebP 时长与源相差 ' + Math.round(sourceDelta) + 'ms')
      finalInfo = webpInfo
      targetDelaysCs = targetDelaysMs.map((ms) => Math.round(ms / 10))
    } else {
      // 6.5 编码器可能合并/跳过帧（例如相同帧被压缩合并）：以实际 GIF 帧数为准重新归一延时，
      //     避免「帧延时数量与 GIF 帧数不一致」直接失败。

    // 6.5 编码器可能合并/跳过帧（例如相同帧被压缩合并）：以实际 GIF 帧数为准重新归一延时，
    //     避免「帧延时数量与 GIF 帧数不一致」直接失败。
    stage = '编码校验'
    const encodedProbe = await gifprobe.probe(encodedPath).catch((error) => {
      throw convertError('编码', '无法读取编码后的 GIF：' + (error && error.message ? error.message : String(error)), error)
    })
    if (!(encodedProbe.frameCount > 0)) throw convertError('编码', '编码器没有生成任何 GIF 帧')
    const encodedFrames = encodedProbe.frameCount
    if (encodedFrames !== targetDelaysCs.length) {
      targetDelaysCs = resolveDelaysForFrames(sourceProbe, encodedFrames, {
        fps,
        preserveTiming,
        speed: params.speed,
      }).delaysCs
      const message =
        '编码器帧数 ' + encodedFrames + ' 与抽帧 ' + actualFrames + ' 不一致，已按时间比例还原时长'
      job.progress('encode', 90, message)
      job.progress('finalize', 90, message)
    }

    // 7. 按源时间戳还原延时（关键步骤）
    stage = '还原逐帧延时'
    const delayedPath = path.join(framesDir, 'delayed.gif')
    job.progress('finalize', 90, '正在还原逐帧延时…')
    await gifprobe.patchDelays(encodedPath, delayedPath, targetDelaysCs, {
      unit: 'cs',
      loopCount: params.loopCount,
      minCs: MIN_DELAY_CS,
    })
    finalSource = delayedPath

    // 8. 可选：gifsicle 极限压缩（默认关闭；实测会使高光颜色偏移，仅高级选项）
    if (params.optimize && gifsicleAvailable) {
      stage = '体积优化'
      const optimizedPath = path.join(framesDir, 'optimized.gif')
      const optimized = await optimizeWithGifsicle({
        job,
        signal,
        inputPath: delayedPath,
        outputPath: optimizedPath,
        lossy: params.lossy,
        colors: params.colors,
      })
      if (optimized) {
        const before = (await fsp.stat(delayedPath)).size
        const after = (await fsp.stat(optimized)).size
        if (after < before) {
          // gifsicle 可能重写延时/循环，也可能改变帧数：按优化后的实际帧数重新计算延时
          const optimizedInfo = await gifprobe.probe(optimized)
          let optimizedDelaysCs = targetDelaysCs
          if (optimizedInfo.frameCount !== optimizedDelaysCs.length) {
            optimizedDelaysCs = resolveDelaysForFrames(sourceProbe, optimizedInfo.frameCount, {
              fps,
              preserveTiming,
              speed: params.speed,
            }).delaysCs
            job.progress('optimize', 94, '优化后帧数 ' + optimizedInfo.frameCount + ' 有变化，已重新分配延时')
          }
          const expectedMs = optimizedDelaysCs.map((cs) => cs * 10)
          const expectedLoop = Number(params.loopCount) < 0 ? -1 : Math.round(Number(params.loopCount) || 0)
          const delaysOk =
            optimizedInfo.frameCount === expectedMs.length &&
            optimizedInfo.frameDelaysMs.every((value, index) => value === expectedMs[index])
          if (delaysOk && optimizedInfo.loopCount === expectedLoop) {
            finalSource = optimized
            targetDelaysCs = optimizedDelaysCs
            job.progress('optimize', 96, '体积优化完成：' + (after / 1024 / 1024).toFixed(2) + 'MB（原 ' + (before / 1024 / 1024).toFixed(2) + 'MB）')
          } else {
            await gifprobe.patchDelays(optimized, optimizedPath + '.fixed.gif', optimizedDelaysCs, { unit: 'cs', loopCount: params.loopCount, minCs: MIN_DELAY_CS })
            finalSource = optimizedPath + '.fixed.gif'
            targetDelaysCs = optimizedDelaysCs
            job.progress('optimize', 96, '体积优化完成并校正延时')
          }
        } else {
          job.progress('optimize', 96, '压缩后体积未减小，已回退未优化版本')
        }
      } else {
        job.progress('optimize', 92, 'gifsicle 不可用，跳过体积优化')
      }
    } else {
      job.progress('optimize', 92, '已跳过有损体积优化')
    }
    job.throwIfCancelled()

    // 9. 探测最终 GIF；帧数仍不一致时最后兜底一次（不再直接失败）
    stage = '收尾'
    job.progress('finalize', 96, '正在校验输出文件…')
    finalInfo = await gifprobe.probe(finalSource)
    if (finalInfo.frameCount !== targetDelaysCs.length) {
      targetDelaysCs = resolveDelaysForFrames(sourceProbe, finalInfo.frameCount, {
        fps,
        preserveTiming,
        speed: params.speed,
      }).delaysCs
      const repairedPath = path.join(framesDir, 'final-delays.gif')
      await gifprobe.patchDelays(finalSource, repairedPath, targetDelaysCs, {
        unit: 'cs',
        loopCount: params.loopCount,
        minCs: MIN_DELAY_CS,
      })
      finalSource = repairedPath
      finalInfo = await gifprobe.probe(finalSource)
      job.progress('finalize', 97, '最终帧数 ' + finalInfo.frameCount + ' 已重新分配逐帧延时')
    }
    if (finalInfo.frameCount !== targetDelaysCs.length) {
      throw convertError(
        '收尾',
        '输出 GIF 帧数（' + finalInfo.frameCount + '）与逐帧延时数量（' + targetDelaysCs.length + '）仍不一致；请重试或更换预设',
      )
    }
    if (fps === 'source' && finalInfo.frameCount !== actualFrames) {
      job.progress('finalize', 97, '提示：编码器输出 ' + finalInfo.frameCount + ' 帧，与抽帧 ' + actualFrames + ' 帧不同（已按时间比例还原时长）')
    }
    const expectedDurationMs = targetDelaysCs.reduce((sum, cs) => sum + cs * 10, 0)
    const durationDelta = Math.abs(finalInfo.frameDelaysMs.reduce((sum, ms) => sum + ms, 0) - expectedDurationMs)
    if (finalInfo.frameDelaysMs.some((ms) => ms < MIN_DELAY_CS * 10)) {
      throw convertError('收尾', '输出 GIF 存在小于 2cs 的帧延时')
    }
    if (durationDelta > 20 && preserveTiming) {
      // 精度自检（patchDelays 已按期望值写入，正常情况下误差应为 0）
      job.progress('finalize', 98, '提示：输出时长与源相差 ' + Math.round(durationDelta) + 'ms')
    }
    }

    // 10. 写入输出目录
    const outputDir = await settings.getOutputDir()
    const screenName = await media.resolveTweetScreenName(tweetId)
    const mediaIndex = request.mediaIndex || media.resolveMediaIndex(tweetId, mediaItem.id)
    const authorDir = path.join(outputDir, paths.safeName(screenName, 'x'))
    const tweetDir = path.join(authorDir, paths.safeName(tweetId, 'tweet'))
    await fsp.mkdir(tweetDir, { recursive: true })
    const fileName = buildOutputFileName({
      screenName,
      tweetId,
      mediaIndex,
      width: finalInfo.width,
      height: finalInfo.height,
      presetId,
      format,
      date: new Date(),
    })
    const targetPath = await uniquePath(tweetDir, fileName)
    const temporaryTarget = targetPath + '.tmp-' + process.pid
    await fsp.copyFile(finalSource, temporaryTarget)
    await fsp.rename(temporaryTarget, targetPath)

    // 11. 组装结果并写历史
    const stat = await fsp.stat(targetPath)
    const info = {
      path: targetPath,
      fileName: path.basename(targetPath),
      width: finalInfo.width,
      height: finalInfo.height,
      sizeBytes: stat.size,
      frameCount: finalInfo.frameCount,
      durationSec: Math.round((finalInfo.frameDelaysMs.reduce((sum, ms) => sum + ms, 0) / 1000) * 1000) / 1000,
      fps: Math.round((finalInfo.frameCount / Math.max(0.001, finalInfo.frameDelaysMs.reduce((sum, ms) => sum + ms, 0) / 1000)) * 1000) / 1000,
      frameDelaysMs: finalInfo.frameDelaysMs,
    }
    const result = {
      id: crypto.randomUUID(),
      tweetId: String(tweetId),
      mediaId: mediaItem.id,
      gifPath: targetPath,
      format,
      info,
      params,
      presetId,
      createdAt: new Date().toISOString(),
      copies: [],
      sourceProbe,
      sourceSaved: sourceSaved || null,
    }
    try {
      await history.recordResult({
        tweetInfo: synthesizeTweetInfo(tweetId),
        media: mediaItem,
        prepared,
        result,
      })
    } catch (error) {
      // 历史写入失败不影响动图交付
      job.progress('finalize', 98, formatLabel + ' 已生成，但历史记录写入失败')
    }
    job.progress('finalize', 100, formatLabel + ' 转换完成')
    job.progress('done', 100, formatLabel + ' 已保存：' + info.fileName)
    return result
  } catch (error) {
    if (error && (error.code === 'CANCELLED' || (signal && signal.aborted))) {
      const cancelled = new Error('任务已取消')
      cancelled.code = 'CANCELLED'
      job.progress('cancelled', 0, '任务已取消')
      throw cancelled
    }
    if (error && error.code === 'TOOLS_MISSING') {
      job.progress('error', 0, error.message)
      throw error
    }
    const prefix = formatLabel + ' 转换失败'
    const wrapped =
      error && typeof error.code === 'string' && error.message && error.message.indexOf(prefix) === 0
        ? error
        : convertError(stage, error && error.message ? error.message : String(error), error, formatLabel)
    job.progress('error', 0, wrapped.message)
    throw wrapped
  } finally {
    untrack()
    if (framesDir) {
      try {
        await fsp.rm(framesDir, { recursive: true, force: true })
      } catch {
        /* 忽略临时目录清理失败 */
      }
    }
    job.finish()
  }
}

function boolOr(value, fallback) {
  if (typeof value === 'boolean') return value
  return fallback
}

/** 读取文件头判断是否为 WebP（RIFF....WEBP） */
async function isWebpFile(filePath) {
  if (/\.webp$/i.test(filePath)) return true
  let handle = null
  try {
    handle = await fsp.open(filePath, 'r')
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, 12, 0)
    if (bytesRead < 12) return false
    return header.toString('latin1', 0, 4) === 'RIFF' && header.toString('latin1', 8, 12) === 'WEBP'
  } catch {
    return false
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/**
 * 读取动图信息（GIF 或动画 WebP；按扩展名/文件头识别）。
 * @param {string} filePath
 * @returns {Promise<import('../src/shared/types').GifInfo>}
 */
async function info(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('缺少动图文件路径')
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat || !stat.isFile()) throw new Error('动图文件不存在或已被移动：' + filePath)
  const probed = (await isWebpFile(filePath)) ? await webp.probe(filePath) : await gifprobe.probe(filePath)
  const totalMs = probed.frameDelaysMs.reduce((sum, ms) => sum + ms, 0)
  return {
    path: path.resolve(filePath),
    fileName: path.basename(filePath),
    width: probed.width,
    height: probed.height,
    sizeBytes: stat.size,
    frameCount: probed.frameCount,
    durationSec: Math.round((totalMs / 1000) * 1000) / 1000,
    fps: totalMs > 0 ? Math.round((probed.frameCount / (totalMs / 1000)) * 1000) / 1000 : 0,
    frameDelaysMs: probed.frameDelaysMs,
  }
}

module.exports = {
  convert,
  info,
  computeDelaysCs,
  computeNominalFps,
  groupDurations,
  alignFrameDurations,
  resolveDelaysForFrames,
  buildOutputFileName,
  buildExtractArgs,
  MIN_DELAY_CS,
}
