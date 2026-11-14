'use strict'

/**
 * 网络代理：配置解析、Chromium session 应用、代理认证凭据、密码加密与连通性测试。
 *
 * 设计要点：
 * - 解析、媒体下载、缩略图全部走 Electron 默认 session：session.setProxy 设置后，
 *   主进程的 net.fetch 与渲染进程加载的远程图片都会经过同一代理；
 * - 代理认证通过 app.on('login') + 本模块缓存的凭据完成；
 * - 代理密码使用 safeStorage 加密后写入 settings.json（不可用时退化为 base64 并标记，文档已说明）。
 */

const DEFAULT_BYPASS = 'localhost;127.0.0.1;<local>'
// 与 docs/架构与接口契约.md §6.1 保持一致：仅接受 http / https / socks5（裸 host:port 按 http）
const SUPPORTED_SCHEMES = ['http', 'https', 'socks5']

function electronModules() {
  try {
    return require('electron') || {}
  } catch {
    return {}
  }
}

function defaultProxySettings() {
  return { mode: 'system', url: '', bypass: DEFAULT_BYPASS, username: '', password: '' }
}

/** 收敛外部传入的代理配置（缺省补全、类型校验） */
function normalizeProxySettings(input) {
  const source = input && typeof input === 'object' ? input : {}
  const mode = ['system', 'custom', 'direct'].includes(source.mode) ? source.mode : 'system'
  return {
    mode,
    url: typeof source.url === 'string' ? source.url.trim() : '',
    bypass: typeof source.bypass === 'string' ? source.bypass.trim() : DEFAULT_BYPASS,
    username: typeof source.username === 'string' ? source.username.trim() : '',
    password: typeof source.password === 'string' ? source.password : '',
  }
}

/**
 * 解析自定义代理地址。
 * 支持 http://host:port、https://host:port、socks5://host:port、裸 host:port（按 http）。
 * @returns {{ok:boolean, scheme?:string, host?:string, port?:number, url?:string, username?:string, password?:string, error?:string}}
 */
function parseProxyUrl(rawUrl) {
  const raw = String(rawUrl || '').trim()
  if (!raw) {
    return { ok: false, error: '请填写代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080' }
  }
  let value = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) value = 'http://' + value
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: '代理地址格式不正确：' + raw }
  }
  const scheme = parsed.protocol.replace(':', '').toLowerCase()
  if (!SUPPORTED_SCHEMES.includes(scheme)) {
    return { ok: false, error: '不支持的代理协议：' + scheme + '（支持 http / https / socks5）' }
  }
  const host = parsed.hostname
  if (!host) return { ok: false, error: '代理地址缺少主机名：' + raw }
  const defaultPort = scheme === 'https' ? 443 : scheme.startsWith('socks') ? 1080 : 80
  const port = parsed.port ? Number(parsed.port) : defaultPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '代理端口不正确：' + parsed.port }
  }
  const urlUsername = parsed.username ? decodeURIComponent(parsed.username) : ''
  const urlPassword = parsed.password ? decodeURIComponent(parsed.password) : ''
  return {
    ok: true,
    scheme,
    host,
    port,
    url: scheme + '://' + host + ':' + port,
    username: urlUsername,
    password: urlPassword,
  }
}

/** 生成 Chromium 的 proxyBypassRules（始终放行本机回环） */
function buildBypassRules(bypass) {
  const items = String(bypass || '')
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const merged = Array.from(new Set([...items, 'localhost', '127.0.0.1', '<local>']))
  return merged.join(';')
}

/**
 * 把代理设置转换为 session.setProxy 参数。
 * @returns {{ok:boolean, proxyRules:string|null, proxyBypassRules:string|null, mode:string, error:string|null}}
 */
function buildProxyConfig(input) {
  const proxy = normalizeProxySettings(input)
  if (proxy.mode === 'direct') return { ok: true, proxyRules: null, proxyBypassRules: null, mode: 'direct', error: null }
  if (proxy.mode === 'system') return { ok: true, proxyRules: null, proxyBypassRules: null, mode: 'system', error: null }
  const parsed = parseProxyUrl(proxy.url)
  if (!parsed.ok) return { ok: false, proxyRules: null, proxyBypassRules: null, mode: 'custom', error: parsed.error }
  const rules = parsed.scheme + '://' + parsed.host + ':' + parsed.port
  return {
    ok: true,
    proxyRules: rules,
    proxyBypassRules: buildBypassRules(proxy.bypass),
    mode: 'custom',
    error: null,
    parsed,
  }
}

/** 应用代理到 Electron 默认 session（主进程 net.fetch 与渲染进程远程图片共用） */
async function applyProxy(input) {
  const proxy = normalizeProxySettings(input)
  const built = buildProxyConfig(proxy)
  if (!built.ok) {
    return { ok: false, applied: false, mode: proxy.mode, proxyRules: null, error: built.error }
  }
  const { session } = electronModules()
  const targetSession = session && session.defaultSession ? session.defaultSession : null
  if (!targetSession) {
    // 纯 Node 环境（测试/脚本）：记录配置但不实际应用
    return { ok: true, applied: false, mode: proxy.mode, proxyRules: built.proxyRules, error: null }
  }
  const config = built.mode === 'custom'
    ? { mode: 'fixed_servers', proxyRules: built.proxyRules, proxyBypassRules: built.proxyBypassRules }
    : { mode: built.mode }
  try {
    await targetSession.setProxy(config)
  } catch (error) {
    return { ok: false, applied: false, mode: proxy.mode, proxyRules: null, error: '应用代理失败：' + (error && error.message ? error.message : String(error)) }
  }
  // 立即生效：关闭已建立的连接，避免旧的直连/旧代理连接继续复用
  try {
    await targetSession.closeAllConnections()
  } catch {
    /* 旧版本可能没有该方法，忽略 */
  }
  return { ok: true, applied: true, mode: proxy.mode, proxyRules: built.proxyRules, error: null }
}

