import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

/**
 * 渲染进程 DOM 冒烟测试（不启动 Electron）：
 * 在 jsdom 中执行打包后的 dist/assets/app.js，检查：
 *   1) React 能正常挂载、界面关键文案存在（解析 / 历史 / 设置 等）；
 *   2) 左侧导航可点击、切换后不抛错；
 *   3) 没有 window 运行时错误 / unhandledrejection / jsdomError；
 *   4) 没有 window.desktop 桥接时（浏览器/冒烟环境）界面降级而不是崩溃。
 *
 * 用法：node scripts/smoke.mjs [--verbose] [--json]
 * 前置：node scripts/build.mjs 生成 dist/。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const verbose = process.argv.includes('--verbose')
const jsonOnly = process.argv.includes('--json')

const htmlPath = path.join(root, 'dist', 'index.html')
const bundlePath = path.join(root, 'dist', 'assets', 'app.js')
if (!fs.existsSync(htmlPath) || !fs.existsSync(bundlePath)) {
  console.error('[smoke] 缺少 dist/index.html 或 dist/assets/app.js，请先运行 node scripts/build.mjs')
  process.exit(1)
}
const html = fs.readFileSync(htmlPath, 'utf8')
const bundle = fs.readFileSync(bundlePath, 'utf8')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 与 electron/preload.cjs 等价的假桌面桥接 */
function makeDesktopBridge() {
  const okData = (data) => Promise.resolve({ ok: true, data })
  const list = []
  return {
    isDesktop: true,
    app: {
      // 契约：app.info() 直接返回 AppInfo（其余业务接口才是 OperationResult）
      info: async () => ({
        version: '0.0.0-smoke',
        name: 'X 媒体工坊',
        isPackaged: false,
        dataDir: 'C:\\\\smoke\\\\data',
        cacheDir: 'C:\\\\smoke\\\\data\\\\cache',
        outputDir: 'C:\\\\smoke\\\\data\\\\gifs',
        logsDir: 'C:\\\\smoke\\\\data\\\\logs',
        tools: {
          ffmpeg: 'ffmpeg.exe',
          gifski: 'gifski.exe',
          gifsicle: 'gifsicle.exe',
          ffmpegVersion: 'ffmpeg version smoke',
          gifskiVersion: 'gifski smoke',
          gifsicleVersion: 'LCDF Gifsicle smoke',
          ready: true,
          missing: [],
        },
      }),
      toggleDevTools: async () => {},
      openOutputDir: async () => ({ ok: true, data: 'C:\\\\smoke\\\\data\\\\gifs' }),
      openCacheDir: async () => ({ ok: true, data: 'C:\\\\smoke\\\\data\\\\cache' }),
    },
    tweet: { fetch: async () => ({ ok: false, error: '冒烟环境不联网', code: 'SMOKE' }) },
    media: {
      prepare: async () => ({ ok: false, error: '冒烟环境不联网', code: 'SMOKE' }),
      toDisplayUrl: async () => '',
      save: async () => ({ ok: false, error: '冒烟环境不保存媒体', code: 'SMOKE' }),
    },
    gif: {
      convert: async () => ({ ok: false, error: '冒烟环境不转换', code: 'SMOKE' }),
      info: async () => ({ ok: false, error: '冒烟环境不转换', code: 'SMOKE' }),
      exportAs: async () => ({ ok: false, error: '冒烟环境不转换', code: 'SMOKE' }),
      open: async () => ({ ok: true, data: true }),
      reveal: async () => ({ ok: true, data: true }),
      remove: async () => ({ ok: true, data: true }),
      copyPath: async () => ({ ok: true, data: true }),
    },
    history: {
      list: async () => okData(list),
      get: async () => okData(null),
      remove: async () => okData(true),
      removeResult: async () => okData(true),
      removeSaved: async () => okData(true),
      clear: async () => okData(true),
    },
    settings: {
      get: async () => ({
        ok: true,
        data: {
          outputDir: null,
          cacheDir: null,
          defaultParams: {},
          defaultPresetId: 'source',
          keepOriginalMp4: true,
          maxCacheSizeMb: 4096,
          theme: 'dark',
          proxy: { mode: 'system', url: '', bypass: 'localhost;127.0.0.1;<local>', username: '', password: '' },
        },
      }),
      save: async (value) => okData(value),
      chooseDirectory: async () => okData(null),
    },
    jobs: { cancel: async () => okData(true), onProgress: () => () => {} },
    clipboard: { writeText: async () => okData(true) },
    window: {
      minimize: async () => {},
      toggleMaximize: async () => false,
      isMaximized: async () => false,
      close: async () => {},
      onMaximizedChange: () => () => {},
    },
  }
}

