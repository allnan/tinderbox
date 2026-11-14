'use strict'

/** 目录与路径解析。所有模块统一从这里取路径，便于测试与限制文件访问范围。 */

const fs = require('node:fs')
const path = require('node:path')

const APP_DISPLAY_NAME = 'X 媒体工坊'
/** 应用存储名（userData 目录名）；改名前的旧目录 XGifStudio 会在启动时迁移配置与历史 */
const APP_STORAGE_NAME = 'XMediaStudio'
const LEGACY_STORAGE_NAME = 'XGifStudio'

/** 在 Electron 主进程内可拿到 app；在 node:test 中 require('electron') 不可用，回退临时目录 */
function electronApp() {
  try {
    const electron = require('electron')
    if (electron && electron.app && typeof electron.app.getPath === 'function') return electron.app
  } catch {
    /* 非 Electron 环境 */
  }
  return null
}

function isPackaged() {
  const app = electronApp()
  return Boolean(app && app.isPackaged)
}

/** 打包态判定：优先看 appPath 是否在 app.asar 内（开发态用改名后的 runtime exe 时 isPackaged 也可能为 true） */
function isPackagedApp() {
  const app = electronApp()
  if (!app) return false
  try {
    const appPath = typeof app.getAppPath === 'function' ? String(app.getAppPath()) : ''
    if (appPath.toLowerCase().endsWith('.asar')) return true
    return Boolean(app.isPackaged) && !appPath
  } catch {
    return Boolean(app.isPackaged)
  }
}

/** 目录是否可写（可创建并写入临时文件） */
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.write-probe-' + process.pid)
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 默认数据目录（**不使用 C 盘用户目录**）：
 * - 打包态：程序目录下的 userdata\（便携模式，随程序一起放在任意磁盘）；不可写时回退到本机应用数据目录并告警；
 * - 开发态：项目 .build\userdata；
 * - 显式 --xgif-user-data / XGIF_DATA_DIR 优先级最高（由 main 处理）。
 */
function defaultDataDir() {
  const app = electronApp()
  if (!app) {
    if (process.env.XGIF_DATA_DIR) return path.resolve(process.env.XGIF_DATA_DIR)
    return path.join(projectRoot(), '.build', 'userdata')
  }
  if (isPackagedApp()) {
    const portable = path.join(path.dirname(app.getPath('exe')), 'userdata')
    if (isWritableDir(portable)) return portable
    let fallbackRoot = ''
    try {
      fallbackRoot = app.getPath('localAppData') || app.getPath('appData')
    } catch {
      fallbackRoot = app.getPath('appData')
    }
    return path.join(fallbackRoot, APP_STORAGE_NAME)
  }
  return path.join(projectRoot(), '.build', 'userdata')
}

function dataDir() {
  const app = electronApp()
  if (app) return app.getPath('userData')
  if (process.env.XGIF_DATA_DIR) return path.resolve(process.env.XGIF_DATA_DIR)
  return path.join(projectRoot(), '.build', 'userdata')
}

function cacheDir() {
  return path.join(dataDir(), 'cache')
}

function outputDir() {
  return path.join(dataDir(), 'media')
}

function logsDir() {
  return path.join(dataDir(), 'logs')
}

function projectRoot() {
  return path.resolve(__dirname, '..', '..')
}

/**
 * 外部工具目录：优先找实际存在的目录。
 * - 打包态：<resources>/tools；
 * - 开发态：<项目>/tools/bin；
 * 注意：某些 Electron 运行时被改名后 app.isPackaged 可能为 true（即使以 <项目目录> 方式启动），
 * 所以这里按「目录存在性」兜底，避免开发/冒烟时找不到 tools。
 */
function toolsDir() {
  const devTools = path.join(projectRoot(), 'tools', 'bin')
  // process.resourcesPath 只在 Electron 主进程中存在；纯 Node（node:test / node -e）下为 undefined
  const resourceTools = process.resourcesPath ? path.join(process.resourcesPath, 'tools') : null
  const candidates = isPackaged() && resourceTools ? [resourceTools, devTools] : [devTools, resourceTools].filter(Boolean)
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return candidates[0] || devTools
}

function ensureDirsSync() {
  for (const dir of [cacheDir(), path.join(cacheDir(), 'media'), path.join(cacheDir(), 'thumbs'), path.join(cacheDir(), 'frames'), outputDir(), logsDir()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function appInfo() {
  const app = electronApp()
  return {
    version: app && typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0-dev',
    name: APP_DISPLAY_NAME,
    isPackaged: isPackaged(),
    dataDir: dataDir(),
    cacheDir: cacheDir(),
    outputDir: outputDir(),
    logsDir: logsDir(),
  }
}

/** 把作者名等文本变成安全文件名片段 */
function safeName(value, fallback = 'x') {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 60)
  return cleaned || fallback
}

module.exports = { APP_DISPLAY_NAME, APP_STORAGE_NAME, LEGACY_STORAGE_NAME, dataDir, defaultDataDir, isPackagedApp, isWritableDir, cacheDir, outputDir, logsDir, projectRoot, toolsDir, isPackaged, ensureDirsSync, appInfo, safeName }