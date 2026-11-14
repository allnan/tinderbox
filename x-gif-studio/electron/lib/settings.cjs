'use strict'

/** 设置持久化：<userData>/settings.json，原子写入，读取时与默认值合并。 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const paths = require('./paths.cjs')
const proxy = require('./proxy.cjs')
const { DEFAULT_SETTINGS, DEFAULT_PARAMS, normalizeParams } = require('./defaults.cjs')

let writeChain = Promise.resolve()

function settingsPath() {
  return path.join(paths.dataDir(), 'settings.json')
}

function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    proxy: proxy.normalizeProxySettings(source.proxy),
    outputDir: typeof source.outputDir === 'string' && source.outputDir.trim() ? source.outputDir.trim() : null,
    cacheDir: typeof source.cacheDir === 'string' && source.cacheDir.trim() ? source.cacheDir.trim() : null,
    defaultParams: normalizeParams({ ...DEFAULT_PARAMS, ...(source.defaultParams || {}) }),
    defaultPresetId: typeof source.defaultPresetId === 'string' && source.defaultPresetId ? source.defaultPresetId : 'source',
    keepOriginalMp4: typeof source.keepOriginalMp4 === 'boolean' ? source.keepOriginalMp4 : true,
    maxCacheSizeMb: Math.min(1024 * 1024, Math.max(256, Number(source.maxCacheSizeMb) || DEFAULT_SETTINGS.maxCacheSizeMb)),
    theme: ['dark', 'light', 'system'].includes(source.theme) ? source.theme : DEFAULT_SETTINGS.theme,
  }
}

/** 读取 JSON 文件并把加密的代理密码解密到运行时对象（不落盘明文） */
function parsePersisted(raw) {
  const parsed = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && parsed.proxy && typeof parsed.proxy === 'object') {
    if (typeof parsed.proxy.passwordEnc === 'string') {
      parsed.proxy = { ...parsed.proxy, password: proxy.decryptPassword(parsed.proxy.passwordEnc) }
    }
  }
  return parsed
}

async function get() {
  try {
    const raw = await fsp.readFile(settingsPath(), 'utf8')
    return normalizeSettings(parsePersisted(raw))
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

function getSync() {
  try {
    return normalizeSettings(parsePersisted(fs.readFileSync(settingsPath(), 'utf8')))
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

async function save(input) {
  const normalized = normalizeSettings(input)
  // 保存前校验代理配置，避免写入无法生效的地址
  const proxyConfig = proxy.buildProxyConfig(normalized.proxy)
  if (!proxyConfig.ok) {
    const error = new Error(proxyConfig.error || '代理设置不正确')
    error.code = 'PROXY_INVALID'
    throw error
  }
  const passwordEnc = proxy.encryptPassword(normalized.proxy.password)
  const persisted = {
    ...normalized,
    proxy: {
      mode: normalized.proxy.mode,
      url: normalized.proxy.url,
      bypass: normalized.proxy.bypass,
      username: normalized.proxy.username,
      passwordEnc: passwordEnc.value,
    },
  }
  writeChain = writeChain.then(async () => {
    const target = settingsPath()
    const dir = path.dirname(target)
    await fsp.mkdir(dir, { recursive: true })
    const tmp = target + '.tmp-' + process.pid
    await fsp.writeFile(tmp, JSON.stringify(persisted, null, 2), 'utf8')
    try {
      const old = await fsp.readFile(target, 'utf8')
      await fsp.writeFile(target + '.bak', old, 'utf8')
    } catch {
      /* 首次写入没有旧文件 */
    }
    await fsp.rename(tmp, target)
  })
  await writeChain
  return normalized
}

/** GIF 输出目录（设置优先，其次默认目录） */
async function getOutputDir() {
  const current = await get()
  return current.outputDir || paths.outputDir()
}

/** 媒体/帧缓存目录 */
async function getCacheDir() {
  const current = await get()
  return current.cacheDir || paths.cacheDir()
}

module.exports = { get, getSync, save, getOutputDir, getCacheDir, settingsPath, normalizeSettings }
