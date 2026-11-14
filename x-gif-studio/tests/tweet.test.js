'use strict'

/** tweet：链接解析、错误约定与真实接口抓取（无网络时跳过网络用例） */

const test = require('node:test')
const assert = require('node:assert/strict')

const helpers = require('./helpers.cjs')
const tweet = require(helpers.libPath('tweet.cjs'))

test('parseTweetUrl：支持 x.com / twitter.com / 移动端 / i/web / 查询参数与后缀', () => {
  const cases = [
    ['https://x.com/hardestgifs/status/2116630142135275663', '2116630142135275663', 'hardestgifs'],
    ['https://twitter.com/weird_gifs/status/2103895960703095139?s=20&t=abc', '2103895960703095139', 'weird_gifs'],
    ['https://mobile.twitter.com/Foo_Bar/statuses/1234567890123456789/photo/1', '1234567890123456789', 'Foo_Bar'],
    ['https://x.com/i/web/status/2116630142135275663', '2116630142135275663', null],
    ['x.com/i/status/2116630142135275663', '2116630142135275663', null],
    ['  https://www.x.com/hardestgifs/status/2116630142135275663  ', '2116630142135275663', 'hardestgifs'],
  ]
  for (const [url, id, screenName] of cases) {
    const parsed = tweet.parseTweetUrl(url)
    assert.ok(parsed, '应能解析：' + url)
    assert.equal(parsed.tweetId, id)
    assert.equal(parsed.screenName, screenName)
    assert.match(parsed.canonicalUrl, /^https:\/\/x\.com\/(i\/|[A-Za-z0-9_]+\/)status\//)
  }
  const invalid = [
    'https://x.com/hardestgifs',
    'https://example.com/status/1234567890',
    'https://x.com/hardestgifs/status/123',
    '1234567890',
    '',
    null,
    undefined,
  ]
  for (const value of invalid) assert.equal(tweet.parseTweetUrl(value), null, '不应解析：' + String(value))
})

test('syndicationToken 使用公开算法：((id/1e15)*PI).toString(36) 去掉点与 0', () => {
  const token = tweet.syndicationToken('2116630142135275663')
  assert.equal(typeof token, 'string')
  assert.ok(token.length > 0)
  assert.doesNotMatch(token, /\./)
  const expected = ((Number('2116630142135275663') / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
  assert.equal(token, expected)
})

test('非法链接直接抛出中文错误（INVALID_URL，不发请求）', async () => {
  await assert.rejects(() => tweet.fetch('not-a-tweet-link'), (error) => {
    assert.equal(error.code, 'INVALID_URL')
    assert.match(error.message, /链接格式不正确/)
    return true
  })
})

test('真实推文抓取：返回 TweetInfo 与可下载的 GIF mp4', async (t) => {
  if (!(await helpers.hasNetwork())) {
    t.skip('当前无网络，跳过真实接口用例')
    return
  }
  const info = await tweet.fetch('https://x.com/hardestgifs/status/2116630142135275663')
  assert.equal(info.id, '2116630142135275663')
  assert.ok(info.author.screenName.length > 0)
  assert.ok(['fxtwitter', 'syndication', 'vxtwitter'].includes(info.source))
  assert.ok(Array.isArray(info.media) && info.media.length > 0)
  const gifMedia = info.media.find((item) => item.kind === 'gif')
  assert.ok(gifMedia, '应识别出 animated_gif 媒体')
  assert.match(gifMedia.sourceUrl, /^https:\/\/video\.twimg\.com\//)
  assert.match(gifMedia.sourceUrl, /\.mp4/)
  assert.ok(gifMedia.width > 0 && gifMedia.height > 0)
  assert.equal(tweet.getCached(info.id)?.id, info.id)
})

test('不存在的推文返回中文「不存在」错误', async (t) => {
  if (!(await helpers.hasNetwork())) {
    t.skip('当前无网络，跳过真实接口用例')
    return
  }
  await assert.rejects(() => tweet.fetch('https://x.com/hardestgifs/status/1111111111111111111'), (error) => {
    assert.equal(error.code, 'TWEET_NOT_FOUND')
    assert.match(error.message, /推文不存在或已被删除/)
    return true
  })
})
