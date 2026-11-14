'use strict'

/**
 * 历史记录：<userData>/history.json，以推文 id 为主键分组。
 * 结构：{ version, entries: { [tweetId]: HistoryEntry } }
 * 写入采用「旧文件备份为 .bak + 临时文件 + rename」的原子方式。
 *
 * 每个分组包含：
 * - media：推文里的媒体元数据（含本地缓存路径/探测结果）；
 * - savedMedia：已保存到输出目录的原始媒体（mp4/图片，见 Shared/SavedMedia）；
 * - results：导出的 GIF 结果。
 * 旧版本数据没有 savedMedia 字段，读取时统一补 []（向后兼容）。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const paths = require('./paths.cjs')

const STORE_VERSION = 1
let memoryStore = null
let writeChain = Promise.resolve()

function historyPath() {
  return path.join(paths.dataDir(), 'history.json')
}

function emptyStore() {
  return { version: STORE_VERSION, entries: {} }
}

function validEntry(entry) {
  return entry && typeof entry === 'object' && typeof entry.id === 'string' && Array.isArray(entry.results)
}

/** savedMedia 记录的最小有效性（旧数据可能缺失或字段不全） */
function validSavedMedia(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && typeof item.filePath === 'string'
}

async function load() {
  if (memoryStore) return memoryStore
  try {
    const raw = await fsp.readFile(historyPath(), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = {}
    if (parsed && parsed.entries && typeof parsed.entries === 'object') {
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (validEntry(value)) {
          entries[key] = {
            ...value,
            media: Array.isArray(value.media) ? value.media : [],
            // 旧历史没有 savedMedia：补 []，保证渲染层拿到的是稳定结构
            savedMedia: Array.isArray(value.savedMedia) ? value.savedMedia.filter(validSavedMedia) : [],
            results: value.results.filter((item) => item && typeof item.gifPath === 'string'),
            copies: undefined,
          }
        }
      }
    }
    memoryStore = { version: STORE_VERSION, entries }
  } catch {
    memoryStore = emptyStore()
  }
  return memoryStore
}

async function persist() {
  const store = memoryStore
  if (!store) return
  writeChain = writeChain.then(async () => {
    const target = historyPath()
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp-' + process.pid
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    try {
      const old = await fsp.readFile(target, 'utf8')
      await fsp.writeFile(target + '.bak', old, 'utf8')
    } catch {
      /* 首次写入没有旧文件 */
    }
    await fsp.rename(tmp, target)
  })
  await writeChain
}

function sortEntries(entries) {
  return entries.sort((a, b) => String(b.lastOpenedAt || '').localeCompare(String(a.lastOpenedAt || '')))
}

async function list() {
  const store = await load()
  return sortEntries(Object.values(store.entries).map((entry) => JSON.parse(JSON.stringify(entry))))
}

async function get(tweetId) {
  if (!tweetId) return null
  const store = await load()
  const entry = store.entries[tweetId]
  if (!entry) return null
  entry.lastOpenedAt = new Date().toISOString()
  await persist()
  return JSON.parse(JSON.stringify(entry))
}

async function touch(tweetId) {
  const store = await load()
  const entry = store.entries[tweetId]
  if (!entry) return false
  entry.lastOpenedAt = new Date().toISOString()
  await persist()
  return true
}

const DELETABLE_EXTS = new Set(['.mp4', '.m4a', '.jpg', '.jpeg', '.png', '.webp', '.gif'])

/**
 * 移除一条历史记录。
 * @param {string} tweetId
 * @param {{ deleteFiles?: boolean }} [options] 同时删除该记录下已保存的原始媒体与 GIF 输出文件
 * @returns {Promise<{ deletedFiles: number, failedFiles: number }>}
 */
