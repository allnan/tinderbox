import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

/**
 * 下载/更新运行所需的外部工具到 tools/bin/（不提交到仓库）：
 *   ffmpeg.exe   解码/缩放/抽帧/缩略图（gyan.dev essentials 构建）
 *   gifski.exe   GIF 编码器（gif.ski 官方 Windows 构建）
 *   gifsicle.exe GIF 体积优化（eternallybored Windows 构建）
 *
 * 用法：node scripts/fetch-tools.mjs [--force] [--only ffmpeg|gifski|gifsicle]
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binDir = path.join(root, 'tools', 'bin')
fs.mkdirSync(binDir, { recursive: true })

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null

const SOURCES = {
  ffmpeg: {
    target: path.join(binDir, 'ffmpeg.exe'),
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    zipEntry: /ffmpeg\.exe$/i,
    verify: ['-version'],
  },
  gifski: {
    target: path.join(binDir, 'gifski.exe'),
    url: 'https://gif.ski/gifski-1.32.0.zip',
    zipEntry: /win\/gifski\.exe$/i,
    verify: ['--version'],
  },
  gifsicle: {
    target: path.join(binDir, 'gifsicle.exe'),
    url: 'https://eternallybored.org/misc/gifsicle/releases/gifsicle-1.97-win64.zip',
    zipEntry: /gifsicle\.exe$/i,
    verify: ['--version'],
  },
}

const tmpRoot = path.join(root, '.build', 'tools-download')
fs.mkdirSync(tmpRoot, { recursive: true })

const log = (...values) => console.log('[fetch-tools]', ...values)

function human(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

async function download(url, dest) {
  log('下载', url)
  const started = Date.now()
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 x-media-studio' } })
  if (!response.ok) throw new Error('下载失败 HTTP ' + response.status + '：' + url)
  const total = Number(response.headers.get('content-length') || 0)
  const chunks = []
  let received = 0
  let lastLog = 0
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk))
    received += chunk.length
    const now = Date.now()
    if (now - lastLog > 1500) {
      lastLog = now
      const percent = total ? ((received / total) * 100).toFixed(0) + '%' : human(received)
      process.stdout.write('  已下载 ' + percent + '\r')
    }
  }
  process.stdout.write('\n')
  const buffer = Buffer.concat(chunks)
  fs.writeFileSync(dest, buffer)
  log('下载完成', human(buffer.length), '用时', ((Date.now() - started) / 1000).toFixed(1) + 's')
  return dest
}

function extractFromZip(zipPath, pattern, dest) {
  const outDir = path.join(tmpRoot, 'unzip-' + Date.now())
  fs.mkdirSync(outDir, { recursive: true })
  log('解压', path.basename(zipPath))
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + outDir + '" -Force'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('解压失败：' + zipPath)

  const stack = [outDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        const normalized = full.replace(/\\/g, '/')
        if (pattern.test(normalized)) {
          fs.copyFileSync(full, dest)
          log('已写入', path.relative(root, dest), human(fs.statSync(dest).size))
          return true
        }
      }
    }
  }
  return false
}

async function ensureTool(name, config) {
  if (!force && fs.existsSync(config.target) && fs.statSync(config.target).size > 1024) {
    log(name + ' 已存在，跳过（--force 可强制更新）')
    return true
  }
  const zipPath = path.join(tmpRoot, name + '-' + Date.now() + '.zip')
  await download(config.url, zipPath)
  const ok = extractFromZip(zipPath, config.zipEntry, config.target)
  if (!ok) throw new Error('压缩包内找不到 ' + name + '：' + config.url)
  return true
}

function verify(name) {
  const config = SOURCES[name]
  try {
    const output = execFileSync(config.target, config.verify, { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const first = String(output).split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    log('校验 ' + name + '：' + first)
    return true
  } catch (error) {
    log('校验失败 ' + name + '：' + (error && error.message ? error.message : String(error)))
    return false
  }
}

const names = only ? [only] : Object.keys(SOURCES)
if (only && !SOURCES[only]) {
  console.error('未知工具：' + only + '，可选：' + Object.keys(SOURCES).join(', '))
  process.exit(1)
}

let allOk = true
for (const name of names) {
  try {
    await ensureTool(name, SOURCES[name])
    if (!verify(name)) allOk = false
  } catch (error) {
    console.error('[fetch-tools] ' + name + ' 失败：' + (error && error.message ? error.message : String(error)))
    allOk = false
  }
}

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  /* 忽略 */
}

if (!allOk) {
  console.error('[fetch-tools] 有工具未就绪，请检查网络后重试')
  process.exit(1)
}
log('全部工具已就绪：' + binDir)