import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 零依赖静态服务：只服务 demo/ 目录，用于本地预览演示页。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo')
const port = Number(process.env.PORT || 4173)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.resolve(root, relative)
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }).end(data)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[serve] 演示页：http://127.0.0.1:${port}/`)
  console.log('[serve] 打开全彩取色器：http://127.0.0.1:4173/?open=full')
  console.log('[serve] 深色主题：http://127.0.0.1:4173/?theme=dark&open=full')
})
