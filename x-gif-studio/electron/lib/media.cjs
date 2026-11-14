'use strict'

/**
 * 媒体能力：
 * - prepare：下载/缓存源媒体（mp4）→ 纯 JS 探测 → ffmpeg 缩略图（PreparedMedia）；
 * - save：把原始媒体保存到输出目录（视频/GIF 为 mp4，图片为 jpg/png/gif/webp），并写入历史 savedMedia；
 *
 * 网络请求统一走 network.cjs（Electron 下 net.fetch 自动经过 session 代理；纯 Node 退化为全局 fetch），
 * 流式下载并上报进度；网络错误自动重试（视频最多 3 次），错误信息为中文；
 * 支持 jobs.Job 取消（AbortController + 子进程登记）；也可由调用方传入 job/signal 复用同一个任务。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const network = require('./network.cjs')
const paths = require('./paths.cjs')
const settings = require('./settings.cjs')
const tools = require('./tools.cjs')
const mp4probe = require('./mp4probe.cjs')
const tweet = require('./tweet.cjs')
const history = require('./history.cjs')
const { Job } = require('./jobs.cjs')

const DOWNLOAD_TIMEOUT_MS = 120000
const MAX_ATTEMPTS = 3
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024
const IMAGE_SAVE_TIMEOUT_MS = 60000
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

function mediaError(message, code) {
  const error = new Error(message)
  error.code = code || 'MEDIA_PREPARE_FAILED'
  return error
}

function throwIfCancelled(signal, job) {
  if (job && job.cancelled) {
    const error = mediaError('任务已取消', 'CANCELLED')
    throw error
  }
  if (signal && signal.aborted) {
    const error = mediaError('任务已取消', 'CANCELLED')
    throw error
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把 fetch Response 的 body 流式写入文件。
 * 兼容三种实现，保证 network.fetch 在 Node 全局 fetch 与 Electron net.fetch 下都可用：
 * 1) 标准 Web ReadableStream（Node 全局 fetch / Electron net.fetch）→ getReader()；
 * 2) Node Readable / 自定义 async iterable（个别运行时）→ for await；
 * 3) 没有可流式 body（或环境不支持）→ 退化为 arrayBuffer() 一次性写入。
 * @returns {Promise<number>} 写入的字节数
 */
async function writeBodyToFile(response, handle, options = {}) {
  const { total = 0, maxBytes = MAX_DOWNLOAD_BYTES, onProgress } = options
  let received = 0
  let lastPercent = -1
  let lastReportAt = 0

  const report = () => {
    if (typeof onProgress !== 'function') return
    const percent = total > 0 ? Math.min(100, (received / total) * 100) : -1
    const now = Date.now()
    if (percent !== lastPercent || now - lastReportAt > 400) {
      lastPercent = percent
      lastReportAt = now
      onProgress(percent, received, total)
    }
  }

  const append = async (chunk) => {
    if (!chunk || chunk.length === 0) return
    received += chunk.length
    if (received > maxBytes) {
      const error = mediaError('媒体文件过大（超过 600MB），暂不支持转换', 'MEDIA_TOO_LARGE')
      error.permanent = true
      throw error
    }
    await handle.write(chunk)
    report()
  }

  const body = response && response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await append(value)
    }
    return received
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      await append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return received
  }
  if (response && typeof response.arrayBuffer === 'function') {
    await append(Buffer.from(await response.arrayBuffer()))
    return received
  }
  throw mediaError('当前网络环境不支持流式下载，请检查代理/网络设置后重试', 'MEDIA_DOWNLOAD_FAILED')
}

/**
 * 流式下载单个文件（内部使用；失败抛中文错误）。
 * @param {string} url
 * @param {string} destPath
 * @param {{onProgress?:(percent:number, received:number, total:number)=>void, signal?:AbortSignal, timeoutMs?:number}} options
 */
