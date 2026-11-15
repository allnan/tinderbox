import { describe, expect, test } from './_testkit'
import {
  buildGifFileName,
  fileBaseName,
  formatFileTimestamp,
  sanitizeFileNamePart,
  shortenPath,
} from './filename'

const FIXED_DATE = new Date(2026, 10, 11, 1, 10, 57)

describe('sanitizeFileNamePart', () => {
  test('替换 Windows 非法字符', () => {
    expect(sanitizeFileNamePart('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
  })

  test('空白转下划线、去掉首尾点', () => {
    expect(sanitizeFileNamePart('  hello world  ')).toBe('hello_world')
    expect(sanitizeFileNamePart('..name..')).toBe('name')
  })

  test('空值回退', () => {
    expect(sanitizeFileNamePart('')).toBe('unknown')
    expect(sanitizeFileNamePart(null, 'x')).toBe('x')
    expect(sanitizeFileNamePart('   ', 'fallback')).toBe('fallback')
  })

  test('超长片段被截断', () => {
    expect(sanitizeFileNamePart('a'.repeat(100)).length).toBeLessThanOrEqual(48)
  })
})

describe('formatFileTimestamp', () => {
  test('格式为 YYYYMMDD-HHmmss', () => {
    expect(formatFileTimestamp(FIXED_DATE)).toBe('20261111-011057')
  })
})

describe('buildGifFileName', () => {
  test('完整参数生成契约要求的文件名', () => {
    expect(
      buildGifFileName({
        screenName: 'jack',
        tweetId: '1234567890',
        mediaIndex: 2,
        width: 1080,
        height: 1920,
        presetId: 'source',
        date: FIXED_DATE,
      }),
    ).toBe('jack_1234567890_2_1080x1920_source_20261111-011057.gif')
  })

  test('缺失宽高使用 auto，缺失预设使用 custom', () => {
    const name = buildGifFileName({
      screenName: 'jack',
      tweetId: '20',
      mediaIndex: 1,
      width: null,
      height: null,
      presetId: null,
      date: FIXED_DATE,
    })
    expect(name).toBe('jack_20_1_auto_custom_20261111-011057.gif')
  })

  test('序号最小为 1，非法字符被清理', () => {
    const name = buildGifFileName({
      screenName: 'a:b',
      tweetId: 'x/y',
      mediaIndex: 0,
      width: 480,
      height: 640,
      presetId: 'small',
      date: FIXED_DATE,
    })
    expect(name.startsWith('a_b_x_y_1_480x640_small_')).toBeTruthy()
  })
})

describe('路径工具', () => {
  test('fileBaseName 支持 Windows 与 POSIX 路径', () => {
    expect(fileBaseName('C:\\Users\\demo\\out.gif')).toBe('out.gif')
    expect(fileBaseName('/home/demo/out.gif')).toBe('out.gif')
    expect(fileBaseName(null)).toBe('')
  })

  test('shortenPath 中间省略', () => {
    const longPath = 'C:\\Users\\demo\\AppData\\Roaming\\x-gif-studio\\gifs\\a.gif'
    const short = shortenPath(longPath, 40)
    expect(short).toContain('…')
    expect(short.length).toBeLessThanOrEqual(40)
    expect(shortenPath('C:\\a.gif', 40)).toBe('C:\\a.gif')
  })
})
