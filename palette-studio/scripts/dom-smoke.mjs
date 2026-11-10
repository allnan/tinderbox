import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

/**
 * 不用 Electron 的渲染冒烟测试：
 * 在 jsdom 中执行打包后的 dist/assets/app.js，检查 React 是否能正常渲染：
 * 项目总览 → 打开项目 → 6 个标签页 → 设置页。
 * 用法：node scripts/dom-smoke.mjs [--verbose] [--json]
 * 先运行 node scripts/build.mjs 生成 dist。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const verbose = process.argv.includes('--verbose')
const jsonOnly = process.argv.includes('--json')

const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8')
const bundle = fs.readFileSync(path.join(root, 'dist', 'assets', 'app.js'), 'utf8')

const consoleMessages = []
const virtualConsole = new VirtualConsole()
virtualConsole.on('error', (...args) => consoleMessages.push(`[error] ${args.map(String).join(' ')}`))
virtualConsole.on('warn', (...args) => consoleMessages.push(`[warn] ${args.map(String).join(' ')}`))
virtualConsole.on('log', (...args) => consoleMessages.push(`[log] ${args.map(String).join(' ')}`))
virtualConsole.on('jsdomError', (err) => consoleMessages.push(`[jsdomError] ${err.message}`))

const plainHtml = html.replace(/<script[\s\S]*?<\/script>/g, '')
const dom = new JSDOM(plainHtml, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
})
const { window } = dom
window.process = { env: { NODE_ENV: 'production' } }
window.global = window
window.eval(`
  window.__ERRORS__ = [];
  window.addEventListener('error', (e) => window.__ERRORS__.push(String(e.message) + ' @ ' + (e.filename || '') + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('promise: ' + String(e.reason)));
`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const doc = window.document

try {
  window.eval(bundle)
} catch (err) {
  console.error(`[dom-smoke] bundle 执行失败：${err && err.stack ? err.stack : err}`)
  process.exit(1)
}
await sleep(1200)

const snapshot = (label) => {
  const text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim()
  return {
    label,
    rootLength: doc.getElementById('root')?.innerHTML.length ?? 0,
    textLength: text.length,
    text: text.slice(0, 220),
    errors: [...(window.__ERRORS__ || [])],
  }
}

const results = []
results.push(snapshot('项目总览'))

// 打开第一个项目
const card = doc.querySelector('.project-card')
if (!card) {
  results.push({ label: '打开项目', text: '找不到 .project-card', errors: ['缺少项目卡片'] })
} else {
  card.click()
  await sleep(600)
  results.push(snapshot('项目工作台'))

  const tabs = doc.querySelectorAll('.tab')
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = doc.querySelectorAll('.tab')[index]
    if (!tab) continue
    tab.click()
    await sleep(500)
    results.push(snapshot(`标签页 ${index + 1}：${(tab.textContent || '').trim()}`))
  }
}

// 设置页
const settingsButton = doc.querySelectorAll('.sidebar-foot-btn')[0]
if (settingsButton) {
  settingsButton.click()
  await sleep(500)
  results.push(snapshot('设置页'))
}

// 独立预览窗口路由（?view=preview）：没有 Electron 桥接时应渲染降级提示
try {
  const previewErrors = []
  const previewConsole = new VirtualConsole()
  previewConsole.on('error', (...args) => previewErrors.push(args.map(String).join(' ')))
  previewConsole.on('jsdomError', (err) => previewErrors.push(`[jsdomError] ${err.message}`))
  const previewDom = new JSDOM(plainHtml, {
    url: 'http://localhost/?view=preview',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: previewConsole,
  })
  const previewWindow = previewDom.window
  previewWindow.process = { env: { NODE_ENV: 'production' } }
  previewWindow.global = previewWindow
  previewWindow.eval(
    `window.__ERRORS__ = [];
     window.addEventListener('error', (e) => window.__ERRORS__.push(String(e.message)));
     window.addEventListener('unhandledrejection', (e) => window.__ERRORS__.push('promise: ' + String(e.reason)));`,
  )
  previewWindow.eval(bundle)
  await sleep(900)
  const previewDoc = previewWindow.document
  results.push({
    label: '独立预览窗口（无桥接降级）',
    rootLength: previewDoc.getElementById('root')?.innerHTML.length ?? 0,
    textLength: (previewDoc.body.textContent || '').replace(/\s+/g, ' ').trim().length,
    text: (previewDoc.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    errors: [...previewErrors, ...(previewWindow.__ERRORS__ || [])],
  })
} catch (err) {
  results.push({
    label: '独立预览窗口（无桥接降级）',
    rootLength: 0,
    textLength: 0,
    text: String(err && err.message ? err.message : err),
    errors: ['预览路由渲染失败'],
  })
}

const failures = []
for (const item of results) {
  if (item.rootLength < 500) failures.push(`${item.label}：root 内容为空（渲染崩溃）`)
  if (item.errors.length > 0) failures.push(`${item.label}：运行时错误 ${JSON.stringify(item.errors)}`)
}

const report = {
  ok: failures.length === 0,
  failures,
  consoleErrors: consoleMessages.filter((line) => line.startsWith('[error]') || line.startsWith('[jsdomError]')),
  pages: results.map((item) => ({ label: item.label, textLength: item.textLength, text: item.text, errors: item.errors })),
}

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const item of results) {
    const status = item.errors.length === 0 && item.rootLength >= 500 ? '✓' : '✗'
    console.log(`${status} ${item.label}  [${item.textLength} 字符] ${item.text.slice(0, 110)}`)
    for (const error of item.errors) console.log(`    ! ${error}`)
  }
  if (verbose && consoleMessages.length) {
    console.log('\n--- console ---')
    console.log(consoleMessages.join('\n'))
  }
  console.log('')
  if (failures.length) {
    console.error('[dom-smoke] 失败：')
    for (const failure of failures) console.error(`  - ${failure}`)
  } else {
    console.log('[dom-smoke] 全部页面渲染通过 ✓')
  }
}

process.exit(failures.length ? 1 : 0)