async function downloadOnce(url, destPath, options = {}) {
  const { onProgress, signal, timeoutMs = DOWNLOAD_TIMEOUT_MS } = options
  await fsp.mkdir(path.dirname(destPath), { recursive: true })
  const temporary = destPath + '.part-' + process.pid + '-' + Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onCallerAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw mediaError('任务已取消', 'CANCELLED')
    }
    signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  let handle = null
  try {
    let response
    try {
      response = await network.fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5' },
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw mediaError(signal && signal.aborted ? '任务已取消' : '下载超时（120 秒），请检查网络后重试', signal && signal.aborted ? 'CANCELLED' : 'DOWNLOAD_TIMEOUT')
      }
      const wrapped = mediaError('网络连接失败，无法下载媒体：' + (error && error.message ? error.message : String(error)), 'NETWORK_ERROR')
      wrapped.retryable = true
      throw wrapped
    }
    if (response.status === 404 || response.status === 403 || response.status === 410) {
      const error = mediaError('媒体文件不存在或已过期（HTTP ' + response.status + '），请重新解析推文', 'MEDIA_UNAVAILABLE')
      error.permanent = true
      throw error
    }
    if (response.status === 429 || response.status >= 500) {
      const error = mediaError('媒体服务器暂时不可用（HTTP ' + response.status + '），正在重试…', 'MEDIA_SERVER_ERROR')
      error.retryable = true
      throw error
    }
    if (!response.ok) {
      const error = mediaError('媒体下载失败（HTTP ' + response.status + '）', 'MEDIA_DOWNLOAD_FAILED')
      error.permanent = true
      throw error
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) {
      const error = mediaError('媒体下载被拒绝（返回了网页而不是视频文件），请稍后重试', 'MEDIA_DOWNLOAD_FAILED')
      error.permanent = true
      throw error
    }
    const total = Number(response.headers.get('content-length')) || 0
    if (total > MAX_DOWNLOAD_BYTES) {
      const error = mediaError('媒体文件过大（超过 600MB），暂不支持转换', 'MEDIA_TOO_LARGE')
      error.permanent = true
      throw error
    }
    handle = await fsp.open(temporary, 'w')
    const received = await writeBodyToFile(response, handle, { total, onProgress })
    await handle.close()
    handle = null
    if (received === 0) {
      const error = mediaError('下载到的媒体文件为空，请稍后重试', 'MEDIA_DOWNLOAD_FAILED')
      error.retryable = true
      throw error
    }
    await fsp.rename(temporary, destPath)
    if (onProgress) onProgress(100, received, total || received)
    return { path: destPath, sizeBytes: received }
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {
        /* 忽略关闭失败 */
      }
    }
    try {
      await fsp.rm(temporary, { force: true })
    } catch {
      /* 忽略清理失败 */
    }
    if (error && error.code) throw error
    if (controller.signal.aborted || (error && error.name === 'AbortError')) {
      // 外部取消优先；否则是下载超时（Chromium net.fetch 在部分失败场景会抛普通 Error）
      const cancelled = Boolean(signal && signal.aborted)
      throw mediaError(
        cancelled ? '任务已取消' : '下载超时（120 秒），请检查网络或代理后重试',
        cancelled ? 'CANCELLED' : 'DOWNLOAD_TIMEOUT',
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * 带重试的下载。
 * @param {string} url
 * @param {string} destPath
 * @param {((percent:number, received:number, total:number)=>void)|null} onProgress
 * @param {AbortSignal|null} signal
 * @param {{retries?:number, timeoutMs?:number}} options
 */
async function download(url, destPath, onProgress, signal, options = {}) {
  const attempts = Math.max(1, options.retries || MAX_ATTEMPTS)
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal && signal.aborted) throw mediaError('任务已取消', 'CANCELLED')
    try {
      return await downloadOnce(url, destPath, { onProgress, signal, timeoutMs: options.timeoutMs || DOWNLOAD_TIMEOUT_MS })
    } catch (error) {
      lastError = error
      if (error && (error.code === 'CANCELLED' || error.permanent)) throw error
      if (attempt < attempts) await delay(500 * attempt)
    }
  }
  throw lastError || mediaError('媒体下载失败', 'MEDIA_DOWNLOAD_FAILED')
}

