'use strict'

/**
 * X 媒体工坊 · 主进程
 * 职责：窗口与生命周期、IPC 适配、xgif:// 本地文件协议、任务进度转发、冒烟自检。
 * 业务能力全部放在 electron/lib/ 下，本文件只做适配与错误包装。
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, clipboard, protocol, net, nativeTheme } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const paths = require('./lib/paths.cjs')
const tools = require('./lib/tools.cjs')
const jobs = require('./lib/jobs.cjs')
const tweet = require('./lib/tweet.cjs')
const media = require('./lib/media.cjs')
const mp4probe = require('./lib/mp4probe.cjs')
const thumbnails = require('./lib/thumbnails.cjs')
const gif = require('./lib/gif.cjs')
const history = require('./lib/history.cjs')
const settings = require('./lib/settings.cjs')
const proxy = require('./lib/proxy.cjs')
const network = require('./lib/network.cjs')
const migrate = require('./lib/migrate.cjs')

const isSmokeRun = process.argv.some((arg) => arg.startsWith('--smoke-report'))
const screenshotPath = readArgValue('--screenshot')
const screenshotView = readArgValue('--screenshot-view')
const screenshotEval = readArgValue('--screenshot-eval')
const screenshotEvalWait = Number(readArgValue('--screenshot-eval-wait') || 2600)
const screenshotDelay = Number(readArgValue('--screenshot-delay') || 2400)
let mainWindow = null
let logger = null

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  if (logger) {
    try {
      logger.write(line + '\n')
    } catch {
      /* 忽略日志写入失败 */
    }
  }
  console.log('[main]', ...args)
}

function ok(data) {
  return { ok: true, data }
}

function fail(error, code) {
  const message = error && error.message ? error.message : String(error)
  return { ok: false, error: message, code }
}

/** 可透传给渲染层的业务错误码（其余统一用通道级 code，避免泄露内部实现细节） */
const PASS_THROUGH_CODES = new Set(['CANCELLED', 'TOOLS_MISSING', 'INVALID_URL', 'TWEET_NOT_FOUND', 'MEDIA_NOT_FOUND', 'PROXY_INVALID'])

async function guard(fn, code) {
  try {
    return ok(await fn())
  } catch (error) {
    log('IPC 失败:', code || '', error && error.stack ? error.stack : String(error))
    const specific = error && PASS_THROUGH_CODES.has(error.code) ? error.code : null
    return fail(error, specific || code)
  }
}

function sendProgress(progress) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('job:progress', progress)
}

// 当前生效的代理状态（启动/保存设置/代理测试后更新，冒烟报告中会记录）
let activeProxy = { mode: 'system', effectiveUrl: null, proxyRules: null, applied: null, error: null, source: 'startup' }
let activeProxySettings = null

async function applyRuntimeProxy(proxySettings, source) {
  const applied = await proxy.applyProxy(proxySettings)
  proxy.updateProxyAuth(proxySettings)
  activeProxySettings = proxy.normalizeProxySettings(proxySettings)
  activeProxy = {
    mode: proxySettings.mode,
    effectiveUrl: proxySettings.mode === 'custom' ? proxySettings.url : null,
    proxyRules: applied.proxyRules,
    applied: applied.applied,
    error: applied.error || null,
    source: source || 'runtime',
  }
  log('网络代理', activeProxy)
  return applied
}

/** 把任务进度绑定到当前窗口（engine 侧只负责调用回调） */
function progressSink() {
  return (progress) => sendProgress(progress)
}

// ---------------------------------------------------------------------------
// xgif:// 本地文件协议：只允许访问应用自己的数据目录，避免渲染进程拿到任意文件
// ---------------------------------------------------------------------------

// 便携/测试数据目录：--xgif-user-data=<path>（启动器回退时传入）或环境变量 XGIF_USER_DATA / XGIF_DATA_DIR。
// 说明：Chromium 的 --user-data-dir 在打包态不一定影响 app.getPath('userData')，因此用显式参数 + app.setPath 保证可靠。
const customUserDataDir = readArgValue('--xgif-user-data') || process.env.XGIF_USER_DATA || process.env.XGIF_DATA_DIR
app.setName(paths.APP_STORAGE_NAME)

