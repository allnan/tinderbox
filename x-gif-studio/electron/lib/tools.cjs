'use strict'

/**
 * 外部工具（ffmpeg / gifski / gifsicle）的定位与子进程执行。
 * - 开发态找 <项目>/tools/bin，打包态找 <resources>/tools，最后回退系统 PATH；
 * - 所有长任务都通过 runProcess 执行，支持取消（AbortSignal / child.kill）与行级回调（用于解析进度）。
 */

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const paths = require('./paths.cjs')

const IS_WINDOWS = process.platform === 'win32'
const EXE = IS_WINDOWS ? '.exe' : ''

let resolvedCache = null

function bundledPath(name) {
  return path.join(paths.toolsDir(), name + EXE)
}

function findOnPath(name) {
  try {
    const output = execFileSync(IS_WINDOWS ? 'where.exe' : 'which', [name + EXE], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    const first = String(output).split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return first || null
  } catch {
    return null
  }
}

/** 返回工具可执行文件绝对路径或 null */
function resolve(name) {
  if (!resolvedCache) resolvedCache = {}
  if (Object.prototype.hasOwnProperty.call(resolvedCache, name)) return resolvedCache[name]
  const bundled = bundledPath(name)
  let found = null
  if (fs.existsSync(bundled)) found = bundled
  else found = findOnPath(name)
  resolvedCache[name] = found
  return found
}

function resetCache() {
  resolvedCache = null
}

function resolveRequired(name) {
  const found = resolve(name)
  if (!found) {
    const error = new Error('缺少外部工具 ' + name + '。请运行 npm run fetch-tools 重新下载，或把 ' + name + EXE + ' 放到 tools/bin/')
    error.code = 'TOOLS_MISSING'
    error.tool = name
    throw error
  }
  return found
}

/**
 * 执行子进程。
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number, onStdoutLine?:(line:string)=>void, onStderrLine?:(line:string)=>void, onStdoutChunk?:(text:string)=>void, onStderrChunk?:(text:string)=>void, signal?:AbortSignal, env?:Record<string,string>}} options
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
function runProcess(bin, args, options = {}) {
  const { cwd, timeoutMs = 0, onStdoutLine, onStderrLine, onStdoutChunk, onStderrChunk, signal, env } = options
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const error = new Error('任务已取消')
      error.code = 'CANCELLED'
      reject(error)
      return
    }
    let child
    try {
      child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let stdoutBuffer = ''
    let stderrBuffer = ''

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          try {
            child.kill()
          } catch {
            /* 忽略 */
          }
        }, timeoutMs)
      : null

    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    const feed = (chunk, target, lineHandler, flush, chunkHandler) => {
      const text = chunk.toString('utf8')
      if (chunkHandler) {
        try {
          chunkHandler(text)
        } catch {
          /* 忽略回调异常 */
        }
      }
      if (target === 'out') stdout += text
      else stderr += text
      const bufferKey = target === 'out' ? 'stdoutBuffer' : 'stderrBuffer'
      const merged = (target === 'out' ? stdoutBuffer : stderrBuffer) + text
      const lines = merged.split(/\r?\n/)
      const rest = lines.pop() || ''
      if (target === 'out') stdoutBuffer = rest
      else stderrBuffer = rest
      if (lineHandler) {
        for (const line of lines) {
          try {
            lineHandler(line)
          } catch {
            /* 忽略回调异常 */
          }
        }
      }
      if (flush) {
        if (target === 'out') stdoutBuffer = ''
        else stderrBuffer = ''
      }
      return bufferKey
    }

    child.stdout.on('data', (chunk) => feed(chunk, 'out', onStdoutLine, false, onStdoutChunk))
    child.stderr.on('data', (chunk) => feed(chunk, 'err', onStderrLine, false, onStderrChunk))

    const finish = (code, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (onStdoutLine && stdoutBuffer) onStdoutLine(stdoutBuffer)
      if (onStderrLine && stderrBuffer) onStderrLine(stderrBuffer)
      if (error) {
        reject(error)
        return
      }
      if (stdout.length > 400000) stdout = stdout.slice(-400000)
      if (stderr.length > 400000) stderr = stderr.slice(-400000)
      resolve({ code, stdout, stderr, timedOut })
    }

    child.on('error', (error) => {
      finish(null, error)
    })
    child.on('close', (code) => {
      if (signal && signal.aborted) {
        const error = new Error('任务已取消')
        error.code = 'CANCELLED'
        finish(null, error)
        return
      }
      if (timedOut) {
        const error = new Error('命令执行超时：' + path.basename(bin))
        error.code = 'TIMEOUT'
        finish(null, error)
        return
      }
      finish(code, null)
    })
  })
}

/** 执行命令，退出码非 0 时抛出带 stderr 尾部的错误 */
async function runOrThrow(bin, args, options = {}) {
  const result = await runProcess(bin, args, options)
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-8).join('\n')
    const error = new Error('命令执行失败（' + path.basename(bin) + '，退出码 ' + result.code + '）' + (tail ? '：' + tail : ''))
    error.code = 'PROCESS_FAILED'
    error.stderr = result.stderr
    error.exitCode = result.code
    throw error
  }
  return result
}

async function readVersion(name, args) {
  const bin = resolve(name)
  if (!bin) return null
  try {
    const result = await runProcess(bin, args, { timeoutMs: 15000 })
    const text = (result.stdout || '') + '\n' + (result.stderr || '')
    const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    return firstLine || null
  } catch {
    return null
  }
}

async function status() {
  const ffmpeg = resolve('ffmpeg')
  const gifski = resolve('gifski')
  const gifsicle = resolve('gifsicle')
  const missing = []
  if (!ffmpeg) missing.push('ffmpeg')
  if (!gifski) missing.push('gifski')
  if (!gifsicle) missing.push('gifsicle')
  const [ffmpegVersion, gifskiVersion, gifsicleVersion] = await Promise.all([
    ffmpeg ? readVersion('ffmpeg', ['-version']) : Promise.resolve(null),
    gifski ? readVersion('gifski', ['--version']) : Promise.resolve(null),
    gifsicle ? readVersion('gifsicle', ['--version']) : Promise.resolve(null),
  ])
  return {
    ffmpeg,
    gifski,
    gifsicle,
    ffmpegVersion,
    gifskiVersion,
    gifsicleVersion,
    // 核心编码依赖 ffmpeg + gifski；gifsicle 只影响「体积优化」
    ready: Boolean(ffmpeg && gifski),
    missing,
  }
}

module.exports = { resolve, resolveRequired, resetCache, runProcess, runOrThrow, status, IS_WINDOWS }