// ---------------------------------------------------------------------------
// 输出目录命名（与 gif.cjs 共用）
// ---------------------------------------------------------------------------

/** 推文作者 screen_name：优先解析缓存，其次历史记录，最后兜底 x */
async function resolveTweetScreenName(tweetId) {
  const cached = tweet.getCached(tweetId)
  if (cached && cached.author && cached.author.screenName) return cached.author.screenName
  try {
    const entry = await history.get(tweetId)
    if (entry && entry.author && entry.author.screenName) return entry.author.screenName
  } catch {
    /* 历史读取失败不影响保存 */
  }
  return 'x'
}

/** 媒体在推文中的序号（从 1 开始；用于文件名，与 gif.cjs 一致） */
function resolveMediaIndex(tweetId, mediaId) {
  const cached = tweet.getCached(tweetId)
  if (cached && Array.isArray(cached.media)) {
    const index = cached.media.findIndex((item) => item && item.id === mediaId)
    if (index >= 0) return index + 1
  }
  return 1
}

function savedMediaId(tweetId, mediaId, format) {
  return String(tweetId) + ':' + String(mediaId) + ':' + format
}

/** 文件名：<author>_<tweetId>_<mediaIndex>_<WxH>.<ext> */
function buildSaveFileName(payload = {}) {
  const screen = paths.safeName(payload.screenName, 'x')
  const width = Number(payload.width) > 0 ? Math.round(Number(payload.width)) : 0
  const height = Number(payload.height) > 0 ? Math.round(Number(payload.height)) : 0
  const size = width > 0 && height > 0 ? width + 'x' + height : 'media'
  const index = paths.safeName(String(payload.mediaIndex || 1), '1')
  return screen + '_' + String(payload.tweetId) + '_' + index + '_' + size + '.' + String(payload.ext || 'mp4')
}

/** 若目标目录已有同名文件（且没有历史记录可覆盖）则追加 -2/-3，避免误覆盖其他媒体 */
async function uniqueSavePath(dir, fileName) {
  let candidate = path.join(dir, fileName)
  let index = 2
  while (fs.existsSync(candidate)) {
    const ext = path.extname(fileName)
    candidate = path.join(dir, fileName.slice(0, -ext.length) + '-' + index + ext)
    index += 1
    if (index > 99) return path.join(dir, fileName + '-' + Date.now() + path.extname(fileName))
  }
  return candidate
}

/**
 * 把文件复制到输出目录：先写到 .part 临时名，再原子 rename 到目标（目标已存在时先删除）。
 * 默认只复制、不移动源文件——媒体保存必须保留 cache/media 下的原始 mp4 缓存；
 * options.move=true 仅作为特殊场景（如测试/迁移）的显式选项。
 */
async function placeFile(sourcePath, targetPath, options = {}) {
  const move = options.move === true
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  const temporary = targetPath + '.part-' + process.pid + '-' + Date.now()
  try {
    let moved = false
    if (move) {
      try {
        await fsp.rename(sourcePath, temporary)
        moved = true
      } catch {
        moved = false
      }
    }
    if (!moved) await fsp.copyFile(sourcePath, temporary)
    await fsp.rm(targetPath, { force: true })
    await fsp.rename(temporary, targetPath)
    return targetPath
  } catch (error) {
    try {
      await fsp.rm(temporary, { force: true })
    } catch {
      /* 忽略清理失败 */
    }
    throw error
  }
}