// 数据目录策略：默认便携（程序目录 userdata\），不使用 C 盘用户目录；--xgif-user-data 显式覆盖优先。
const portableDataDir = paths.defaultDataDir()
const effectiveUserDataDir = customUserDataDir ? path.resolve(customUserDataDir) : portableDataDir
try {
  fs.mkdirSync(effectiveUserDataDir, { recursive: true })
  app.setPath('userData', effectiveUserDataDir)
} catch (error) {
  console.error('[main] 设置用户数据目录失败：', error)
}

/**
 * 首次启动迁移（仅打包态）：把 C 盘旧数据目录（XGifStudio / XMediaStudio）的设置、历史与已导出 GIF
 * 搬到便携数据目录，改写历史中的绝对路径，校验通过后删除旧目录以释放 C 盘空间。
 * 开发态与显式 --xgif-user-data 不迁移，避免误动真实数据。
 */
function migrateLegacyDataDir() {
  // 只有「数据目录 = 便携默认目录」时才迁移；测试用的显式临时目录绝不触碰旧数据。
  const isPortableDefault = path.resolve(effectiveUserDataDir) === path.resolve(paths.defaultDataDir())
  if (!isPortableDefault) return
  if (process.env.XGIF_SKIP_LEGACY_MIGRATION === '1') return
  if (!paths.isPackagedApp() && process.env.XGIF_MIGRATE_LEGACY !== '1') return
  try {
    const appData = app.getPath('appData')
    const candidates = [path.join(appData, paths.LEGACY_STORAGE_NAME), path.join(appData, paths.APP_STORAGE_NAME)]
    for (const legacy of candidates) {
      if (!fs.existsSync(legacy)) continue
      const result = migrate.migrateLegacyData({ targetDir: effectiveUserDataDir, legacyDir: legacy })
      if (result.ok) {
        console.log('[main] 旧数据已迁移到便携目录并清理 C 盘目录：' + legacy + ' → ' + effectiveUserDataDir)
        break
      }
      if (result.error) console.error('[main] 迁移旧数据失败（已保留原目录，未删除）：', result.error)
    }
  } catch (error) {
    console.error('[main] 迁移旧数据目录失败：', error)
  }
}

migrateLegacyDataDir()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'xgif',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
])

async function resolveDisplayPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  const resolved = path.resolve(rawPath)
  let configured = null
  try {
    configured = await settings.get()
  } catch {
    configured = null
  }
  const extraDirs = configured ? [configured.outputDir, configured.cacheDir] : []
  const roots = [paths.dataDir(), paths.cacheDir(), paths.outputDir(), ...extraDirs]
    .filter(Boolean)
    .map((item) => path.resolve(item))
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  if (!allowed) return null
  return resolved
}