/** 代理认证凭据缓存（由主进程在应用设置后更新，app.on('login') 中读取） */
let authCache = { enabled: false, username: '', password: '' }

function updateProxyAuth(input) {
  const proxy = normalizeProxySettings(input)
  let username = proxy.username
  let password = proxy.password
  if (proxy.mode === 'custom') {
    const parsed = parseProxyUrl(proxy.url)
    if (parsed.ok) {
      if (!username && parsed.username) username = parsed.username
      if (!password && parsed.password) password = parsed.password
    }
  }
  authCache = {
    enabled: Boolean(proxy.mode === 'custom' && username),
    username: username || '',
    password: password || '',
  }
  return { ...authCache }
}

function getProxyAuth() {
  return { ...authCache }
}

/** 加密代理密码（写入 settings.json 前调用） */
function encryptPassword(password) {
  const text = String(password || '')
  if (!text) return { value: '', storage: 'none' }
  const electron = electronModules()
  try {
    const safeStorage = electron.safeStorage
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      return { value: 'safe:' + safeStorage.encryptString(text).toString('base64'), storage: 'safeStorage' }
    }
  } catch {
    /* 忽略，退化为 base64 */
  }
  return { value: 'plain:' + Buffer.from(text, 'utf8').toString('base64'), storage: 'plain' }
}

/** 解密代理密码（读取 settings.json 后调用；兼容早期明文） */
function decryptPassword(stored) {
  const value = String(stored || '')
  if (!value) return ''
  if (value.startsWith('plain:')) return Buffer.from(value.slice(6), 'base64').toString('utf8')
  if (value.startsWith('safe:')) {
    const electron = electronModules()
    try {
      const safeStorage = electron.safeStorage
      if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
      }
    } catch {
      /* 解密失败（换了机器/用户）时返回空密码，由用户重新填写 */
    }
    return ''
  }
  return value
}

// 连通性测试目标：X 解析接口 + X 媒体 CDN。
// 媒体地址使用一个公开推文的真实 mp4（HEAD 只需要 CDN 可达）；如未来失效，只需更新此常量。
const DEFAULT_TEST_TARGETS = [
  { name: 'X 解析接口', url: 'https://api.fxtwitter.com/2/status/20', method: 'GET' },
  { name: 'X 媒体 CDN', url: 'https://video.twimg.com/tweet_video/HV_H1BxXsAAd_Ba.mp4', method: 'HEAD' },
]

async function testTarget(fetchImpl, target, timeoutMs) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(target.url, {
      method: target.method || 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 XMediaStudio', accept: '*/*' },
    })
    const latencyMs = Date.now() - started
    const ok = response.status >= 200 && response.status < 400
    // 消费/释放响应体，避免 ClientRequest 模式下连接悬挂
    try {
      if (target.method !== 'HEAD') await response.text()
      else if (response.body && typeof response.body.resume === 'function') response.body.resume()
    } catch {
      /* 忽略 */
    }
    return { name: target.name, url: target.url, ok, status: response.status, latencyMs, error: ok ? null : 'HTTP ' + response.status }
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? '请求超时（' + timeoutMs + 'ms）'
      : '网络错误：' + (error && error.message ? error.message : String(error))
    return { name: target.name, url: target.url, ok: false, status: null, latencyMs: Date.now() - started, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 在当前 session 的代理生效状态下测试 X 接口与媒体 CDN 的连通性。
 * 调用方需先 applyProxy，再传入 fetchImpl（通常是 network.fetch）与代理配置。
 */
async function testProxyConnectivity(options = {}) {
  const fetchImpl = options.fetchImpl
  if (typeof fetchImpl !== 'function') {
    return { ok: false, mode: 'custom', effectiveUrl: null, checks: [], error: '当前环境不支持网络请求' }
  }
  const proxy = normalizeProxySettings(options.proxy)
  const targets = Array.isArray(options.targets) && options.targets.length > 0 ? options.targets : DEFAULT_TEST_TARGETS
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000
  const checks = []
  for (const target of targets) {
    checks.push(await testTarget(fetchImpl, target, timeoutMs))
  }
  const ok = checks.every((check) => check.ok)
  return {
    ok,
    mode: proxy.mode,
    effectiveUrl: proxy.mode === 'custom' ? proxy.url : null,
    checks,
    error: ok ? null : '部分检查未通过，请确认代理地址/端口/认证信息，或检查代理是否允许访问 X',
  }
}

module.exports = {
  DEFAULT_BYPASS,
  defaultProxySettings,
  normalizeProxySettings,
  parseProxyUrl,
  buildBypassRules,
  buildProxyConfig,
  applyProxy,
  updateProxyAuth,
  getProxyAuth,
  encryptPassword,
  decryptPassword,
  testProxyConnectivity,
  DEFAULT_TEST_TARGETS,
}