async function writeBufferAtomically(targetPath, buffer) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  const temporary = targetPath + '.part-' + process.pid + '-' + Date.now()
  try {
    await fsp.writeFile(temporary, buffer)
    await fsp.rm(targetPath, { force: true })
    await fsp.rename(temporary, targetPath)
  } catch (error) {
    try {
      await fsp.rm(temporary, { force: true })
    } catch {
      /* 忽略清理失败 */
    }
    throw error
  }
  return targetPath
}

// ---------------------------------------------------------------------------
// 图片：格式识别 / 尺寸解析 / 下载
// ---------------------------------------------------------------------------

/** 按魔数识别图片格式；无法识别返回 null */
function detectImageFormat(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'png'
  if (buffer.toString('latin1', 0, 4) === 'GIF8') return 'gif'
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

function parseJpegDimensions(buffer) {
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      if (offset + 9 > buffer.length) return null
      const height = buffer.readUInt16BE(offset + 5)
      const width = buffer.readUInt16BE(offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += 2 + length
  }
  return null
}

/** 解析图片宽高；无法解析时返回 { width:null, height:null } */
function parseImageDimensions(buffer, format) {
  try {
    if (format === 'jpg') return parseJpegDimensions(buffer) || { width: null, height: null }
    if (format === 'png') {
      if (buffer.length < 24) return { width: null, height: null }
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (format === 'gif') {
      if (buffer.length < 10) return { width: null, height: null }
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    if (format === 'webp') {
      if (buffer.length < 30) return { width: null, height: null }
      const chunk = buffer.toString('latin1', 12, 16)
      if (chunk === 'VP8X') {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
      }
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        if (buffer.length < 25) return { width: null, height: null }
        const bits = buffer.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      }
      return { width: null, height: null }
    }
  } catch {
    return { width: null, height: null }
  }
  return { width: null, height: null }
}

/** 下载图片到内存（带 60s 超时、50MB 上限、进度与取消） */
async function downloadImageBuffer(url, options = {}) {
  const { signal, onProgress, timeoutMs = IMAGE_SAVE_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onCallerAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw mediaError('任务已取消', 'CANCELLED')
    }
    signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  try {
    let response
    try {
      response = await network.fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: 'image/*,*/*;q=0.8' },
      })
    } catch (error) {
      if (controller.signal.aborted) {
        const cancelled = Boolean(signal && signal.aborted)
        throw mediaError(
          cancelled ? '任务已取消' : '图片下载超时（60 秒），请检查网络或代理后重试',
          cancelled ? 'CANCELLED' : 'DOWNLOAD_TIMEOUT',
        )
      }
      throw mediaError('网络连接失败，无法下载图片：' + (error && error.message ? error.message : String(error)), 'NETWORK_ERROR')
    }
    if (response.status === 404 || response.status === 403 || response.status === 410) {
      throw mediaError('图片不存在或已过期（HTTP ' + response.status + '），请重新解析推文', 'MEDIA_UNAVAILABLE')
    }
    if (!response.ok) {
      throw mediaError('图片下载失败（HTTP ' + response.status + '）', 'MEDIA_DOWNLOAD_FAILED')
    }
    const contentType = String((response.headers && response.headers.get && response.headers.get('content-type')) || '').toLowerCase()
    if (contentType.includes('text/html')) {
      throw mediaError('图片下载被拒绝（返回了网页而不是图片）', 'MEDIA_DOWNLOAD_FAILED')
    }
    const contentLength = Number((response.headers && response.headers.get && response.headers.get('content-length')) || 0)
    if (contentLength > maxBytes) throw mediaError('图片过大（超过 50MB），暂不支持保存', 'MEDIA_TOO_LARGE')
    const chunks = []
    let received = 0
    let lastPercent = -1
    const report = () => {
      if (typeof onProgress !== 'function') return
      const percent = contentLength > 0 ? Math.min(100, (received / contentLength) * 100) : -1
      if (percent !== lastPercent) {
        lastPercent = percent
        onProgress(percent, received, contentLength)
      }
    }
    const append = (chunk) => {
      if (!chunk || chunk.length === 0) return
      received += chunk.length
      if (received > maxBytes) throw mediaError('图片过大（超过 50MB），暂不支持保存', 'MEDIA_TOO_LARGE')
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      report()
    }
    const body = response.body
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        append(value)
      }
    } else if (body && typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) append(chunk)
    } else if (typeof response.arrayBuffer === 'function') {
      append(Buffer.from(await response.arrayBuffer()))
    } else {
      throw mediaError('当前网络环境不支持下载图片', 'MEDIA_DOWNLOAD_FAILED')
    }
    if (received === 0) throw mediaError('下载到的图片为空，请稍后重试', 'MEDIA_DOWNLOAD_FAILED')
    return Buffer.concat(chunks)
  } catch (error) {
    if (error && error.code) throw error
    if (controller.signal.aborted) {
      const cancelled = Boolean(signal && signal.aborted)
      throw mediaError(
        cancelled ? '任务已取消' : '图片下载超时（60 秒），请检查网络或代理后重试',
        cancelled ? 'CANCELLED' : 'DOWNLOAD_TIMEOUT',
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onCallerAbort)
  }
}