async function remove(tweetId, options = {}) {
  const store = await load()
  const entry = store.entries[tweetId]
  let deletedFiles = 0
  let failedFiles = 0
  if (entry && options && options.deleteFiles) {
    const files = []
    for (const item of entry.savedMedia || []) {
      if (item && typeof item.filePath === 'string' && item.filePath) files.push(item.filePath)
    }
    for (const item of entry.results || []) {
      if (item && typeof item.gifPath === 'string' && item.gifPath) files.push(item.gifPath)
    }
    for (const file of files) {
      try {
        if (!path.isAbsolute(file)) {
          failedFiles += 1
          continue
        }
        const ext = path.extname(file).toLowerCase()
        if (!DELETABLE_EXTS.has(ext)) {
          failedFiles += 1
          continue
        }
        if (fs.existsSync(file)) {
          await fsp.rm(file, { force: true })
          deletedFiles += 1
        }
      } catch {
        failedFiles += 1
      }
    }
  }
  if (entry) {
    delete store.entries[tweetId]
    await persist()
  }
  return { deletedFiles, failedFiles }
}

async function removeResult(tweetId, resultId) {
  const store = await load()
  const entry = store.entries[tweetId]
  if (!entry) return true
  const index = entry.results.findIndex((item) => item.id === resultId)
  if (index >= 0) {
    const [removed] = entry.results.splice(index, 1)
    try {
      if (removed && removed.gifPath && fs.existsSync(removed.gifPath)) await fsp.rm(removed.gifPath, { force: true })
    } catch {
      /* 删除文件失败不影响记录清理 */
    }
    await persist()
  }
  return true
}

async function clear() {
  await load()
  memoryStore = emptyStore()
  await persist()
  return true
}

/** 记录一次成功导出：创建或更新推文分组，加入 media 与 result */
async function recordResult(payload) {
  const { tweetInfo, media, prepared, result } = payload || {}
  if (!tweetInfo || !tweetInfo.id || !result) throw new Error('记录历史缺少必要参数')
  const store = await load()
  const now = new Date().toISOString()
  const existing = store.entries[tweetInfo.id]
  const entry = existing || {
    id: tweetInfo.id,
    tweetUrl: tweetInfo.url,
    author: tweetInfo.author,
    text: tweetInfo.text || '',
    tweetCreatedAt: tweetInfo.createdAt || null,
    fetchedAt: now,
    lastOpenedAt: now,
    media: [],
    savedMedia: [],
    results: [],
  }
  if (!Array.isArray(entry.savedMedia)) entry.savedMedia = []
  entry.tweetUrl = tweetInfo.url
  entry.author = tweetInfo.author
  entry.text = tweetInfo.text || ''
  entry.tweetCreatedAt = tweetInfo.createdAt || null
  entry.lastOpenedAt = now

  if (media) {
    const mediaIndex = entry.media.findIndex((item) => item.id === media.id)
    const mediaRecord = {
      id: media.id,
      kind: media.kind,
      sourceUrl: media.sourceUrl,
      thumbnailUrl: media.thumbnailUrl || null,
      localPath: prepared && prepared.localPath ? prepared.localPath : null,
      probe: prepared && prepared.probe ? prepared.probe : null,
    }
    if (mediaIndex >= 0) entry.media[mediaIndex] = { ...entry.media[mediaIndex], ...mediaRecord }
    else entry.media.push(mediaRecord)
  }

  const resultIndex = entry.results.findIndex((item) => item.id === result.id)
  if (resultIndex >= 0) entry.results[resultIndex] = result
  else entry.results.unshift(result)
  entry.results = entry.results.slice(0, 200)

  store.entries[tweetInfo.id] = entry
  await persist()
  return JSON.parse(JSON.stringify(entry))
}

/** 从内存 store 中读取已保存媒体记录（不修改 lastOpenedAt） */
async function findSaved(tweetId, mediaId, format) {
  if (!tweetId || !mediaId) return null
  const store = await load()
  const entry = store.entries[tweetId]
  if (!entry || !Array.isArray(entry.savedMedia)) return null
  const found = entry.savedMedia.find(
    (item) => item && item.mediaId === mediaId && (format ? item.format === format : true),
  )
  return found ? JSON.parse(JSON.stringify(found)) : null
}

