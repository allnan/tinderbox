'use strict'

/**
 * proxy.cjs 单元测试（纯 Node 环境，safeStorage 不可用）：
 * 地址解析、绕过规则、session 配置、设置归一化、密码加解密、连通性测试。
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const helpers = require('./helpers.cjs')
const proxy = require(helpers.libPath('proxy.cjs'))

// ---------------------------------------------------------------------------
// parseProxyUrl
// ---------------------------------------------------------------------------

test('parseProxyUrl：http / https / socks5 / 裸 host:port 均可解析', () => {
  const http = proxy.parseProxyUrl('http://127.0.0.1:7890')
  assert.equal(http.ok, true)
  assert.equal(http.scheme, 'http')
  assert.equal(http.host, '127.0.0.1')
  assert.equal(http.port, 7890)
  assert.equal(http.url, 'http://127.0.0.1:7890')
  assert.equal(http.username, '')
  assert.equal(http.password, '')

  const https = proxy.parseProxyUrl('https://proxy.example.com:8443')
  assert.equal(https.ok, true)
  assert.equal(https.scheme, 'https')
  assert.equal(https.url, 'https://proxy.example.com:8443')

  const socks = proxy.parseProxyUrl('socks5://127.0.0.1:1080')
  assert.equal(socks.ok, true)
  assert.equal(socks.scheme, 'socks5')
  assert.equal(socks.port, 1080)

  const bare = proxy.parseProxyUrl('127.0.0.1:7890')
  assert.equal(bare.ok, true)
  assert.equal(bare.scheme, 'http')
  assert.equal(bare.url, 'http://127.0.0.1:7890')

  const bareHost = proxy.parseProxyUrl('  localhost:1080  ')
  assert.equal(bareHost.ok, true)
  assert.equal(bareHost.host, 'localhost')
  assert.equal(bareHost.port, 1080)
})

test('parseProxyUrl：地址内嵌用户名/密码会解码（可被 updateProxyAuth 复用）', () => {
  const parsed = proxy.parseProxyUrl('http://user:p%40ss%3Aword@127.0.0.1:7890')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.username, 'user')
  assert.equal(parsed.password, 'p@ss:word')
  assert.equal(parsed.url, 'http://127.0.0.1:7890')
})

test('parseProxyUrl：缺省端口按协议补全（http 80 / https 443 / socks5 1080）', () => {
  assert.equal(proxy.parseProxyUrl('http://127.0.0.1').port, 80)
  assert.equal(proxy.parseProxyUrl('https://127.0.0.1').port, 443)
  assert.equal(proxy.parseProxyUrl('socks5://127.0.0.1').port, 1080)
})

test('parseProxyUrl：非法地址返回中文错误而不是抛异常', () => {
  const cases = [
    ['', /请填写代理地址/],
    ['   ', /请填写代理地址/],
    ['ftp://127.0.0.1:21', /不支持的代理协议/],
    ['socks4://127.0.0.1:1080', /不支持的代理协议/],
    ['http://127.0.0.1:0', /代理端口不正确/],
    ['http://127.0.0.1:70000', /格式不正确/],
    ['http://', /格式不正确/],
    ['not a url with spaces', /格式不正确/],
  ]
  for (const [raw, pattern] of cases) {
    const parsed = proxy.parseProxyUrl(raw)
    assert.equal(parsed.ok, false, '应判为非法：' + JSON.stringify(raw))
    assert.match(parsed.error, pattern)
  }
})

// ---------------------------------------------------------------------------
// bypass / session 配置
// ---------------------------------------------------------------------------

test('buildBypassRules：始终追加本机回环保底且去重', () => {
  assert.equal(proxy.buildBypassRules(''), 'localhost;127.0.0.1;<local>')
  assert.equal(proxy.buildBypassRules(null), 'localhost;127.0.0.1;<local>')

  const result = proxy.buildBypassRules('example.com; foo.com  bar.com,127.0.0.1;localhost')
  const items = result.split(';')
  assert.equal(new Set(items).size, items.length, '不应有重复项')
  for (const expected of ['example.com', 'foo.com', 'bar.com', '127.0.0.1', 'localhost', '<local>']) {
    assert.ok(items.includes(expected), '缺少 ' + expected)
  }
})

test('buildProxyConfig：system / direct / custom 与非法地址', () => {
  const system = proxy.buildProxyConfig({ mode: 'system' })
  assert.equal(system.ok, true)
  assert.equal(system.mode, 'system')
  assert.equal(system.proxyRules, null)
  assert.equal(system.proxyBypassRules, null)

  const direct = proxy.buildProxyConfig({ mode: 'direct' })
  assert.equal(direct.ok, true)
  assert.equal(direct.mode, 'direct')
  assert.equal(direct.proxyRules, null)

  const custom = proxy.buildProxyConfig({ mode: 'custom', url: 'socks5://127.0.0.1:1080', bypass: 'example.com' })
  assert.equal(custom.ok, true)
  assert.equal(custom.mode, 'custom')
  assert.equal(custom.proxyRules, 'socks5://127.0.0.1:1080')
  assert.match(custom.proxyBypassRules, /localhost/)
  assert.match(custom.proxyBypassRules, /example\.com/)
  assert.equal(custom.parsed.scheme, 'socks5')

  const invalid = proxy.buildProxyConfig({ mode: 'custom', url: 'ftp://127.0.0.1:21' })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /不支持的代理协议/)

  const empty = proxy.buildProxyConfig({ mode: 'custom', url: '' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /请填写代理地址/)
})

// ---------------------------------------------------------------------------
// normalizeProxySettings
// ---------------------------------------------------------------------------

test('normalizeProxySettings：缺省补全与模式回退', () => {
  const defaults = proxy.normalizeProxySettings(null)
  assert.equal(defaults.mode, 'system')
  assert.equal(defaults.url, '')
  assert.equal(defaults.username, '')
  assert.equal(defaults.password, '')
  assert.equal(defaults.bypass, proxy.DEFAULT_BYPASS)

  const custom = proxy.normalizeProxySettings({
    mode: 'custom',
    url: '  http://127.0.0.1:7890 ',
    username: ' user ',
    password: 'p@ss',
  })
  assert.equal(custom.mode, 'custom')
  assert.equal(custom.url, 'http://127.0.0.1:7890')
  assert.equal(custom.username, 'user')
  assert.equal(custom.password, 'p@ss')

  // 非法 mode 回退 system；缺省 bypass 用默认值
  const fallback = proxy.normalizeProxySettings({ mode: 'weird', bypass: undefined })
  assert.equal(fallback.mode, 'system')
  assert.equal(fallback.bypass, proxy.DEFAULT_BYPASS)

  // 空字符串 bypass 原样保留（由 buildBypassRules 兜底）
  assert.equal(proxy.normalizeProxySettings({ bypass: '' }).bypass, '')
})

// ---------------------------------------------------------------------------
// 密码加解密（纯 Node：safeStorage 应不可用）
// ---------------------------------------------------------------------------

test('encryptPassword / decryptPassword：纯 Node 退化为 plain:<base64>，可逆且不含明文', () => {
  const secret = 'p@ssw0rd-中文-🔐'
  const encrypted = proxy.encryptPassword(secret)
  assert.ok(encrypted.value.length > 0)
  assert.notEqual(encrypted.value, secret)
  assert.ok(!encrypted.value.includes('p@ssw0rd'), '密文不应包含明文片段')
  assert.ok(!encrypted.value.includes('中文'), '密文不应包含明文片段')
  assert.equal(encrypted.storage, 'plain')
  assert.match(encrypted.value, /^plain:/)
  assert.equal(proxy.decryptPassword(encrypted.value), secret)

  assert.deepEqual(proxy.encryptPassword(''), { value: '', storage: 'none' })
  assert.equal(proxy.decryptPassword(''), '')
})

test('decryptPassword：兼容 old plain 文本与无法解密的 safe: 密文', () => {
  assert.equal(proxy.decryptPassword('plain:' + Buffer.from('hello', 'utf8').toString('base64')), 'hello')
  // 早期版本可能存过明文
  assert.equal(proxy.decryptPassword('legacy-plain-text'), 'legacy-plain-text')
  // 纯 Node 下 safeStorage 不可用，safe: 密文返回空密码（由用户重新填写）
  assert.equal(proxy.decryptPassword('safe:' + Buffer.from('whatever').toString('base64')), '')
})

// ---------------------------------------------------------------------------
// 连通性测试
// ---------------------------------------------------------------------------

test('testProxyConnectivity：逐项检查、全部通过时 ok=true 且使用传入的 fetchImpl', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init && init.method })
    return { status: 200, ok: true }
  }
  const targets = [
    { name: '接口', url: 'https://api.example.test/ping', method: 'GET' },
    { name: '媒体', url: 'https://cdn.example.test/a.mp4', method: 'HEAD' },
  ]
  const result = await proxy.testProxyConnectivity({ fetchImpl, proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' }, targets, timeoutMs: 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'custom')
  assert.equal(result.effectiveUrl, 'http://127.0.0.1:7890')
  assert.equal(result.error, null)
  assert.equal(result.checks.length, 2)
  assert.ok(result.checks.every((check) => check.ok && check.status === 200 && check.latencyMs >= 0))
  assert.deepEqual(calls, [
    { url: targets[0].url, method: 'GET' },
    { url: targets[1].url, method: 'HEAD' },
  ])
})

test('testProxyConnectivity：HTTP 非 2xx/3xx 与网络异常都会标记失败', async () => {
  const failing = await proxy.testProxyConnectivity({
    fetchImpl: async () => ({ status: 503, ok: false }),
    proxy: { mode: 'system' },
    targets: [{ name: '接口', url: 'https://api.example.test/ping', method: 'GET' }],
    timeoutMs: 1000,
  })
  assert.equal(failing.ok, false)
  assert.equal(failing.checks[0].ok, false)
  assert.equal(failing.checks[0].status, 503)
  assert.match(failing.checks[0].error, /HTTP 503/)
  assert.match(failing.error, /部分检查未通过/)

  const thrown = await proxy.testProxyConnectivity({
    fetchImpl: async () => {
      throw new Error('boom')
    },
    proxy: { mode: 'direct' },
    targets: [{ name: '接口', url: 'https://api.example.test/ping', method: 'GET' }],
    timeoutMs: 1000,
  })
  assert.equal(thrown.ok, false)
  assert.match(thrown.checks[0].error, /网络错误：boom/)
  assert.equal(thrown.effectiveUrl, null)
})

test('testProxyConnectivity：超时会标记「请求超时」', async () => {
  const hangingFetch = (url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ status: 200, ok: true }), 2000)
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      }
    })
  const result = await proxy.testProxyConnectivity({
    fetchImpl: hangingFetch,
    proxy: { mode: 'custom', url: 'http://127.0.0.1:7890' },
    targets: [{ name: '接口', url: 'https://api.example.test/ping', method: 'GET' }],
    timeoutMs: 50,
  })
  assert.equal(result.ok, false)
  assert.match(result.checks[0].error, /请求超时（50ms）/)
})

test('testProxyConnectivity：缺少 fetchImpl 时给出可展示错误', async () => {
  const result = await proxy.testProxyConnectivity({ proxy: { mode: 'system' } })
  assert.equal(result.ok, false)
  assert.equal(result.error, '当前环境不支持网络请求')
})