// ---------------------------------------------------------------------------
// 保存原始媒体到输出目录
// ---------------------------------------------------------------------------

/**
 * 保存原始媒体（视频/GIF 的 mp4，或图片）。
 * @param {{jobId?:string, tweetId:string, media:object, force?:boolean, mediaIndex?:number,
 *   job?:object, signal?:AbortSignal, onProgress?:Function}} request
 * @returns {Promise<{saved:object, newFile:boolean}>}
 */
async function save(request = {}) {
  const { jobId, tweetId, media } = request
  if (!tweetId) throw mediaError('缺少推文 id，无法保存媒体', 'INVALID_MEDIA')
  if (!media || typeof media !== 'object' || !media.sourceUrl) {
    throw mediaError('缺少要保存的媒体信息，请重新解析推文', 'INVALID_MEDIA')
  }
  const tweetInfo = tweet.getCached(tweetId)
  if (!tweetInfo) throw mediaError('请先解析推文后再保存媒体', 'TWEET_NOT_FOUND')

  const externalJob = request.job || null
  const onProgress = typeof request.onProgress === 'function' ? request.onProgress : null
  const ownJob = externalJob ? null : new Job(jobId, 'save', onProgress)
  const job = externalJob || ownJob
  const emit = (phase, percent, message) => {
    if (externalJob && onProgress) {
      onProgress({ jobId: job.jobId, scope: 'save', phase, percent, message })
      return
    }
    job.progress(phase, percent, message)
  }

  const controller = new AbortController()
  const signal = request.signal || controller.signal
  const untrack = request.signal ? () => {} : job.track({ kill: () => controller.abort() })
  const tweetIdText = String(tweetId)
  const mediaId = String(media.id || 'media-1')
  const isPhoto = media.kind === 'photo'
  let pendingTemporary = null

  try {
    // 命中已有保存记录（且文件存在）时直接复用，除非 force
    if (!request.force) {
      const reused = await history.findSaved(tweetIdText, mediaId)
      if (reused && reused.filePath && fs.existsSync(reused.filePath)) {
        emit('finalize', 100, '媒体已保存过，直接复用')
        emit('done', 100, reused.fileName)
        return { saved: reused, newFile: false }
      }
    }

    const outputDir = await settings.getOutputDir()
    const screenName = await resolveTweetScreenName(tweetIdText)
    const mediaIndex = Number.isFinite(Number(request.mediaIndex)) && Number(request.mediaIndex) > 0
      ? Math.round(Number(request.mediaIndex))
      : resolveMediaIndex(tweetIdText, mediaId)
    const authorDir = path.join(outputDir, paths.safeName(screenName, 'x'))
    const tweetDir = path.join(authorDir, paths.safeName(tweetIdText, 'tweet'))
    await fsp.mkdir(tweetDir, { recursive: true })
    throwIfCancelled(signal, job)

    if (!isPhoto) {
      emit('download', 0, '正在准备视频/GIF 媒体…')
      const prepared = await prepare({
        jobId: job.jobId,
        tweetId: tweetIdText,
        media,
        job,
        signal,
        onProgress: (progress) => {
          let percent = 0
          if (progress.phase === 'download') percent = Math.max(0, progress.percent) * 0.6
          else if (progress.phase === 'probe') percent = 60 + Math.max(0, progress.percent) * 0.1
          else if (progress.phase === 'thumbnail') percent = 70 + Math.max(0, progress.percent) * 0.1
          emit(progress.phase, Math.min(85, percent), progress.message)
        },
      })
      throwIfCancelled(signal, job)
      const probe = prepared.probe
      const existing = await history.findSaved(tweetIdText, mediaId, 'mp4')
      const fileName = buildSaveFileName({ screenName, tweetId: tweetIdText, mediaIndex, width: probe.width, height: probe.height, ext: 'mp4' })
      const targetPath = existing ? existing.filePath : await uniqueSavePath(tweetDir, fileName)
      emit('finalize', 88, '正在写入输出目录…')
      pendingTemporary = targetPath
      // 始终 copyFile：保留 cache/media 下的原始 mp4 缓存（settings.keepOriginalMp4 语义），
      // 不移动/删除缓存文件；缓存上限仍由缓存清理逻辑管理。
      await placeFile(prepared.localPath, targetPath, { move: false })
      pendingTemporary = null
      const stat = await fsp.stat(targetPath)
      const saved = {
        id: savedMediaId(tweetIdText, mediaId, 'mp4'),
        tweetId: tweetIdText,
        mediaId,
        mediaKind: media.kind,
        format: 'mp4',
        filePath: targetPath,
        fileName: path.basename(targetPath),
        width: probe.width,
        height: probe.height,
        durationSec: Math.round(probe.durationSec * 1000) / 1000,
        sizeBytes: stat.size,
        createdAt: new Date().toISOString(),
      }
      await history.recordSaved({ tweetInfo, media, saved, probe })
      emit('finalize', 100, '已保存：' + saved.fileName)
      emit('done', 100, '媒体已保存')
      return { saved, newFile: true }
    }

    // 图片：下载到内存 → 魔数识别格式/宽高 → 写输出目录
    emit('download', 0, '正在下载图片…')
    const imageBuffer = await downloadImageBuffer(media.sourceUrl, {
      signal,
      timeoutMs: IMAGE_SAVE_TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES,
      onProgress: (percent) => {
        emit('download', percent < 0 ? 30 : Math.max(0, Math.min(88, percent * 0.88)), percent < 0 ? '正在下载图片…' : '正在下载图片 ' + Math.round(percent) + '%')
      },
    })
    throwIfCancelled(signal, job)
    emit('probe', 90, '正在识别图片格式与尺寸…')
    const format = detectImageFormat(imageBuffer)
    if (!format) throw mediaError('无法识别的图片格式（支持 JPG / PNG / GIF / WebP）', 'UNSUPPORTED_MEDIA')
    const dimensions = parseImageDimensions(imageBuffer, format)
    const existing = await history.findSaved(tweetIdText, mediaId)
    const fileName = buildSaveFileName({
      screenName,
      tweetId: tweetIdText,
      mediaIndex,
      width: dimensions.width,
      height: dimensions.height,
      ext: format,
    })
    const targetPath = existing ? existing.filePath : await uniqueSavePath(tweetDir, fileName)
    emit('finalize', 94, '正在写入输出目录…')
    pendingTemporary = targetPath
    await writeBufferAtomically(targetPath, imageBuffer)
    pendingTemporary = null
    const stat = await fsp.stat(targetPath)
    const saved = {
      id: savedMediaId(tweetIdText, mediaId, format),
      tweetId: tweetIdText,
      mediaId,
      mediaKind: media.kind,
      format,
      filePath: targetPath,
      fileName: path.basename(targetPath),
      width: dimensions.width || null,
      height: dimensions.height || null,
      durationSec: null,
      sizeBytes: stat.size,
      createdAt: new Date().toISOString(),
    }
    if (existing && existing.id !== saved.id) {
      // 之前保存过不同格式（例如 png→jpg）：清理旧记录，避免历史出现指向不存在文件的重复项
      try {
        await history.removeSaved(tweetIdText, existing.id)
      } catch {
        /* 忽略 */
      }
    }
    await history.recordSaved({ tweetInfo, media, saved, probe: null })
    emit('finalize', 100, '已保存：' + saved.fileName)
    emit('done', 100, '图片已保存')
    return { saved, newFile: true }
  } catch (error) {
    if (pendingTemporary) {
      try {
        await fsp.rm(pendingTemporary + '.part-' + process.pid + '-' + Date.now(), { force: true })
      } catch {
        /* 忽略 */
      }
    }
    if (error && error.code === 'CANCELLED') throw error
    if (error && error.code) throw error
    throw mediaError('媒体保存失败：' + (error && error.message ? error.message : String(error)), 'MEDIA_SAVE_FAILED')
  } finally {
    untrack()
    if (ownJob) ownJob.finish()
  }
}

