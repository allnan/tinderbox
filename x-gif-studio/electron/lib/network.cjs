'use strict'

/**
 * 统一的网络请求入口：
 * - Electron 主进程中使用 net.fetch（Chromium 网络栈），因此自动使用默认 session 上配置的代理，
 *   与渲染进程加载远程缩略图走同一代理链路；
 * - 纯 Node 环境（单元测试/脚本）退化为全局 fetch（不经过代理）；
 * - 提供 fetchWithTimeout 便捷方法。
 */

const proxy = require('./proxy.cjs')

function electronNet() {
  try {
    const electron = require('electron')
    return electron && electron.net ? electron.net : null
  } catch {
    return null
  }
}

/**
 * 主进程 net.fetch 在 Electron 中不会触发 app.on('login')（Electron issue #44249），
 * 因此当配置了代理认证凭据时，改用 net.request（ClientRequest）发请求，它支持 login 事件回填凭据。
 */
function needsClientRequestPath() {
  const auth = proxy.getProxyAuth()
  return Boolean(auth && auth.enabled && (auth.username || auth.password) && electronNet())
}

function headerGetter(rawHeaders) {
  return {
    get(name) {
      const key = String(name).toLowerCase()
      const value = rawHeaders && rawHeaders[key] !== undefined ? rawHeaders[key] : rawHeaders && rawHeaders[String(name)]
      if (value === undefined || value === null) return null
      return Array.isArray(value) ? value.join(', ') : String(value)
    },
  }
}

function createResponseFromNode(response, status, finalUrl) {
  let collected = null
  const readAll = () =>
    new Promise((resolve, reject) => {
      if (collected) {
        resolve(collected)
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        collected = Buffer.concat(chunks)
        resolve(collected)
      })
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('响应被中断')))
    })
  return {
    status,
    ok: status >= 200 && status < 300,
    url: finalUrl || '',
    headers: headerGetter(response.headers || {}),
    body: response,
    async text() {
      return (await readAll()).toString('utf8')
    },
    async json() {
      return JSON.parse((await readAll()).toString('utf8'))
    },
    async arrayBuffer() {
      const buffer = await readAll()
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

function clientRequestFetch(input, init = {}) {
  const net = electronNet()
  if (!net || typeof net.request !== 'function') return resolveFetch()(input, init)
  const url = typeof input === 'string' ? input : input && input.url
  if (!url) return Promise.reject(new Error('请求缺少 URL'))
  const method = String(init.method || 'GET').toUpperCase()
  const headers = init.headers || {}
  const signal = init.signal
  const auth = proxy.getProxyAuth()

  return new Promise((resolve, reject) => {
    let settled = false
    let cleanupAbort = null
    let redirects = 0
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (cleanupAbort) cleanupAbort()
      fn(value)
    }

    const request = net.request({ url, method })
    request.on('login', (authInfo, callback) => {
      try {
        if (auth && auth.enabled) callback(auth.username || '', auth.password || '')
        else callback()
      } catch {
        try {
          callback()
        } catch {
          /* 忽略 */
        }
      }
    })
    request.on('redirect', () => {
      redirects += 1
      if (redirects > 5) {
        try {
          request.abort()
        } catch {
          /* 忽略 */
        }
        return
      }
      try {
        request.followRedirect()
      } catch {
        /* 忽略 */
      }
    })
    for (const [key, value] of Object.entries(headers)) {
      try {
        request.setHeader(key, String(value))
      } catch {
        /* 忽略非法请求头 */
      }
    }
    if (signal) {
      const onAbort = () => {
        try {
          request.abort()
        } catch {
          /* 忽略 */
        }
        const error = new Error('任务已取消')
        error.name = 'AbortError'
        error.code = 'CANCELLED'
        finish(reject, error)
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      cleanupAbort = () => signal.removeEventListener('abort', onAbort)
    }
    request.on('response', (response) => {
      finish(resolve, createResponseFromNode(response, response.statusCode, url))
    })
    request.on('error', (error) => finish(reject, error))
    try {
      request.end()
    } catch (error) {
      finish(reject, error)
    }
  })
}

function resolveFetch() {
  try {
    const electron = require('electron')
    if (electron && electron.net && typeof electron.net.fetch === 'function') {
      return electron.net.fetch.bind(electron.net)
    }
  } catch {
    /* 非 Electron 环境 */
  }
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  throw new Error('当前环境不支持网络请求（缺少 fetch）')
}

function isElectronFetch() {
  try {
    const electron = require('electron')
    return Boolean(electron && electron.net && typeof electron.net.fetch === 'function')
  } catch {
    return false
  }
}

/**
 * 与 fetch 同参，但会走 Electron session 的代理配置。
 * 配置了代理认证凭据时改用 ClientRequest 路径（可处理 407 认证）；否则用 net.fetch。
 */
function fetch(input, init) {
  if (needsClientRequestPath()) return clientRequestFetch(input, init)
  return resolveFetch()(input, init)
}

function combineSignals(signals) {
  const list = signals.filter(Boolean)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  for (const signal of list) {
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

/**
 * 带超时的 fetch。外部 signal（任务取消）与超时 signal 会合并。
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(input, init = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort()
  }, Math.max(1000, timeoutMs))
  const signal = combineSignals([init.signal, controller.signal])
  try {
    return await fetch(input, { ...init, signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 请求 JSON（失败抛出可读错误） */
async function fetchJson(url, init = {}, timeoutMs = 20000) {
  const response = await fetchWithTimeout(url, init, timeoutMs)
  const text = await response.text()
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status + (text ? '：' + text.slice(0, 200) : ''))
    error.status = response.status
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('接口返回的不是有效 JSON')
  }
}

module.exports = { fetch, fetchWithTimeout, fetchJson, isElectronFetch, needsClientRequestPath }