/** 创建 jsdom 页面并执行 bundle，返回 window 与错误收集器 */
function boot({ withBridge }) {
  const runtimeErrors = []
  const consoleMessages = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('error', (...args) => consoleMessages.push('[error] ' + args.map(String).join(' ')))
  virtualConsole.on('warn', (...args) => consoleMessages.push('[warn] ' + args.map(String).join(' ')))
  virtualConsole.on('jsdomError', (error) => consoleMessages.push('[jsdomError] ' + error.message))

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  })
  const { window } = dom
  // React 19 依据 process.env.NODE_ENV 选择 development/production 实现
  window.process = { env: { NODE_ENV: 'production' } }
  window.global = window
  window.addEventListener('error', (event) => runtimeErrors.push('error: ' + (event.message || String(event.error))))
  window.addEventListener('unhandledrejection', (event) => runtimeErrors.push('promise: ' + String(event.reason)))
  try {
    if (!window.crypto) window.crypto = {}
    if (!window.crypto.randomUUID) {
      Object.defineProperty(window.crypto, 'randomUUID', {
        configurable: true,
        value: () => '00000000-0000-4000-8000-000000000000',
      })
    }
  } catch {
    /* 忽略；界面只会在转换时用到 randomUUID */
  }
  if (withBridge) window.desktop = makeDesktopBridge()

  let exception = null
  try {
    window.eval(bundle)
  } catch (error) {
    exception = error && error.stack ? error.stack : String(error)
  }
  return { dom, window, runtimeErrors, consoleMessages, exception }
}

async function waitForRender(window, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const mount = window.document.getElementById('root')
    if (mount && mount.innerHTML.length > 100) return true
    await sleep(100)
  }
  return false
}

function snapshot(window, label) {
  const doc = window.document
  const mount = doc.getElementById('root')
  const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  return {
    label,
    mounted: Boolean(mount && mount.innerHTML.length > 0),
    rootLength: mount ? mount.innerHTML.length : 0,
    textLength: text.length,
    text,
  }
}

function clickByText(doc, keyword) {
  const candidates = Array.from(doc.querySelectorAll('button, a, [role="button"], [role="tab"], li, div'))
  const target = candidates.find((node) => {
    const own = (node.textContent || '').replace(/\s+/g, '')
    if (!own.includes(keyword)) return false
    if (own.length > keyword.length * 6) return false
    if (node.closest('button, a, [role="button"], [role="tab"]')) {
      const interactive = node.closest('button, a, [role="button"], [role="tab"]')
      return (interactive.textContent || '').replace(/\s+/g, '').includes(keyword)
    }
    return false
  })
  if (!target) return false
  const interactive = target.closest('button, a, [role="button"], [role="tab"]')
  if (!interactive) return false
  interactive.click()
  return true
}

const requiredKeywords = ['X 媒体工坊', '解析', '历史', '设置', '保存', '导出 GIF']
const navKeywords = ['解析', '历史', '设置']

const results = []
const failures = []

// ---------------------------------------------------------------------------
// 场景 1：有桌面桥接（正常桌面环境）
// ---------------------------------------------------------------------------
const main = boot({ withBridge: true })
await waitForRender(main.window)
await sleep(400)

const mainSnapshot = snapshot(main.window, '主界面（有桌面桥接）')
results.push(mainSnapshot)
if (main.exception) failures.push('bundle 执行抛出异常：' + main.exception.split('\n')[0])

const mounted = mainSnapshot.mounted && mainSnapshot.rootLength > 100
if (!mounted) failures.push('主界面未渲染：#root 内容为空或过短')