/** 用 ffmpeg 抽首帧生成缩略图（宽度不超过 640，失败不阻塞转换） */
async function makeThumbnail(localPath, thumbnailPath, signal, job) {
  const ffmpeg = tools.resolve('ffmpeg')
  if (!ffmpeg) return null
  try {
    await fsp.mkdir(path.dirname(thumbnailPath), { recursive: true })
    const temporary = thumbnailPath + '.tmp-' + process.pid + '.jpg'
    await tools.runProcess(
      ffmpeg,
      [
        '-v', 'error', '-y',
        '-i', localPath,
        '-frames:v', '1',
        '-vf', "scale=w='min(640,iw)':h=-2:flags=lanczos",
        '-q:v', '3',
        temporary,
      ],
      {
        timeoutMs: 30000,
        signal,
        onStderrLine: (line) => {
          if (line && job) job.progress('thumbnail', 80, '正在生成缩略图…')
        },
      },
    )
    const stat = await fsp.stat(temporary)
    if (!stat.size) throw new Error('缩略图为空')
    await fsp.rename(temporary, thumbnailPath)
    return thumbnailPath
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    return null
  }
}

/**
 * 准备媒体：下载 → 探测 → 缩略图。
 * @param {{jobId?:string, tweetId?:string, media:import('../src/shared/types').TweetMedia,
 *   onProgress?:(progress:import('../src/shared/types').JobProgress)=>void,
 *   job?:import('./jobs.cjs').Job, signal?:AbortSignal, force?:boolean}} request
 * @returns {Promise<import('../src/shared/types').PreparedMedia>}
 */
