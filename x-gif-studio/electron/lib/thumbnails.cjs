'use strict'

/**
 * 已保存视频的缩略图：首次请求时用 ffmpeg 抽首帧，缓存到 cache/thumbs/saved/。
 * 仅处理 mp4 视频；图片由渲染进程直接用 media:display-url 展示。
 */

const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const tools = require('./tools.cjs')
const paths = require('./paths.cjs')

const VIDEO_EXTS = new Set(['.mp4', '.m4v'])
const MAX_WIDTH = 480
const TIMEOUT_MS = 30000

function cachePathFor(filePath) {
  const stat = fs.statSync(filePath)
  const hash = crypto
    .createHash('sha1')
    .update(path.resolve(filePath) + '|' + stat.size + '|' + Math.round(stat.mtimeMs))
    .digest('hex')
    .slice(0, 20)
  return path.join(paths.cacheDir(), 'thumbs', 'saved', hash + '.jpg')
}

/**
 * 确保视频缩略图存在，返回本地路径；失败返回 null（调用方回退占位图）。
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function ensureVideoThumbnail(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  const resolved = path.resolve(filePath)
  const stat = await fsp.stat(resolved).catch(() => null)
  if (!stat || !stat.isFile()) return null
  if (!VIDEO_EXTS.has(path.extname(resolved).toLowerCase())) return null

  const target = cachePathFor(resolved)
  const existing = await fsp.stat(target).catch(() => null)
  if (existing && existing.size > 0) return target

  const ffmpeg = tools.resolve('ffmpeg')
  if (!ffmpeg) return null
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temporary = target + '.tmp-' + process.pid + '-' + Date.now() + '.jpg'
  const args = [
    '-v', 'error', '-y',
    '-i', resolved,
    '-frames:v', '1',
    '-vf', "scale=w='min(" + MAX_WIDTH + ",iw)':h=-2:flags=lanczos",
    '-q:v', '3',
    temporary,
  ]
  try {
    const result = await tools.runProcess(ffmpeg, args, { timeoutMs: TIMEOUT_MS })
    if (result && result.code !== 0) throw new Error('ffmpeg 退出码 ' + result.code)
    const output = await fsp.stat(temporary)
    if (!output.size) throw new Error('缩略图为空')
    await fsp.rename(temporary, target)
    return target
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
    return null
  }
}

module.exports = { ensureVideoThumbnail }
