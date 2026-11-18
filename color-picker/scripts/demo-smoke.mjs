import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

/**
 * 演示页冒烟：在 jsdom 里执行打包后的 demo.js，确认 React 能挂载、
 * 主题切换与打开取色器可用。不需要浏览器，也不依赖 canvas。
 *
 * 用法：node scripts/demo-smoke.mjs（先 npm run demo）
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const htmlPath = path.join(root, 'demo', 'index.html')
const bundlePath = path.join(root, 'demo', 'dist', 'demo.js')
for (const file of [htmlPath, bundlePath]) {
  if (!fs.existsSync(file)) {
    console.error(`[demo-smoke] 缺少 ${path.relative(root, file)}，请先运行 npm run demo`)
    process.exit(1)
  }
}

const consoleMessages = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('error', (...args) => consoleMessages.push(`[error] ${args.map(String).join(' ')}`))
virtualConsole.on('warn', (...args) => consoleMessages.push(`[warn] ${args.map(String).join(' ')}`))
virtualConsole.on('jsdomError', (error) => consoleMessages.push(`[jsdomError] ${error.message}`))

const html = fs.readFileSync(htmlPath, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
})
const { window } = dom
window.process = { env: { NODE_ENV: 'production' } }
window.global = window
// jsdom 没有 canvas：取色器与演示页都应优雅降级
window.HTMLCanvasElement.prototype.getContext = () => null
window.eval(`
  window.__ERRORS__ = [];
  window.addEventListener('error', (event) => window.__ERRORS__.push(String(event.message)));
  window.addEventListener('unhandledrejection', (event) => window.__ERRORS__.push('promise: ' + String(event.reason)));
`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const doc = window.document

const failures = []
try {
  window.eval(fs.readFileSync(bundlePath, 'utf8'))
} catch (error) {
  failures.push(`bundle 执行失败：${error && error.stack ? error.stack : error}`)
}
await sleep(900)

const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
if (!text.includes('取色器')) failures.push('页面没有渲染出「取色器」标题')
if (!text.includes('OKLCH')) failures.push('页面没有渲染出 OKLCH 色域图区块')
if (!doc.querySelector('.demo-shell')) failures.push('缺少 .demo-shell')

// 深色主题切换
const darkButton = [...doc.querySelectorAll('.demo-theme-switch button')].find((button) => button.textContent === '深色')
if (!darkButton) {
  failures.push('找不到深色主题按钮')
} else {
  darkButton.click()
  await sleep(120)
  if (!doc.querySelector('.demo-shell.is-dark')) failures.push('点击深色后没有切换主题')
}

// 打开第一个取色器（默认全彩）
const trigger = doc.querySelector('.cp-trigger')
if (!trigger) {
  failures.push('演示页没有渲染触发色块')
} else {
  trigger.click()
  await sleep(250)
  if (!doc.querySelector('.cp-popover')) failures.push('点击触发块后没有打开取色器')
  if (doc.querySelectorAll('.cp-mode-tab').length !== 3) failures.push('取色器没有渲染 3 个模式 tab')
  const closeTrigger = doc.querySelector('.cp-trigger')
  if (closeTrigger) closeTrigger.click()
}

const runtimeErrors = [...(window.__ERRORS__ || [])]
const consoleErrors = consoleMessages.filter((line) => line.startsWith('[error]') || line.startsWith('[jsdomError]'))
for (const error of [...runtimeErrors, ...consoleErrors]) failures.push(`运行时错误：${error}`)

if (failures.length) {
  console.error('[demo-smoke] 失败：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`[demo-smoke] 演示页渲染与交互通过 ✓（正文 ${text.length} 字符）`)