/**
 * 记录一条已保存的原始媒体。
 * payload: { tweetInfo, media, saved, probe? }
 */
async function recordSaved(payload) {
  const { tweetInfo, media, saved, probe } = payload || {}
  if (!tweetInfo || !tweetInfo.id || !saved || !saved.id) throw new Error('记录已保存媒体缺少必要参数')
  const store = await load()
  const now = new Date().toISOString()
  const existing = store.entries[tweetInfo.id]
  const entry = existing || {
    id: tweetInfo.id,
    tweetUrl: tweetInfo.url,
    author: tweetInfo.author,
    text: tweetInfo.text || '',
    tweetCreatedAt: tweetInfo.createdAt || null,
    fetchedAt: now,
    lastOpenedAt: now,
    media: [],
    savedMedia: [],
    results: [],
  }
  entry.tweetUrl = tweetInfo.url
  entry.author = tweetInfo.author
  entry.text = tweetInfo.text || ''
  entry.tweetCreatedAt = tweetInfo.createdAt || null
  entry.lastOpenedAt = now
  if (!Array.isArray(entry.media)) entry.media = []
  if (!Array.isArray(entry.savedMedia)) entry.savedMedia = []
  if (!Array.isArray(entry.results)) entry.results = []

  if (media) {
    const mediaIndex = entry.media.findIndex((item) => item.id === media.id)
    const mediaRecord = {
      id: media.id,
      kind: media.kind,
      sourceUrl: media.sourceUrl,
      thumbnailUrl: media.thumbnailUrl || null,
      localPath: saved.filePath,
      probe: probe && typeof probe === 'object' ? probe : null,
    }
    if (mediaIndex >= 0) entry.media[mediaIndex] = { ...entry.media[mediaIndex], ...mediaRecord }
    else entry.media.push(mediaRecord)
  }

  const savedIndex = entry.savedMedia.findIndex((item) => item && item.id === saved.id)
  if (savedIndex >= 0) entry.savedMedia[savedIndex] = { ...entry.savedMedia[savedIndex], ...saved }
  else entry.savedMedia.unshift(saved)

  store.entries[tweetInfo.id] = entry
  await persist()
  return JSON.parse(JSON.stringify(entry))
}

/** 删除一条已保存媒体记录，并尝试删除文件（幂等；文件不存在也视为成功） */
async function removeSaved(tweetId, savedId) {
  if (!tweetId || !savedId) return true
  const store = await load()
  const entry = store.entries[tweetId]
  if (!entry) return true
  if (!Array.isArray(entry.savedMedia)) entry.savedMedia = []
  const index = entry.savedMedia.findIndex((item) => item && item.id === savedId)
  if (index < 0) return true
  const [removed] = entry.savedMedia.splice(index, 1)
  try {
    if (removed && removed.filePath && fs.existsSync(removed.filePath)) {
      await fsp.rm(removed.filePath, { force: true })
    }
  } catch {
    /* 文件删除失败不影响记录清理 */
  }
  if (Array.isArray(entry.media)) {
    for (const mediaRecord of entry.media) {
      if (mediaRecord && removed && mediaRecord.localPath === removed.filePath) mediaRecord.localPath = null
    }
  }
  await persist()
  return true
}

/** 「另存为」后记录副本路径：按 GIF 文件名匹配 */
async function addCopy(fileBaseName, copyPath) {
  const store = await load()
  for (const entry of Object.values(store.entries)) {
    for (const result of entry.results) {
      const base = result.info && result.info.fileName ? result.info.fileName.replace(/\.gif$/i, '') : path.basename(result.gifPath, '.gif')
      if (base === fileBaseName) {
        result.copies = Array.isArray(result.copies) ? result.copies : []
        if (!result.copies.includes(copyPath)) result.copies.push(copyPath)
        await persist()
        return true
      }
    }
  }
  return false
}

module.exports = {
  historyPath,
  list,
  get,
  touch,
  remove,
  removeResult,
  removeSaved,
  clear,
  recordResult,
  recordSaved,
  findSaved,
  addCopy,
}
