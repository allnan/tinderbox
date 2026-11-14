#!/usr/bin/env node
/**
 * 本地开发/验收用 HTTP 代理（只用于本机验证代理链路与认证，不要用于生产）。
 *
 * 功能：
 * - 支持 CONNECT（HTTPS 隧道）与普通 HTTP 转发；
 * - 监听 127.0.0.1:<port>（默认 18990）；
 * - 每收到一个请求打印一行，例如：[proxy] CONNECT api.fxtwitter.com:443；
 * - 启动完成后打印 READY <port>（供脚本等待）；
 * - 可选 Basic 代理认证：--user <name> --pass <password>，未提供凭据返回 407；
 * - SIGINT / SIGTERM 优雅关闭。
 *
 * 用法：
 *   node scripts/dev-proxy.mjs
 *   node scripts/dev-proxy.mjs --port 18990 --user demo --pass secret
 *
 * 配合应用：
 *   XMediaStudioCore.exe --smoke-report report.json --proxy-mode custom --proxy-url http://127.0.0.1:18990 \
 *     --proxy-auth-user demo --proxy-auth-pass secret
 * 或在「设置 → 网络代理」中选择自定义代理并点击「测试代理」。
 */

import http from 'node:http'
import net from 'node:net'
import process from 'node:process'

const DEFAULT_PORT = 18990
const HOST = '127.0.0.1'
const REALM = 'xgif-dev-proxy'

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, user: '', pass: '', help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    const equalsIndex = arg.indexOf('=')
    const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg
    const inlineValue = equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : null
    const readValue = () => {
      if (inlineValue !== null) return inlineValue
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return ''
      index += 1
      return next
    }
    if (name === '--port') options.port = Number(readValue())
    else if (name === '--user') options.user = readValue()
    else if (name === '--pass') options.pass = readValue()
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  console.log(
    [
      '用法：node scripts/dev-proxy.mjs [--port 18990] [--user <用户名> --pass <密码>]',
      '',
      '启动后输出 READY <port>，并逐行打印代理收到的请求。',
      '提示：这是开发用本地代理，只支持 127.0.0.1 监听，不面向公网。',
    ].join('\n'),
  )
  process.exit(0)
}

const port = Number(options.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[proxy] 端口不正确：' + options.port)
  process.exit(2)
}

const expectedAuth = options.user
  ? 'Basic ' + Buffer.from(options.user + ':' + options.pass, 'utf8').toString('base64')
  : null

function log(line) {
  console.log(line)
}

function isAuthorized(request) {
  if (!expectedAuth) return true
  const header = request.headers['proxy-authorization']
  return typeof header === 'string' && header.trim() === expectedAuth
}

function splitHostPort(url) {
  const text = String(url || '')
  if (text.startsWith('[')) {
    // IPv6：[::1]:443
    const close = text.indexOf(']')
    if (close < 0) return { host: text, port: 443 }
    const host = text.slice(1, close)
    const rest = text.slice(close + 1)
    const port = Number(rest.startsWith(':') ? rest.slice(1) : '') || 443
    return { host, port }
  }
  const colon = text.lastIndexOf(':')
  if (colon < 0) return { host: text, port: 443 }
  return { host: text.slice(0, colon), port: Number(text.slice(colon + 1)) || 443 }
}

const sockets = new Set()

const server = http.createServer((request, response) => {
  if (!isAuthorized(request)) {
    // 注意：Content-Length 必须是实际字节数，否则客户端会因响应体长度不匹配而报错
    const body = 'Proxy Authentication Required\n'
    response.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="' + REALM + '"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    })
    response.end(body)
    log('[proxy] 407 ' + (request.method || 'GET') + ' ' + (request.url || ''))
    return
  }

  let target
  try {
    target = new URL(request.url)
  } catch {
    try {
      target = new URL('http://' + (request.headers.host || '') + (request.url || ''))
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Bad Request: 无法解析代理请求地址')
      return
    }
  }

  if (target.protocol !== 'http:') {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Bad Request: HTTPS 请求请使用 CONNECT 隧道')
    return
  }

  log('[proxy] ' + (request.method || 'GET') + ' ' + target.href)

  const headers = { ...request.headers, host: target.host }
  delete headers['proxy-authorization']
  delete headers['proxy-connection']

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: Number(target.port) || 80,
      path: target.pathname + target.search,
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
      upstreamResponse.on('error', () => response.destroy())
    },
  )
  upstream.on('error', (error) => {
    log('[proxy] 上游错误 ' + target.href + '：' + error.message)
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Bad Gateway: ' + error.message)
  })
  request.on('aborted', () => upstream.destroy())
  request.pipe(upstream)
})

server.on('connect', (request, clientSocket, head) => {
  const { host, port: targetPort } = splitHostPort(request.url)

  if (!isAuthorized(request)) {
    clientSocket.write(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
        'Proxy-Authenticate: Basic realm="' + REALM + '"\r\n' +
        'Content-Length: 0\r\n' +
        '\r\n',
    )
    clientSocket.destroy()
    log('[proxy] 407 CONNECT ' + host + ':' + targetPort)
    return
  }

  log('[proxy] CONNECT ' + host + ':' + targetPort)

  const upstream = net.connect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  const cleanup = () => {
    upstream.destroy()
    clientSocket.destroy()
  }
  upstream.on('error', (error) => {
    log('[proxy] 隧道错误 ' + host + ':' + targetPort + '：' + error.message)
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    }
    cleanup()
  })
  clientSocket.on('error', cleanup)
  clientSocket.on('close', cleanup)
  upstream.on('close', () => clientSocket.destroy())
})

server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})

server.on('error', (error) => {
  console.error('[proxy] 启动失败：' + (error && error.message ? error.message : String(error)))
  process.exit(1)
})

let closing = false
function shutdown(signal) {
  if (closing) return
  closing = true
  log('[proxy] 收到 ' + signal + '，正在关闭…')
  server.close(() => {
    log('[proxy] 已关闭')
    process.exit(0)
  })
  for (const socket of sockets) {
    try {
      socket.destroy()
    } catch {
      /* 忽略 */
    }
  }
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

server.listen(port, HOST, () => {
  console.log('READY ' + port)
  log('[proxy] 本地开发代理已启动：http://' + HOST + ':' + port + (expectedAuth ? '（需要代理认证）' : '（无需认证）'))
  log('[proxy] 在应用「设置 → 网络代理」中填入 http://' + HOST + ':' + port + ' 后点击「测试代理」')
})