async function prepare(request = {}) {
  const { jobId, tweetId, media } = request
  if (!media || typeof media !== 'object' || !media.sourceUrl) {
    throw mediaError('缺少要准备的媒体信息，请重新解析推文', 'INVALID_MEDIA')
  }
  if (media.kind === 'photo') {
    throw mediaError('图片不支持转换为 GIF，请选择 GIF 或视频', 'UNSUPPORTED_MEDIA')
  }
  const externalJob = request.job || null
  const onProgress = typeof request.onProgress === 'function' ? request.onProgress : null
  const ownJob = externalJob ? null : new Job(jobId, 'media', onProgress)
  const job = externalJob || ownJob
  const emitProgress = (phase, percent, message) => {
    if (externalJob && onProgress) {
      onProgress({ jobId: job.jobId, scope: 'media', phase, percent, message })
      return
    }
    job.progress(phase, percent, message)
  }

  const internalController = new AbortController()
  const signal = request.signal || internalController.signal
  const untrack = request.signal ? () => {} : job.track({ kill: () => internalController.abort() })

  try {
    const cacheDir = await settings.getCacheDir()
    const mediaDir = path.join(cacheDir, 'media')
    const thumbsDir = path.join(cacheDir, 'thumbs')
    await fsp.mkdir(mediaDir, { recursive: true })
    await fsp.mkdir(thumbsDir, { recursive: true })
    const mediaId = paths.safeName(media.id, 'media')
    const localPath = path.join(mediaDir, mediaId + '.mp4')
    const thumbnailPath = path.join(thumbsDir, mediaId + '.jpg')

    throwIfCancelled(signal, job)
    emitProgress('download', 0, '正在检查本地缓存…')
    let cached = false
    if (!request.force) {
      try {
        const stat = await fsp.stat(localPath)
        if (stat.isFile() && stat.size > 16) cached = true
      } catch {
        cached = false
      }
    }
    if (!cached) {
      emitProgress('download', 2, '正在下载媒体…')
      await download(media.sourceUrl, localPath, (percent) => {
        const mapped = percent < 0 ? 20 : Math.max(2, Math.min(40, percent * 0.4))
        emitProgress('download', mapped, percent < 0 ? '正在下载媒体…' : '正在下载媒体 ' + Math.round(percent) + '%')
      }, signal, { retries: MAX_ATTEMPTS })
    } else {
      emitProgress('download', 40, '使用已缓存的媒体文件')
    }
    throwIfCancelled(signal, job)

    emitProgress('probe', 45, '正在解析媒体信息…')
    let probe
    try {
      probe = await mp4probe.probe(localPath)
    } catch (error) {
      if (cached) {
        // 缓存文件可能损坏：删除后重新下载一次
        emitProgress('download', 2, '缓存文件已损坏，正在重新下载…')
        await fsp.rm(localPath, { force: true })
        await download(media.sourceUrl, localPath, (percent) => {
          const mapped = percent < 0 ? 20 : Math.max(2, Math.min(40, percent * 0.4))
          emitProgress('download', mapped, '正在重新下载媒体…')
        }, signal, { retries: MAX_ATTEMPTS })
        emitProgress('probe', 50, '正在解析媒体信息…')
        probe = await mp4probe.probe(localPath)
      } else {
        throw error
      }
    }
    if (!(probe.frameCount > 0) || !(probe.width > 0) || !(probe.height > 0)) {
      throw mediaError('媒体文件无法解析出有效视频帧，可能已损坏', 'MEDIA_INVALID')
    }
    emitProgress('probe', 70, '媒体信息解析完成：' + probe.width + '×' + probe.height + '，' + probe.frameCount + ' 帧')

    throwIfCancelled(signal, job)
    emitProgress('thumbnail', 72, '正在生成缩略图…')
    const generated = await makeThumbnail(localPath, thumbnailPath, signal, {
      progress: (phase, percent, message) => emitProgress(phase, Math.max(72, Math.min(98, percent)), message),
    })
    emitProgress('thumbnail', 100, '媒体准备完成')
    return {
      mediaId,
      localPath,
      thumbnailPath: generated || null,
      probe,
    }
  } catch (error) {
    if (error && error.code === 'CANCELLED') throw error
    if (error && error.message) throw error
    throw mediaError('媒体准备失败：' + String(error), 'MEDIA_PREPARE_FAILED')
  } finally {
    untrack()
    if (ownJob) ownJob.finish()
  }
}

module.exports = {
  prepare,
  save,
  download,
  downloadImageBuffer,
  makeThumbnail,
  detectImageFormat,
  parseImageDimensions,
  buildSaveFileName,
  resolveTweetScreenName,
  resolveMediaIndex,
  savedMediaId,
}
