'use strict'

/**
 * network.cjs 与引擎接入测试：
 * - 纯 Node 下 network.fetch 退化为全局 fetch；
 * - tweet.cjs / media.cjs 的所有出站请求都必须经过 network.fetch（禁止裸 fetch，契约 §6.1）；
 * - 媒体下载的流式/异步迭代/arrayBuffer 三种响应 body 兼容分支。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const helpers = require('./helpers.cjs')
const network = require(helpers.libPath('network.cjs'))
const tweet = require(helpers.libPath('tweet.cjs'))
const media = require(helpers.libPath('media.cjs'))

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xgif-network-'))
const originalFetch = network.fetch

/** 在测试内临时替换 network.fetch，结束后恢复 */
async function withNetworkFetch(replacement, fn) {
  network.fetch = replacement
  try {
    return await fn()
  } finally {
    network.fetch = originalFetch
  }
}

test.after(() => helpers.removeTempDir(tempDir))

// ---------------------------------------------------------------------------
// network.cjs 的纯 Node 退化
// ---------------------------------------------------------------------------

test('network：纯 Node 环境下 isElectronFetch=false，fetch 退化为全局 fetch', async () => {
  assert.equal(network.isElectronFetch(), false)
  const originalGlobal = globalThis.fetch
  let called = 0
  globalThis.fetch = async (input, init) => {
    called += 1
    return new Response('delegated', { status: 200 })
  }
  try {
    const response = await network.fetch('data:text/plain,hello')
    assert.equal(called, 1)
    assert.equal(await response.text(), 'delegated')
  } finally {
    globalThis.fetch = originalGlobal
  }
})

test('network：fetchWithTimeout / fetchJson 在纯 Node 下可用', async () => {
  const textResponse = await network.fetchWithTimeout('data:text/plain,hi', {}, 2000)
  assert.equal(await textResponse.text(), 'hi')

  const json = await network.fetchJson('data:application/json,' + encodeURIComponent(JSON.stringify({ ok: true })), {}, 2000)
  assert.deepEqual(json, { ok: true })

  await assert.rejects(() => network.fetchJson('data:text/plain,not-json', {}, 2000), /不是有效 JSON/)
})

// ---------------------------------------------------------------------------
// tweet.cjs 走 network.fetch
// ---------------------------------------------------------------------------

test('tweet.fetch：请求经 network.fetch 发出并按 fxtwitter v2 归一化', async () => {
  const tweetId = '1234567890123456789'
  const fakeBody = {
    code: 200,
    status: {
      id: tweetId,
      url: 'https://x.com/tester/status/' + tweetId,
      text: '',
      created_at: 'Sat Oct 31 20:35:25 +0000 2026',
      author: {
        name: 'Tester',
        screen_name: 'tester',
        avatar_url: 'https://pbs.twimg.com/profile_images/1/avatar.jpg',
        verification: { verified: false },
      },
      media: {
        all: [
          {
            id: 'media-1',
            type: 'gif',
            url: 'https://video.twimg.com/tweet_video/sample.mp4',
            thumbnail_url: 'https://pbs.twimg.com/tweet_video_thumb/sample.jpg',
            width: 720,
            height: 720,
            formats: [{ url: 'https://video.twimg.com/tweet_video/sample.mp4', bitrate: 0, container: 'mp4' }],
          },
        ],
      },
    },
  }
  const calls = []
  await withNetworkFetch(
    async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify(fakeBody), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    async () => {
      tweet.clearCache()
      const info = await tweet.fetch('https://x.com/tester/status/' + tweetId)
      assert.equal(info.id, tweetId)
      assert.equal(info.source, 'fxtwitter')
      assert.equal(info.author.screenName, 'tester')
      assert.equal(info.media.length, 1)
      assert.equal(info.media[0].kind, 'gif')
      assert.equal(info.media[0].sourceUrl, 'https://video.twimg.com/tweet_video/sample.mp4')
      assert.equal(info.media[0].width, 720)
      assert.equal(tweet.getCached(tweetId)?.id, tweetId)
    },
  )
  assert.equal(calls.length, 1, 'fxtwitter v2 成功时不应再请求回退接口')
  assert.match(calls[0], /^https:\/\/api\.fxtwitter\.com\/2\/status\//)
})

test('tweet.fetch：接口全 404 时经 network.fetch 逐个回退并给出中文不存在错误', async () => {
  const tweetId = '1234567890123456789'
  const calls = []
  await withNetworkFetch(
    async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    },
    async () => {
      tweet.clearCache()
      await assert.rejects(
        () => tweet.fetch('https://x.com/tester/status/' + tweetId),
        (error) => {
          assert.equal(error.code, 'TWEET_NOT_FOUND')
          assert.match(error.message, /推文不存在或已被删除/)
          return true
        },
      )
    },
  )
  assert.ok(calls.length >= 4, '应尝试 fxtwitter v2/v1、syndication、vxtwitter 四级回退，实际 ' + calls.length)
  assert.ok(calls.some((url) => url.includes('api.fxtwitter.com/2/status/')))
  assert.ok(calls.some((url) => url.includes('cdn.syndication.twimg.com')))
  assert.ok(calls.some((url) => url.includes('api.vxtwitter.com')))
})