async function handleXgifRequest(request) {
  try {
    const url = new URL(request.url)
    const target = await resolveDisplayPath(url.searchParams.get('path') || '')
    if (!target) {
      return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    const stat = await fsp.stat(target).catch(() => null)
    if (!stat || !stat.isFile()) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    return net.fetch(pathToFileURL(target).toString())
  } catch (error) {
    return new Response('bad request: ' + (error && error.message ? error.message : String(error)), {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function resolveWindowBackground(theme) {
  const mode = theme === 'light' || theme === 'dark' ? theme : nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return mode === 'light' ? '#f3f5f9' : '#0f1115'
}

function createWindow() {
  const windowWidth = Number(readArgValue('--window-width') || 0)
  const windowHeight = Number(readArgValue('--window-height') || 0)
  const initialWidth = windowWidth > 0 ? Math.max(480, windowWidth) : 1320
  const initialHeight = windowHeight > 0 ? Math.max(400, windowHeight) : 860
  let theme = 'dark'
  try {
    theme = settings.getSync().theme
  } catch {
    theme = 'dark'
  }
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: windowWidth > 0 ? Math.min(480, initialWidth) : 1080,
    minHeight: windowHeight > 0 ? Math.min(400, initialHeight) : 680,
    show: false,
    frame: false,
    backgroundColor: resolveWindowBackground(theme),
    title: paths.APP_DISPLAY_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html')
  if (screenshotView) mainWindow.loadFile(indexHtml, { hash: screenshotView })
  else mainWindow.loadFile(indexHtml)

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeRun) mainWindow.show()
    if (screenshotPath) {
      setTimeout(async () => {
        try {
          if (screenshotEval) {
            let code = screenshotEval
            if (fs.existsSync(screenshotEval) && fs.statSync(screenshotEval).isFile()) {
              code = fs.readFileSync(screenshotEval, 'utf8')
            }
            const evalResult = await mainWindow.webContents.executeJavaScript(code, true)
            log('[screenshot-eval] 结果', evalResult === undefined ? 'undefined' : JSON.stringify(evalResult).slice(0, 3000))
            await new Promise((resolve) => setTimeout(resolve, Math.max(300, screenshotEvalWait)))
          }
          const image = await mainWindow.capturePage()
          await fsp.mkdir(path.dirname(path.resolve(screenshotPath)), { recursive: true })
          await fsp.writeFile(path.resolve(screenshotPath), image.toPNG())
          log('截图已写入', screenshotPath)
        } catch (error) {
          log('截图失败', error)
        }
        app.exit(0)
      }, Math.max(400, screenshotDelay))
    }
  })

  const emitMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', emitMaximized)
  mainWindow.on('unmaximize', emitMaximized)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  return mainWindow
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    try {
      return { ...(await paths.appInfo()), tools: await tools.status() }
    } catch (error) {
      log('app:info 失败', error)
      const base = await paths.appInfo()
      return {
        ...base,
        tools: { ffmpeg: null, gifski: null, gifsicle: null, ffmpegVersion: null, gifskiVersion: null, gifsicleVersion: null, ready: false, missing: ['ffmpeg', 'gifski', 'gifsicle'] },
      }
    }
  })
  ipcMain.handle('app:toggle-devtools', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools()
  })
  ipcMain.handle('app:open-data-dir', () =>
    guard(async () => {
      const dir = paths.dataDir()
      fs.mkdirSync(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
      return dir
    }, 'OPEN_DATA_DIR'),
  )
  ipcMain.handle('app:open-output-dir', () =>
    guard(async () => {
      const dir = await settings.getOutputDir()
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
      return dir
    }, 'OPEN_DIR'),
  )
  ipcMain.handle('app:open-cache-dir', () =>
    guard(async () => {
      const dir = await settings.getCacheDir()
      await fsp.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw new Error(error)
      return dir
    }, 'OPEN_DIR'),
  )

  ipcMain.handle('tweet:fetch', (_event, payload) => guard(() => tweet.fetch(payload && payload.url), 'TWEET_FETCH'))

  ipcMain.handle('media:prepare', (_event, payload) =>
    guard(
      () => media.prepare({ ...payload, onProgress: progressSink() }),
      'MEDIA_PREPARE',
    ),
  )
  // 契约：DesktopApi.media.toDisplayUrl 返回裸 string（失败时返回空字符串，不抛异常）
  ipcMain.handle('media:save', (_event, payload) =>
    guard(() => media.save({ ...payload, onProgress: progressSink() }), 'MEDIA_SAVE'),
  )
  ipcMain.handle('media:export-as', (_event, payload) =>
    guard(async () => {
      const source = payload && payload.filePath
      if (!source || !fs.existsSync(source)) throw new Error('媒体文件不存在，可能已被移动或删除')
      const defaultName = (payload && payload.defaultName) || path.basename(source)
      const ext = path.extname(source).replace(/^\./, '').toLowerCase()
      const filterNames = { mp4: 'MP4 视频', jpg: 'JPEG 图片', jpeg: 'JPEG 图片', png: 'PNG 图片', webp: 'WebP 图片', gif: 'GIF 动图' }
      const filters = filterNames[ext] ? [{ name: filterNames[ext], extensions: [ext] }] : []
      const picked = await dialog.showSaveDialog(mainWindow, {
        title: '另存为',
        defaultPath: path.join(path.dirname(source), defaultName),
        filters,
      })
      if (picked.canceled || !picked.filePath) return { canceled: true }
      await fsp.copyFile(source, picked.filePath)
      return { canceled: false, filePath: picked.filePath }
    }, 'EXPORT_AS'),
  )
  ipcMain.handle('media:open', (_event, payload) =>
    guard(async () => {
      const target = payload && payload.filePath
      if (!target || !fs.existsSync(target)) throw new Error('媒体文件不存在')
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
      return true
    }, 'OPEN_FILE'),
  )
  ipcMain.handle('media:reveal', (_event, payload) =>
    guard(async () => {
      const target = payload && payload.filePath
      if (!target || !fs.existsSync(target)) throw new Error('媒体文件不存在')
      shell.showItemInFolder(target)
      return true
    }, 'REVEAL_FILE'),
  )
  ipcMain.handle('media:remove', (_event, payload) =>
    guard(async () => {
      const target = payload && payload.filePath
      if (target && fs.existsSync(target)) await fsp.rm(target, { force: true })
      if (payload && payload.tweetId && payload.savedId) await history.removeSaved(payload.tweetId, payload.savedId)
      return true
    }, 'REMOVE_FILE'),
  )
  ipcMain.handle('media:copy-path', (_event, payload) =>
    guard(async () => {
      clipboard.writeText(String((payload && payload.filePath) || ''))
      return true
    }, 'COPY_PATH'),
  )
  ipcMain.handle('media:probe-file', async (_event, payload) => {
    try {
      const target = payload && payload.filePath
      if (!target || !fs.existsSync(target)) return null
      const resolved = path.resolve(target)
      const outputDir = path.resolve(await settings.getOutputDir())
      const inOutput = resolved.toLowerCase().startsWith(outputDir.toLowerCase() + path.sep)
      if (!inOutput) return null
      const ext = path.extname(resolved).toLowerCase()
      if (!['.mp4', '.m4v', '.mov'].includes(ext)) return null
      const probe = await mp4probe.probe(resolved)
      return {
        path: resolved,
        width: probe.width,
        height: probe.height,
        durationSec: probe.durationSec,
        frameCount: probe.frameCount,
        fps: probe.fps,
        hasAudio: probe.hasAudio,
        sizeBytes: probe.sizeBytes,
      }
    } catch (error) {
      log('media:probe-file 失败', error)
      return null
    }
  })

  ipcMain.handle('media:display-url', async (_event, payload) => {
    try {
      const target = await resolveDisplayPath(payload && payload.filePath)
      if (!target) return ''
      return 'xgif://display/?path=' + encodeURIComponent(target)
    } catch (error) {
      log('media:display-url 失败', error)
      return ''
    }
  })

  ipcMain.handle('media:video-thumbnail', async (_event, payload) => {
    try {
      const target = await thumbnails.ensureVideoThumbnail(payload && payload.filePath)
      if (!target) return ''
      return 'xgif://display/?path=' + encodeURIComponent(target)
    } catch (error) {
      log('media:video-thumbnail 失败', error)
      return ''
    }
  })

  ipcMain.handle('gif:convert', (_event, payload) =>
    guard(() => gif.convert({ ...payload, onProgress: progressSink() }), 'CONVERT_FAILED'),
  )
  ipcMain.handle('gif:info', (_event, payload) => guard(() => gif.info(payload && payload.filePath), 'GIF_INFO'))
  ipcMain.handle('gif:export-as', (_event, payload) =>
    guard(async () => {
      const source = payload && payload.filePath
      if (!source || !fs.existsSync(source)) throw new Error('动图文件不存在，可能已被移动或删除')
      const ext = path.extname(source).toLowerCase() === '.webp' ? '.webp' : '.gif'
      const defaultName = (payload && payload.defaultName) || path.basename(source)
      const picked = await dialog.showSaveDialog(mainWindow, {
        title: '另存为',
        defaultPath: path.join(path.dirname(source), defaultName),
        filters: ext === '.webp' ? [{ name: 'WebP 动图', extensions: ['webp'] }] : [{ name: 'GIF 动图', extensions: ['gif'] }],
      })
      if (picked.canceled || !picked.filePath) return { canceled: true }
      const targetPath = path.extname(picked.filePath) ? picked.filePath : picked.filePath + ext
      await fsp.copyFile(source, targetPath)
      history.addCopy(path.basename(source, ext), targetPath).catch((error) => log('记录另存为失败', error))
      return { canceled: false, filePath: targetPath }
    }, 'EXPORT_AS'),
  )
  ipcMain.handle('gif:open', (_event, payload) =>
    guard(async () => {
      const target = payload && payload.filePath
      if (!target || !fs.existsSync(target)) throw new Error('动图文件不存在')
      const error = await shell.openPath(target)
      if (error) throw new Error(error)
      return true
    }, 'OPEN_FILE'),
  )
  ipcMain.handle('gif:reveal', (_event, payload) =>
    guard(async () => {
      const target = payload && payload.filePath
      if (!target || !fs.existsSync(target)) throw new Error('动图文件不存在')
      shell.showItemInFolder(target)
      return true
    }, 'REVEAL_FILE'),
  )
  ipcMain.handle('gif:remove', (_event, payload) =>
    guard(async () => {
      const target = payload && payload.filePath
      if (!target) throw new Error('缺少文件路径')
      if (fs.existsSync(target)) await fsp.rm(target, { force: true })
      return true
    }, 'REMOVE_FILE'),
  )
  ipcMain.handle('gif:copy-path', (_event, payload) =>
    guard(async () => {
      clipboard.writeText(String((payload && payload.filePath) || ''))
      return true
    }, 'COPY_PATH'),
  )

  ipcMain.handle('history:list', () => guard(() => history.list(), 'HISTORY_LIST'))
  ipcMain.handle('history:get', (_event, payload) => guard(() => history.get(payload && payload.tweetId), 'HISTORY_GET'))
  ipcMain.handle('history:remove', (_event, payload) =>

    guard(() => history.remove(payload && payload.tweetId, { deleteFiles: Boolean(payload && payload.deleteFiles) }), 'HISTORY_REMOVE'),

  )
  ipcMain.handle('history:remove-result', (_event, payload) =>
    guard(() => history.removeResult(payload && payload.tweetId, payload && payload.resultId), 'HISTORY_REMOVE_RESULT'),
  )
  ipcMain.handle('history:remove-saved', (_event, payload) =>
    guard(() => history.removeSaved(payload && payload.tweetId, payload && payload.savedId), 'HISTORY_REMOVE_SAVED'),
  )
  ipcMain.handle('history:clear', () => guard(() => history.clear(), 'HISTORY_CLEAR'))

  ipcMain.handle('settings:get', () => guard(() => settings.get(), 'SETTINGS_GET'))
  ipcMain.handle('settings:save', (_event, payload) =>
    guard(async () => {
      const candidate = payload && payload.settings
      // 先校验自定义代理地址，避免保存无法生效的配置
      const proxyConfig = proxy.buildProxyConfig(candidate && candidate.proxy)
      if (!proxyConfig.ok) {
        const error = new Error(proxyConfig.error || '代理设置不正确')
        error.code = 'PROXY_INVALID'
        throw error
      }
      const saved = await settings.save(candidate)
      const applied = await applyRuntimeProxy(saved.proxy, 'settings-save')
      if (!applied.ok) {
        const error = new Error(applied.error || '代理设置已保存，但应用到网络栈失败')
        error.code = 'PROXY_INVALID'
        throw error
      }
      return saved
    }, 'SETTINGS_SAVE'),
  )
  ipcMain.handle('settings:choose-directory', (_event, payload) =>
    guard(async () => {
      const kind = payload && payload.kind === 'cache' ? 'cache' : 'output'
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: kind === 'cache' ? '选择缓存目录' : '选择输出目录（保存的媒体与 GIF）',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      return picked.filePaths[0]
    }, 'CHOOSE_DIR'),
  )

  ipcMain.handle('proxy:test', (_event, payload) =>
    guard(async () => {
      const candidate = proxy.normalizeProxySettings(payload && payload.proxy)
      const config = proxy.buildProxyConfig(candidate)
      if (!config.ok) {
        return { ok: false, mode: candidate.mode, effectiveUrl: null, checks: [], error: config.error }
      }
      const applied = await proxy.applyProxy(candidate)
      if (!applied.ok) {
        return { ok: false, mode: candidate.mode, effectiveUrl: candidate.url || null, checks: [], error: applied.error }
      }
      proxy.updateProxyAuth(candidate)
      try {
        return await proxy.testProxyConnectivity({ fetchImpl: network.fetch, proxy: candidate })
      } finally {
        // 测试只影响本次请求：结束后恢复已保存的代理设置
        const saved = await settings.get()
        await applyRuntimeProxy(saved.proxy, 'restore-after-test')
      }
    }, 'PROXY_TEST'),
  )

  ipcMain.handle('jobs:cancel', (_event, payload) => guard(() => jobs.cancel(payload && payload.jobId), 'JOB_CANCEL'))
  ipcMain.handle('clipboard:write', (_event, payload) =>
    guard(async () => {
      clipboard.writeText(String((payload && payload.text) || ''))
      return true
    }, 'CLIPBOARD'),
  )

  ipcMain.handle('window:minimize', () => {
    if (mainWindow) mainWindow.minimize()
  })
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:is-maximized', () => Boolean(mainWindow && mainWindow.isMaximized()))
  ipcMain.handle('window:close', () => {
    if (mainWindow) mainWindow.close()
  })
}

