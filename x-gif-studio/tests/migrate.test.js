'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { migrateLegacyData, remapPath } = require('../electron/lib/migrate.cjs')

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xgif-migrate-' + tag + '-'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function buildLegacyFixture(legacy) {
  fs.mkdirSync(path.join(legacy, 'gifs', 'author', '123'), { recursive: true })
  const gifFile = path.join(legacy, 'gifs', 'author', '123', 'author_123_1_480x480_custom_20260101-000000.gif')
  fs.writeFileSync(gifFile, 'GIF89a')
  const cacheFile = path.join(legacy, 'cache', 'media', 'media1.mp4')
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  fs.writeFileSync(cacheFile, 'mp4')
  writeJson(path.join(legacy, 'settings.json'), {
    outputDir: path.join(legacy, 'gifs'),
    cacheDir: path.join(legacy, 'cache'),
    keepOriginalMp4: true,
  })
  writeJson(path.join(legacy, 'history.json'), {
    version: 1,
    entries: {
      123: {
        id: '123',
        tweetUrl: 'https://x.com/author/status/123',
        media: [{ id: 'media1', localPath: cacheFile }],
        savedMedia: [{ id: '123:media1:mp4', filePath: path.join(legacy, 'gifs', 'author', '123', 'author_123_1_720x720.mp4') }],
        results: [{ id: 'r1', gifPath: gifFile, copies: [path.join(legacy, 'gifs', 'copy.gif')] }],
      },
    },
  })
  return { gifFile, cacheFile }
}

test('迁移：复制设置/历史/GIF、改写路径、删除旧目录并写标记', () => {
  const root = tempDir('ok')
  const legacy = path.join(root, 'appdata', 'XGifStudio')
  const target = path.join(root, 'portable', 'userdata')
  const { gifFile } = buildLegacyFixture(legacy)
  const result = migrateLegacyData({ targetDir: target, legacyDir: legacy })
  assert.equal(result.ok, true)
  assert.equal(result.from, legacy)
  assert.equal(fs.existsSync(legacy), false, '旧目录应被清理')
  assert.equal(fs.existsSync(path.join(target, '.migrated')), true)
  assert.equal(fs.existsSync(path.join(target, 'gifs')) || fs.existsSync(path.join(target, 'media')), true)
  const history = JSON.parse(fs.readFileSync(path.join(target, 'history.json'), 'utf8'))
  const entry = history.entries['123']
  const expectedGif = path.join(target, 'media', 'author', '123', path.basename(gifFile))
  assert.equal(entry.results[0].gifPath, expectedGif)
  assert.equal(entry.results[0].copies[0], path.join(target, 'media', 'copy.gif'))
  assert.equal(entry.savedMedia[0].filePath, path.join(target, 'media', 'author', '123', 'author_123_1_720x720.mp4'))
  assert.equal(entry.media[0].localPath, null)
  assert.equal(fs.existsSync(path.join(target, 'media', 'author', '123', path.basename(gifFile))), true)
  const settings = JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'))
  assert.equal(settings.outputDir, path.join(target, 'media'))
  assert.equal(settings.cacheDir, null)
})

test('迁移：目标目录已有数据时跳过，且不删除旧目录', () => {
  const root = tempDir('skip')
  const legacy = path.join(root, 'appdata', 'XGifStudio')
  const target = path.join(root, 'portable', 'userdata')
  buildLegacyFixture(legacy)
  writeJson(path.join(target, 'history.json'), { version: 1, entries: {} })
  const result = migrateLegacyData({ targetDir: target, legacyDir: legacy })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
  assert.equal(fs.existsSync(legacy), true)
  assert.equal(fs.existsSync(path.join(target, '.migrated')), true)
})

test('迁移：旧目录不存在时跳过', () => {
  const root = tempDir('missing')
  const result = migrateLegacyData({ targetDir: path.join(root, 'target'), legacyDir: path.join(root, 'none') })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, true)
})

test('remapPath：gifs → media，cache → null，其他路径保持不变', () => {
  const legacy = path.join('C:', 'Users', 'demo', 'AppData', 'Roaming', 'XGifStudio')
  const target = path.join('D:', 'tools', 'XMediaStudio', 'userdata')
  const gif = path.join(legacy, 'gifs', 'a', '1', 'x.gif')
  assert.equal(remapPath(gif, legacy, target), path.join(target, 'media', 'a', '1', 'x.gif'))
  assert.equal(remapPath(path.join(legacy, 'cache', 'media', 'm.mp4'), legacy, target), null)
  assert.equal(remapPath(path.join('E:', 'other', 'file.gif'), legacy, target), path.join('E:', 'other', 'file.gif'))
})