// ---------------------------------------------------------------------------
// media.cjs 走 network.fetch + 流式下载兼容
// ---------------------------------------------------------------------------

test('media.download：经 network.fetch 流式下载（Web ReadableStream）并上报进度', async () => {
  const chunks = [Buffer.from('he'), Buffer.from('llo')]
  let requestedUrl = null
  await withNetworkFetch(
    async (url) => {
      requestedUrl = String(url)
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5' } })
    },
    async () => {
      const destination = path.join(tempDir, 'stream.mp4')
      const progress = []
      const result = await media.download(
        'https://video.twimg.com/tweet_video/stream.mp4',
        destination,
        (percent, received, total) => progress.push({ percent, received, total }),
        null,
        { retries: 1 },
      )
      assert.equal(requestedUrl, 'https://video.twimg.com/tweet_video/stream.mp4')
      assert.equal(result.sizeBytes, 5)
      assert.equal(fs.readFileSync(destination, 'utf8'), 'hello')
      assert.ok(progress.length > 0, '应上报下载进度')
      assert.deepEqual(progress[progress.length - 1], { percent: 100, received: 5, total: 5 })
    },
  )
})

test('media.download：兼容 async iterable body（无 getReader 的运行时）', async () => {
  await withNetworkFetch(
    async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '4' }),
      body: (async function* generate() {
        yield Buffer.from('ab')
        yield Buffer.from('cd')
      })(),
    }),
    async () => {
      const destination = path.join(tempDir, 'iterable.mp4')
      const result = await media.download('https://video.twimg.com/x/iterable.mp4', destination, null, null, { retries: 1 })
      assert.equal(result.sizeBytes, 4)
      assert.equal(fs.readFileSync(destination, 'utf8'), 'abcd')
    },
  )
})

test('media.download：响应没有 body 时退化为 arrayBuffer()', async () => {
  await withNetworkFetch(
    async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'video/mp4', 'content-length': '3' }),
      body: null,
      arrayBuffer: async () => new TextEncoder().encode('abc').buffer,
    }),
    async () => {
      const destination = path.join(tempDir, 'buffer.mp4')
      const result = await media.download('https://video.twimg.com/x/buffer.mp4', destination, null, null, { retries: 1 })
      assert.equal(result.sizeBytes, 3)
      assert.equal(fs.readFileSync(destination, 'utf8'), 'abc')
    },
  )
})

test('media.download：网络失败按次数重试并给出中文错误', async () => {
  let attempts = 0
  await withNetworkFetch(
    async () => {
      attempts += 1
      throw new Error('boom')
    },
    async () => {
      const destination = path.join(tempDir, 'fail.mp4')
      await assert.rejects(
        () => media.download('https://video.twimg.com/x/fail.mp4', destination, null, null, { retries: 2 }),
        (error) => {
          assert.equal(error.code, 'NETWORK_ERROR')
          assert.match(error.message, /网络连接失败/)
          return true
        },
      )
    },
  )
  assert.equal(attempts, 2)
  assert.equal(fs.existsSync(path.join(tempDir, 'fail.mp4')), false, '失败后不应留下目标文件')
})

test('media.download：任务取消会中止下载并返回 CANCELLED', async () => {
  await withNetworkFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        const onAbort = () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        if (init && init.signal) {
          if (init.signal.aborted) onAbort()
          else init.signal.addEventListener('abort', onAbort, { once: true })
        }
      }),
    async () => {
      const controller = new AbortController()
      const destination = path.join(tempDir, 'cancel.mp4')
      const promise = media.download('https://video.twimg.com/x/cancel.mp4', destination, null, controller.signal, { retries: 1 })
      setTimeout(() => controller.abort(), 30)
      await assert.rejects(promise, (error) => {
        assert.equal(error.code, 'CANCELLED')
        return true
      })
      assert.equal(fs.existsSync(destination), false)
    },
  )
})

// ---------------------------------------------------------------------------
// 契约守卫：引擎不得直接使用全局 fetch
// ---------------------------------------------------------------------------

test('tweet.cjs / media.cjs 中不存在裸 fetch 调用（必须走 network.fetch）', () => {
  for (const file of ['tweet.cjs', 'media.cjs']) {
    const source = fs.readFileSync(helpers.libPath(file), 'utf8')
    const bareCalls = [...source.matchAll(/(?<![.\w])fetch\s*\(/g)].map((match) => source.slice(Math.max(0, match.index - 30), match.index + 10))
    assert.deepEqual(bareCalls, [], file + ' 不应直接调用全局 fetch：' + bareCalls.join(' | '))
  }
})
