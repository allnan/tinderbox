'use strict'

/**
 * 旧数据迁移：把 C 盘旧数据目录里的设置、历史与已导出媒体搬到便携数据目录。
 *
 * 背景：旧版本把数据放在 %APPDATA%\XGifStudio（C 盘）；新版本默认使用程序目录下的 userdata\（便携）。
 * 迁移策略：仅当目标目录还没有数据时执行；复制设置/历史/旧 gifs 输出，改写历史与设置中的绝对路径，
 * 校验通过后再删除旧目录（失败时保留原目录并返回错误，绝不删除）。
 */

const fs = require('node:fs')
const path = require('node:path')

function countFiles(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else total += 1
    }
  }
  return total
}

function remapPath(value, legacyDir, targetDir) {
  if (typeof value !== 'string' || value.length === 0) return value
  const legacyGifs = path.join(legacyDir, 'gifs')
  const legacyCache = path.join(legacyDir, 'cache')
  const newMedia = path.join(targetDir, 'media')
  const resolved = path.resolve(value)
  if (resolved === legacyGifs || resolved.startsWith(legacyGifs + path.sep)) {
    return path.join(newMedia, resolved.slice(legacyGifs.length).replace(/^[\\/]/, ''))
  }
  if (resolved === legacyCache || resolved.startsWith(legacyCache + path.sep)) return null
  return value
}

/** 改写 history.json 与 settings.json 中指向旧目录的绝对路径 */
function rewritePathsInData(targetDir, legacyDir) {
  const historyFile = path.join(targetDir, 'history.json')
  if (fs.existsSync(historyFile)) {
    const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    if (parsed && parsed.entries && typeof parsed.entries === 'object') {
      for (const entry of Object.values(parsed.entries)) {
        if (!entry || typeof entry !== 'object') continue
        if (Array.isArray(entry.savedMedia)) {
          for (const item of entry.savedMedia) {
            if (item && item.filePath) item.filePath = remapPath(item.filePath, legacyDir, targetDir)
          }
        }
        if (Array.isArray(entry.results)) {
          for (const result of entry.results) {
            if (!result) continue
            if (result.gifPath) result.gifPath = remapPath(result.gifPath, legacyDir, targetDir)
            if (Array.isArray(result.copies)) result.copies = result.copies.map((item) => remapPath(item, legacyDir, targetDir)).filter(Boolean)
          }
        }
        if (Array.isArray(entry.media)) {
          for (const item of entry.media) {
            if (item && item.localPath) item.localPath = remapPath(item.localPath, legacyDir, targetDir)
          }
        }
      }
    }
    fs.writeFileSync(historyFile, JSON.stringify(parsed, null, 2), 'utf8')
  }

  const settingsFile = path.join(targetDir, 'settings.json')
  if (fs.existsSync(settingsFile)) {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (parsed.outputDir) parsed.outputDir = remapPath(parsed.outputDir, legacyDir, targetDir) || path.join(targetDir, 'media')
      if (parsed.cacheDir) parsed.cacheDir = remapPath(parsed.cacheDir, legacyDir, targetDir)
      fs.writeFileSync(settingsFile, JSON.stringify(parsed, null, 2), 'utf8')
    }
  }
}

/**
 * @param {{targetDir:string, legacyDir:string}} options
 * @returns {{ok:boolean, from?:string, sourceFiles?:number, targetFiles?:number, error?:string, skipped?:boolean}}
 */
function migrateLegacyData({ targetDir, legacyDir }) {
  if (!targetDir || !legacyDir) return { ok: false, error: '缺少迁移目录参数' }
  if (path.resolve(targetDir) === path.resolve(legacyDir)) return { ok: false, skipped: true }
  if (!fs.existsSync(legacyDir)) return { ok: false, skipped: true }
  const marker = path.join(targetDir, '.migrated')
  if (fs.existsSync(marker)) return { ok: false, skipped: true }
  const hasTargetData = ['settings.json', 'history.json', 'media', 'gifs'].some((name) => fs.existsSync(path.join(targetDir, name)))
  if (hasTargetData) {
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(marker, JSON.stringify({ skipped: true, at: new Date().toISOString() }, null, 2), 'utf8')
    return { ok: false, skipped: true }
  }

  const sourceFiles = countFiles(legacyDir)
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    for (const name of ['settings.json', 'history.json', 'history.json.bak']) {
      const source = path.join(legacyDir, name)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(targetDir, name))
    }
    const oldGifs = path.join(legacyDir, 'gifs')
    if (fs.existsSync(oldGifs)) fs.cpSync(oldGifs, path.join(targetDir, 'media'), { recursive: true })
    rewritePathsInData(targetDir, legacyDir)

    const historyFile = path.join(targetDir, 'history.json')
    if (fs.existsSync(historyFile)) JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    const targetFiles = countFiles(targetDir)
    if (sourceFiles > 0 && targetFiles === 0) throw new Error('迁移后目标目录为空')

    fs.rmSync(legacyDir, { recursive: true, force: true })
    fs.writeFileSync(
      marker,
      JSON.stringify({ migratedFrom: legacyDir, at: new Date().toISOString(), sourceFiles, targetFiles }, null, 2),
      'utf8',
    )
    return { ok: true, from: legacyDir, sourceFiles, targetFiles }
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error), sourceFiles }
  }
}

module.exports = { migrateLegacyData, rewritePathsInData, countFiles, remapPath }