for (const keyword of requiredKeywords) {
  if (!mainSnapshot.text.includes(keyword)) failures.push('界面缺少关键文案「' + keyword + '」')
}

if (main.runtimeErrors.length > 0) failures.push('主界面存在运行时错误：' + JSON.stringify(main.runtimeErrors.slice(0, 5)))
if (main.window.document.querySelector('.error-boundary')) {
  const boundaryText = (main.window.document.querySelector('.error-boundary').textContent || '').replace(/\s+/g, ' ').trim()
  failures.push('主界面出现 ErrorBoundary 渲染兜底：' + boundaryText.slice(0, 200))
}

// 左侧导航点击（能找到才点，找不到不单独判失败——文案检查已覆盖）
const navResults = []
for (const keyword of navKeywords) {
  const before = main.window.document.body.textContent || ''
  const clicked = clickByText(main.window.document, keyword)
  if (!clicked) {
    navResults.push({ label: '导航-' + keyword, clicked: false, changed: false })
    continue
  }
  await sleep(350)
  const after = main.window.document.body.textContent || ''
  const afterSnapshot = snapshot(main.window, '导航-' + keyword)
  navResults.push({ label: '导航-' + keyword, clicked: true, changed: before !== after, rootLength: afterSnapshot.rootLength, text: afterSnapshot.text.slice(0, 160) })
  if (!afterSnapshot.mounted || afterSnapshot.rootLength < 100) {
    failures.push('点击「' + keyword + '」后界面变空（渲染崩溃）')
  }
}
results.push({ label: '导航点击', text: JSON.stringify(navResults.map((item) => item.label + ':' + (item.clicked ? '已点击' : '未找到') + (item.changed ? '/内容变化' : '')), null, 0) })
if (main.runtimeErrors.length > 0) failures.push('导航操作后存在运行时错误：' + JSON.stringify(main.runtimeErrors.slice(0, 5)))

// ---------------------------------------------------------------------------
// 场景 2：没有桌面桥接（浏览器 / 冒烟环境）→ 必须显示友好提示而不是崩溃
// ---------------------------------------------------------------------------
const noBridge = boot({ withBridge: false })
await waitForRender(noBridge.window)
await sleep(400)
const noBridgeSnapshot = snapshot(noBridge.window, '无桌面桥接降级')
results.push(noBridgeSnapshot)
if (noBridge.exception) failures.push('无桥接时 bundle 执行抛出异常：' + noBridge.exception.split('\n')[0])
if (!noBridgeSnapshot.mounted || noBridgeSnapshot.rootLength < 100) {
  failures.push('没有 window.desktop 桥接时界面未渲染（应显示友好错误提示）')
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
const consoleErrors = [...main.consoleMessages, ...noBridge.consoleMessages].filter(
  (line) => line.startsWith('[error]') || line.startsWith('[jsdomError]'),
)
const mainConsoleErrors = main.consoleMessages.filter((line) => line.startsWith('[error]') || line.startsWith('[jsdomError]'))
if (mainConsoleErrors.length > 0) {
  failures.push('主界面控制台存在错误：' + JSON.stringify(mainConsoleErrors.slice(0, 3)))
}
const report = {
  ok: failures.length === 0,
  failures,
  consoleErrors,
  runtimeErrors: [...main.runtimeErrors, ...noBridge.runtimeErrors],
  pages: results.map((item) => ({ label: item.label, rootLength: item.rootLength, textLength: item.textLength, text: item.text.slice(0, 200) })),
  nav: navResults,
}

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const item of results) {
    console.log('  ' + item.label + '：' + (item.text || '').slice(0, 120))
  }
  if (verbose) {
    console.log('')
    console.log('--- console（主界面）---')
    for (const line of main.consoleMessages) console.log(line)
  }
  console.log('')
  if (failures.length > 0) {
    console.error('[smoke] 失败：')
    for (const failure of failures) console.error('  - ' + failure)
  } else {
    console.log('[smoke] 通过：界面渲染正常 ✓')
  }
}
process.exit(failures.length === 0 ? 0 : 1)