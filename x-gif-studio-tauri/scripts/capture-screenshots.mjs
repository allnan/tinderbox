#!/usr/bin/env node
/**
 * 真实功能验证 + 截图：启动 release exe，通过 WebView2 远程调试协议驱动真实界面，
 * 真实解析 X 推文、下载并保存原文件、实际转出 GIF / WebP，并校验产物文件。
 *
 * 用法：node scripts/capture-screenshots.mjs [exe路径]
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const exePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, 'release', 'XMediaStudioTauri.exe')
const shotDir = path.join(projectRoot, 'docs', 'assets', 'screenshots')
const debugPort = Number(process.env.TAURI_PREVIEW_DEBUG_PORT || 9222)
const exeDir = path.dirname(exePath)

const VIDEO_TWEET = 'https://x.com/CaptainAmerica/status/719944021058060289'
const PHOTO_TWEET = 'https://x.com/NASA/status/2121280846183137564'

const report = { exe: exePath, startedAt: new Date().toISOString(), checks: [], screenshots: [], consoleErrors: [], page: {}, history: null, files: [], tools: null }

function log(message) { console.log('[verify] ' + message) }
function record(name, passed, detail) {
  report.checks.push({ name: name, passed: Boolean(passed), detail: detail || '' })
  log((passed ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''))
}

function evalLines(lines) { return lines.join('\n') }

async function main() {
  await mkdir(shotDir, { recursive: true })
  await killExisting()
  await rm(path.join(exeDir, 'userdata'), { recursive: true, force: true }).catch(() => undefined)
  const child = spawn(exePath, [], {
    cwd: exeDir,
    env: Object.assign({}, process.env, { XGIF_TAURI_DEBUG_PORT: String(debugPort) }),
    stdio: 'ignore',
    windowsHide: false,
  })
  let exitReason = ''
  child.once('exit', (code, signal) => { exitReason = 'exit code=' + code + ' signal=' + signal })
  try {
    const target = await waitForDebugTarget(60000)
    log('连接页面：' + target.url)
    const cdp = new CdpClient(target.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Log.enable')
    cdp.on('Runtime.exceptionThrown', (params) => {
      const detail = params.exceptionDetails && params.exceptionDetails.exception
      report.consoleErrors.push('exception: ' + ((detail && detail.description) || (params.exceptionDetails && params.exceptionDetails.text) || '未知'))
    })
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry && params.entry.level === 'error') report.consoleErrors.push('log: ' + params.entry.text)
    })

    await waitFor(cdp, '!!document.querySelector("[data-testid=parse-home]")', 40000, '解析首页渲染')
    await waitForImages(cdp)
    await delay(600)
    const pageState = await cdp.evaluate(evalLines([
      '(function () {',
      '  return {',
      '    title: document.title,',
      '    viewport: window.innerWidth + "x" + window.innerHeight,',
      '    hasApp: !!document.querySelector(".app"),',
      '    hasDesktop: !!(window.desktop && window.desktop.isDesktop === true),',
      '    hasRealMarker: !!(window.__XGIF_TAURI__ && window.__XGIF_TAURI__.isTauri),',
      '    hasMockMarker: !!window.__XGIF_TAURI_PREVIEW__',
      '  };',
      '})()',
    ]))
    report.page = pageState
    record('页面无白屏且真实桥接已注入', pageState.hasApp && pageState.hasDesktop && pageState.hasRealMarker && !pageState.hasMockMarker, pageState.viewport)
    await shot(cdp, 'real-01-home.png')

    const info = JSON.parse(await cdp.evaluate('(async function(){ var r = await window.desktop.app.info(); return JSON.stringify(r); })()'))
    const tools = info && info.ok ? info.data.tools : null
    report.tools = tools
    record('真实读取外部工具状态', Boolean(tools && tools.ready), tools ? 'ffmpeg=' + tools.ffmpeg + ' gifski=' + tools.gifski + ' gifsicle=' + tools.gifsicle : '无')
    record('真实桥接生效（旧预览版标记不存在）', pageState.hasMockMarker === false)

    await click(cdp, '[data-nav="settings"]')
    await waitFor(cdp, '!!document.querySelector("[data-view=settings]")', 10000, '设置页')
    await delay(700)
    await shot(cdp, 'real-02-settings.png')

    await click(cdp, '[data-nav="new-parse"]')
    await waitFor(cdp, '!!document.querySelector("[data-testid=tweet-url-input]")', 10000, '输入框')
    await fillTweetUrl(cdp, VIDEO_TWEET)
    await click(cdp, '[data-testid=fetch-button]')
    await waitFor(cdp, '!!document.querySelector("[data-testid=parse-result]")', 45000, '真实推文解析结果')
    await waitForImages(cdp)
    await delay(900)
    await shot(cdp, 'real-03-parse-result.png')
    const parseState = await cdp.evaluate(evalLines([
      '(function () {',
      '  return {',
      '    author: (document.querySelector(".tweet-author-name") || {}).innerText || "",',
      '    media: document.querySelectorAll(".media-card").length,',
      '    text: ((document.querySelector(".tweet-text") || {}).innerText || "").slice(0, 120),',
      '    thumbs: document.querySelectorAll(".media-card img").length',
      '  };',
      '})()',
    ]))
    record('真实推文解析（fxtwitter）', parseState.media >= 1 && parseState.author.length > 0, '@' + parseState.author + ' 媒体 ' + parseState.media + ' 个 / ' + parseState.text)

    await clickText(cdp, '保存所选')
    await waitFor(cdp, 'document.querySelectorAll(".media-card .media-saved-icon:not(.is-saving)").length >= 1', 180000, '原文件保存完成')
    const historyAfterSave = await readHistory(cdp)
    const savedFiles = collectSaved(historyAfterSave)
    record('真实下载并保存原始媒体文件', savedFiles.length >= 1 && (await allExist(savedFiles)), savedFiles.join(' | '))
    await delay(700)
    await shot(cdp, 'real-04-saved-media.png')

    await click(cdp, '[data-testid=batch-convert-button]')
    await waitFor(cdp, '!!document.querySelector("[data-testid=convert-drawer]")', 15000, '转换抽屉')
    // 真实采样体积预估：有本地源文件时先显示「估算中…」，再替换为 gifski 采样编码结果。
    // 注意要等 live 状态（首帧可能还是 fallback，短轮询会误判）；若一直 fallback 最多等 8 秒。
    const estimateDeadline = Date.now() + 120000
    const estimateStarted = Date.now()
    let estimateState = null
    while (Date.now() < estimateDeadline) {
      estimateState = await cdp.evaluate(
        '(function () { var el = document.querySelector("[data-testid=param-estimate-text]"); return el ? { state: el.getAttribute("data-estimate-state"), bytes: Number(el.getAttribute("data-estimate-bytes") || 0), text: el.innerText || "" } : null; })()',
      )
      if (estimateState && estimateState.state === 'live') break
      if (estimateState && estimateState.state === 'fallback' && Date.now() - estimateStarted > 8000) break
      await delay(200)
    }
    report.estimate = estimateState
    record(
      '转换抽屉显示采样编码体积预估',
      Boolean(estimateState && estimateState.state === 'live' && estimateState.bytes > 0),
      estimateState ? estimateState.text : '未找到预估元素',
    )
    await delay(400)
    await shot(cdp, 'real-05-convert-drawer.png')
    await click(cdp, '[data-testid=start-convert-button]')
    await waitFor(cdp, 'document.querySelectorAll(".result-card").length >= 1', 300000, 'GIF 转换完成')
    await delay(900)
    await shot(cdp, 'real-06-gif-result.png')
    const historyAfterGif = await readHistory(cdp)
    const gifFile = collectResults(historyAfterGif, 'gif')[0]
    if (gifFile) report.files.push(gifFile)
    const gifCheck = gifFile ? probeWithFfmpeg(gifFile) : { ok: false, detail: '未找到 GIF 结果' }
    const gifSize = gifFile ? await fileSize(gifFile) : 0
    record('真实转出 GIF 文件', Boolean(gifFile) && (await fileExists(gifFile)) && gifCheck.ok, (gifFile || '') + '；' + gifCheck.detail + '；' + Math.round(gifSize / 1024) + ' KB')
    const estimatedBytes = report.estimate && report.estimate.bytes > 0 ? report.estimate.bytes : 0
    if (estimatedBytes > 0 && gifSize > 0) {
      const errorPct = Math.round(((estimatedBytes / gifSize) - 1) * 1000) / 10
      report.estimateComparison = { estimatedBytes: estimatedBytes, actualBytes: gifSize, errorPct: errorPct }
      record(
        '体积预估与实际 GIF 误差 < 20%',
        Math.abs(errorPct) < 20,
        '预估 ' + Math.round(estimatedBytes / 1024) + ' KB / 实际 ' + Math.round(gifSize / 1024) + ' KB（' + (errorPct >= 0 ? '+' : '') + errorPct + '%）',
      )
    }

    await cdp.evaluate('(function(){ var card = document.querySelector(".media-card"); if (card) card.click(); })()')
    await click(cdp, '[data-testid=batch-convert-button]')
    await waitFor(cdp, '!!document.querySelector("[data-testid=convert-drawer]")', 15000, '转换抽屉(WebP)')
    await click(cdp, '[data-testid=format-tab-webp]')
    await delay(700)
    const webpEstimate = await cdp.evaluate(
      '(function () { var el = document.querySelector("[data-testid=param-estimate-text]"); return el ? { state: el.getAttribute("data-estimate-state"), bytes: Number(el.getAttribute("data-estimate-bytes") || 0), text: el.innerText || "" } : null; })()',
    )
    record(
      'WebP 输出保留经验公式（不触发采样预估）',
      Boolean(webpEstimate && webpEstimate.state === 'fallback' && webpEstimate.bytes === 0),
      webpEstimate ? webpEstimate.state + ' / ' + webpEstimate.text : '未找到预估元素',
    )
    await click(cdp, '[data-testid=start-convert-button]')
    await waitFor(cdp, 'document.querySelectorAll(".result-card").length >= 2', 300000, 'WebP 转换完成')
    await delay(900)
    await shot(cdp, 'real-07-webp-result.png')
    const historyAfterWebp = await readHistory(cdp)
    const webpFile = collectResults(historyAfterWebp, 'webp')[0]
    if (webpFile) report.files.push(webpFile)
    const webpCheck = webpFile ? probeWithFfmpeg(webpFile) : { ok: false, detail: '未找到 WebP 结果' }
    const webpSize = webpFile ? await fileSize(webpFile) : 0
    record('真实转出 WebP 文件', Boolean(webpFile) && (await fileExists(webpFile)) && webpCheck.ok, (webpFile || '') + '；' + webpCheck.detail + '；' + Math.round(webpSize / 1024) + ' KB')

    await click(cdp, '[data-nav="history"]')
    await waitFor(cdp, '!!document.querySelector("[data-view=history]")', 10000, '历史页')
    await waitFor(cdp, 'document.querySelectorAll(".history-group").length >= 1', 10000, '历史分组')
    await delay(700)
    await shot(cdp, 'real-08-history.png')

    await click(cdp, '[data-nav="new-parse"]')
    await waitFor(cdp, '!!document.querySelector("[data-testid=tweet-url-input]")', 10000, '输入框(图片)')
    await fillTweetUrl(cdp, PHOTO_TWEET)
    await click(cdp, '[data-testid=fetch-button]')
    await waitFor(cdp, '!!document.querySelector("[data-testid=parse-result]")', 45000, '图片推文解析')
    await waitForImages(cdp)
    await delay(700)
    await shot(cdp, 'real-09-photo-tweet.png')
    await clickText(cdp, '保存所选')
    await waitFor(cdp, 'document.querySelectorAll(".media-card .media-saved-icon:not(.is-saving)").length >= 1', 180000, '图片保存完成')
    const historyAfterPhoto = await readHistory(cdp)
    const savedAfterPhoto = collectSaved(historyAfterPhoto)
    const photoFile = savedAfterPhoto.find((file) => /\.(jpg|jpeg|png|webp)$/i.test(file))
    if (photoFile) report.files.push(photoFile)
    record('真实保存推文图片', Boolean(photoFile) && (await fileExists(photoFile)), photoFile || '未找到图片文件')

    const gifskiPath = path.join(exeDir, 'tools', 'gifski.exe')
    let downloadVerified = false
    if (await fileExists(gifskiPath)) {
      await renameWithRetry(gifskiPath, gifskiPath + '.bak')
      try {
        await click(cdp, '[data-nav="settings"]')
        await waitFor(cdp, '!!document.querySelector("[data-testid=tool-download-button]")', 15000, '工具按钮')
        await click(cdp, '[data-testid=tool-download-button]')
        await waitFor(cdp, '!!document.querySelector("[data-testid=tool-download-state]")', 30000, '下载进度')
        await delay(700)
        await shot(cdp, 'real-10-tool-download.png')
        await waitFor(cdp, '!!document.querySelector(".tool-download-state.is-success")', 600000, '工具下载完成')
        await delay(1200)
        const infoAfter = JSON.parse(await cdp.evaluate('(async function(){ var r = await window.desktop.app.info(); return JSON.stringify(r); })()'))
        downloadVerified = Boolean(infoAfter && infoAfter.ok && infoAfter.data.tools.gifski && (await fileExists(gifskiPath)))
        record('真实工具一键下载（删除 gifski 后重新下载并校验）', downloadVerified, gifskiPath)
      } finally {
        if (!(await fileExists(gifskiPath)) && (await fileExists(gifskiPath + '.bak'))) await renameWithRetry(gifskiPath + '.bak', gifskiPath)
      }
    } else {
      record('真实工具一键下载（删除 gifski 后重新下载并校验）', false, 'gifski.exe 不存在，跳过')
    }

    const beforeMax = await cdp.evaluate('window.desktop.window.isMaximized()')
    const toggled = await cdp.evaluate('window.desktop.window.toggleMaximize()')
    await delay(600)
    const maximized = await cdp.evaluate('window.desktop.window.isMaximized()')
    await cdp.evaluate('window.desktop.window.toggleMaximize()')
    await delay(400)
    record('窗口最大化/还原命令', beforeMax === false && toggled === true && maximized === true, 'maximized=' + maximized)

    report.history = await readHistory(cdp)
    report.consoleErrors = report.consoleErrors.filter((text) => text.indexOf('favicon') < 0)
    record('页面无脚本异常', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '))

    try { await cdp.evaluate('window.desktop.window.close(); "closing"') } catch (error) {}
    record('窗口关闭命令（进程退出）', await waitProcessExit(child, 10000), exitReason)
    await writeReport()
    printSummary()
  } finally {
    await killTree(child)
    await writeReport()
  }
}

async function fillTweetUrl(cdp, url) {
  const expression = evalLines([
    '(function () {',
    '  var el = document.querySelector("[data-testid=tweet-url-input]");',
    '  var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;',
    '  setter.call(el, ' + JSON.stringify(url) + ');',
    '  el.dispatchEvent(new Event("input", { bubbles: true }));',
    '  return el.value;',
    '})()',
  ])
  const filled = await cdp.evaluate(expression)
  if (filled !== url) throw new Error('链接填入失败')
  await waitFor(cdp, '!document.querySelector("[data-testid=fetch-button]").disabled', 8000, '解析按钮可用')
}

async function readHistory(cdp) {
  const text = await cdp.evaluate('(async function(){ var r = await window.desktop.history.list(); return JSON.stringify(r); })()')
  const parsed = JSON.parse(text)
  return parsed.ok ? parsed.data : []
}
function collectSaved(history) {
  const files = []
  for (const entry of history) for (const item of entry.savedMedia || []) if (item.filePath) files.push(item.filePath)
  return files
}
function collectResults(history, format) {
  const files = []
  for (const entry of history) for (const item of entry.results || []) if ((item.format || 'gif') === format && item.gifPath) files.push(item.gifPath)
  return files
}
async function fileExists(file) {
  try { const info = await stat(file); return info.isFile() && info.size > 0 } catch (error) { return false }
}
async function fileSize(file) {
  try { const info = await stat(file); return info.size } catch (error) { return 0 }
}
async function allExist(files) {
  for (const file of files) if (!(await fileExists(file))) return false
  return true
}
async function renameWithRetry(source, target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await rename(source, target); return true } catch (error) { await delay(400) }
  }
  return false
}
function probeWithFfmpeg(file) {
  const ffmpeg = path.join(exeDir, 'tools', 'ffmpeg.exe')
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  const text = String(result.stderr || '')
  const stream = text.split(/\r?\n/).find((line) => /Video:/.test(line))
  const duration = text.match(/Duration:\s*([0-9:.]+)/)
  if (!stream) return { ok: false, detail: 'ffmpeg 未识别到视频流' }
  return { ok: true, detail: stream.trim() + (duration ? ' / ' + duration[1] : '') }
}

class CdpClient {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); this.eventHandlers = new Map(); this.ws = null }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
      ws.addEventListener('message', (event) => {
        let message
        try { message = JSON.parse(String(event.data)) } catch (error) { return }
        if (message.id) {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error(message.error.message || 'CDP 调用失败'))
          else pending.resolve(message.result)
          return
        }
        const handlers = this.eventHandlers.get(message.method)
        if (handlers) handlers.forEach((handler) => handler(message.params))
      })
    })
  }
  on(method, handler) {
    const list = this.eventHandlers.get(method) || []
    list.push(handler)
    this.eventHandlers.set(method, list)
  }
  send(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject })
      this.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }))
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      throw new Error('页面脚本执行失败：' + (description || result.exceptionDetails.text || '未知错误'))
    }
    return result.result ? result.result.value : undefined
  }
  async screenshot(fileName) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    const target = path.join(shotDir, fileName)
    await writeFile(target, Buffer.from(result.data, 'base64'))
    report.screenshots.push(target)
    log('截图：' + target)
  }
}

async function waitForDebugTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + debugPort + '/json/list')
      const targets = await response.json()
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch (error) { lastError = error }
    await delay(400)
  }
  throw new Error('未能连接 WebView2 远程调试端口：' + (lastError ? lastError.message : '超时'))
}
async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate(expression)) return true } catch (error) {}
    await delay(200)
  }
  throw new Error('等待超时：' + label)
}
async function waitForImages(cdp) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const done = await cdp.evaluate('Array.prototype.every.call(document.images, function (img) { return img.complete || !img.src; })')
    if (done) return
    await delay(200)
  }
}
async function click(cdp, selector) {
  const clicked = await cdp.evaluate('(function () { var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return false; el.click(); return true; })()')
  if (!clicked) throw new Error('找不到可点击元素：' + selector)
  await delay(200)
}
async function clickText(cdp, text) {
  const target = text.replace(/\s+/g, '')
  const clicked = await cdp.evaluate(evalLines([
    '(function () {',
    '  var nodes = document.querySelectorAll("button, [role=button]");',
    '  for (var i = 0; i < nodes.length; i += 1) {',
    '    var content = (nodes[i].innerText || "").replace(/\\s+/g, "");',
    '    if (content.indexOf(' + JSON.stringify(target) + ') >= 0) { nodes[i].click(); return true; }',
    '  }',
    '  return false;',
    '})()',
  ]))
  if (!clicked) throw new Error('找不到文本按钮：' + text)
  await delay(250)
}
async function shot(cdp, fileName) { await cdp.screenshot(fileName) }

async function killExisting() {
  await new Promise((resolve) => {
    const proc = spawn('taskkill', ['/IM', path.basename(exePath), '/T', '/F'], { stdio: 'ignore' })
    proc.once('exit', () => resolve())
    proc.once('error', () => resolve())
  })
  await delay(400)
}
async function killTree(child) {
  if (!child || child.exitCode !== null) return
  await new Promise((resolve) => {
    const proc = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    proc.once('exit', () => resolve())
    proc.once('error', () => resolve())
  })
}
function waitProcessExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}
async function writeReport() {
  report.finishedAt = new Date().toISOString()
  await mkdir(path.join(projectRoot, '.shots'), { recursive: true })
  await writeFile(path.join(projectRoot, '.shots', 'verify.json'), JSON.stringify(report, null, 2), 'utf8')
}
function printSummary() {
  const passed = report.checks.filter((item) => item.passed).length
  console.log('')
  console.log('========== 真实功能验证摘要 ==========')
  console.log('检查项：' + passed + '/' + report.checks.length + ' 通过')
  report.checks.forEach((item) => console.log((item.passed ? '  [OK] ' : '  [FAIL] ') + item.name + (item.detail ? ' — ' + item.detail : '')))
  console.log('产物文件：')
  report.files.filter(Boolean).forEach((file) => console.log('  ' + file))
  console.log('截图：')
  report.screenshots.forEach((file) => console.log('  ' + file))
  if (report.consoleErrors.length > 0) {
    console.log('页面错误：')
    report.consoleErrors.forEach((text) => console.log('  ' + text))
  }
  console.log('======================================')
}
main().catch(async (error) => {
  console.error('[verify] 失败：' + (error && error.stack ? error.stack : String(error)))
  record('整体真实功能验证', false, error && error.message ? error.message : String(error))
  await writeReport().catch(() => undefined)
  process.exitCode = 1
})