// ---------------------------------------------------------------------------
// 冒烟自检（打包后验证用）：--smoke-report <json 路径> [--smoke-url <推文链接>]
// ---------------------------------------------------------------------------

function readArgValue(name) {
  const prefix = name + '='
  const withEquals = process.argv.find((arg) => arg.startsWith(prefix))
  if (withEquals) return withEquals.slice(prefix.length)
  const index = process.argv.indexOf(name)
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1]
  return null
}

async function runSmokeReport() {
  const reportPath = readArgValue('--smoke-report')
  const tweetUrl = readArgValue('--smoke-url') || process.env.XGIF_SMOKE_URL || 'https://x.com/hardestgifs/status/2116630142135275663'
  const report = { startedAt: new Date().toISOString(), steps: [], ok: false }
  const step = (name, data) => {
    report.steps.push({ name, at: new Date().toISOString(), ...data })
    log('[smoke]', name, JSON.stringify(data).slice(0, 400))
  }
  try {
    step('paths', { appPath: app.getAppPath(), isPackaged: app.isPackaged, dataDir: paths.dataDir(), argv: process.argv, toolsDir: paths.toolsDir(), projectRoot: paths.projectRoot() })
    step('proxy', { ...activeProxy })
    // 代理连通性自检：实际请求 X 解析接口与媒体 CDN（走当前 session 代理）
    try {
      const currentProxySettings = activeProxySettings || (await settings.get()).proxy
      step('proxy-check', await proxy.testProxyConnectivity({ fetchImpl: network.fetch, proxy: currentProxySettings }))
    } catch (error) {
      step('proxy-check', { ok: false, error: error && error.message ? error.message : String(error) })
    }
    const toolStatus = await tools.status()
    step('tools', { status: toolStatus })
    if (!toolStatus.ready) throw new Error('缺少工具：' + toolStatus.missing.join(', '))

    const info = await tweet.fetch(tweetUrl)
    step('tweet', { id: info.id, author: info.author.screenName, media: info.media.map((m) => ({ id: m.id, kind: m.kind, url: m.sourceUrl })) })
    const target = info.media.find((m) => m.kind === 'gif') || info.media.find((m) => m.kind === 'video')
    if (!target) throw new Error('该推文没有可转换的媒体')

    const prepared = await media.prepare({ jobId: 'smoke-media', tweetId: info.id, media: target, onProgress: () => {} })
    const savedMedia = await media.save({ jobId: 'smoke-save', tweetId: info.id, media: target, onProgress: () => {} })
    step('save', {
      id: savedMedia.saved.id,
      format: savedMedia.saved.format,
      fileName: savedMedia.saved.fileName,
      sizeBytes: savedMedia.saved.sizeBytes,
      newFile: savedMedia.newFile,
    })

    step('prepare', { localPath: prepared.localPath, probe: { ...prepared.probe, frameDurationsMs: prepared.probe.frameDurationsMs.length } })

    const params = { encoder: 'gifski', width: 480, fps: 'source', colors: 256, quality: 80, dither: 'sierra2_4a', preserveTiming: true, optimize: true, lossy: 80, speed: 1, loopCount: 0 }
    const result = await gif.convert({
      jobId: 'smoke-gif',
      tweetId: info.id,
      media: target,
      params,
      presetId: 'smoke',
      onProgress: () => {},
    })
    step('convert', { gifPath: result.gifPath, info: { ...result.info, frameDelaysMs: result.info.frameDelaysMs.length } })
    report.ok = true
  } catch (error) {
    step('error', { message: error && error.message ? error.message : String(error), stack: error && error.stack })
    report.ok = false
  }
  report.finishedAt = new Date().toISOString()
  try {
    await fsp.mkdir(path.dirname(reportPath), { recursive: true })
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
    log('冒烟报告已写入', reportPath)
  } catch (error) {
    log('冒烟报告写入失败', error)
  }
  app.exit(report.ok ? 0 : 3)
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // 代理认证：Chromium 网络栈收到代理 407 时触发（app.on('login')）
  app.on('login', (event, webContents, details, authInfo, callback) => {
    try {
      if (!authInfo || !authInfo.isProxy) return
      const auth = proxy.getProxyAuth()
      if (!auth.enabled) {
        log('代理认证：当前代理未配置用户名/密码，无法完成认证')
        return
      }
      event.preventDefault()
      callback(auth.username || '', auth.password || '')
      log('代理认证：已提供凭据' + (auth.username ? '（' + auth.username + '）' : ''))
    } catch (error) {
      log('代理认证处理失败', error)
    }
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    paths.ensureDirsSync()
    logger = fs.createWriteStream(path.join(paths.logsDir(), 'main.log'), { flags: 'a' })
    protocol.handle('xgif', handleXgifRequest)
    registerIpc()

    // 启动时应用已保存的代理；--proxy-mode/--proxy-url 可临时覆盖（冒烟验证用）
    const cliProxyMode = readArgValue('--proxy-mode')
    const cliProxyUrl = readArgValue('--proxy-url')
    let startupProxy = null
    try {
      startupProxy = (await settings.get()).proxy
    } catch {
      startupProxy = null
    }
    if (!startupProxy) startupProxy = proxy.normalizeProxySettings(null)
    if (cliProxyMode || cliProxyUrl) {
      startupProxy = proxy.normalizeProxySettings({
        ...startupProxy,
        mode: cliProxyMode || (cliProxyUrl ? 'custom' : startupProxy.mode),
        url: cliProxyUrl || startupProxy.url,
        username: readArgValue('--proxy-auth-user') || startupProxy.username,
        password: readArgValue('--proxy-auth-pass') || startupProxy.password,
      })
    }
    await applyRuntimeProxy(startupProxy, cliProxyMode || cliProxyUrl ? 'cli' : 'settings')

    if (isSmokeRun) {
      setTimeout(() => {
        log('冒烟自检超时（180s），强制退出')
        app.exit(4)
      }, 180000)
      await runSmokeReport()
      return
    }

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  process.on('uncaughtException', (error) => log('uncaughtException', error && error.stack ? error.stack : String(error)))
  process.on('unhandledRejection', (error) => log('unhandledRejection', error && error.stack ? error.stack : String(error)))
}