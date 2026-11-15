import { describe, expect, test } from './_testkit'
import { DEFAULT_PARAMS } from '../shared/presets'
import {
  DEFAULT_PROXY_BYPASS,
  MAX_CACHE_SIZE_MAX_MB,
  MAX_CACHE_SIZE_MIN_MB,
  defaultProxySettings,
  defaultSettings,
  effectiveCacheDir,
  effectiveOutputDir,
  normalizeProxySettings,
  normalizeSettings,
  normalizeThemeMode,
  parseProxyUrl,
  buildProxyFormUrl,
  splitProxyUrlForForm,
  proxyModeLabel,
  settingsEqual,
  themeModeLabel,
  validateProxyUrl,
} from './settings'

describe('defaultSettings', () => {
  test('提供完整默认值', () => {
    const settings = defaultSettings()
    expect(settings.outputDir).toBeNull()
    expect(settings.cacheDir).toBeNull()
    expect(settings.defaultPresetId).toBe('source')
    expect(settings.keepOriginalMp4).toBeTruthy()
    expect(settings.maxCacheSizeMb).toBe(4096)
    expect(settings.defaultParams).toEqual(DEFAULT_PARAMS)
    expect(settings.proxy).toEqual(defaultProxySettings())
    expect(settings.theme).toBe('dark')
  })

  test('代理默认值：系统代理 + 本机回环直连 + 空凭据', () => {
    const proxy = defaultProxySettings()
    expect(proxy.mode).toBe('system')
    expect(proxy.url).toBe('')
    expect(proxy.bypass).toBe(DEFAULT_PROXY_BYPASS)
    expect(proxy.username).toBe('')
    expect(proxy.password).toBe('')
  })
})

describe('normalizeSettings', () => {
  test('空对象 / 空参数兜底为默认值', () => {
    const settings = normalizeSettings({})
    expect(settings.defaultParams).toEqual(DEFAULT_PARAMS)
    expect(normalizeSettings({ defaultParams: {} as never }).defaultParams).toEqual(DEFAULT_PARAMS)
    expect(normalizeSettings(null).defaultPresetId).toBe('source')
    expect(normalizeSettings({}).proxy).toEqual(defaultProxySettings())
    expect(normalizeSettings(null).proxy).toEqual(defaultProxySettings())
  })

  test('非法预设回退 source', () => {
    expect(normalizeSettings({ defaultPresetId: 'nope' }).defaultPresetId).toBe('source')
    expect(normalizeSettings({ defaultPresetId: 'mini' }).defaultPresetId).toBe('mini')
  })

  test('目录空白字符串归一为 null', () => {
    expect(normalizeSettings({ outputDir: '   ' }).outputDir).toBeNull()
    expect(normalizeSettings({ outputDir: '  D:\\out  ' }).outputDir).toBe('D:\\out')
  })

  test('缓存上限收敛到安全范围', () => {
    expect(normalizeSettings({ maxCacheSizeMb: 0 }).maxCacheSizeMb).toBe(MAX_CACHE_SIZE_MIN_MB)
    expect(normalizeSettings({ maxCacheSizeMb: 10 ** 9 }).maxCacheSizeMb).toBe(MAX_CACHE_SIZE_MAX_MB)
    expect(normalizeSettings({ maxCacheSizeMb: 'abc' as never }).maxCacheSizeMb).toBe(4096)
  })

  test('非布尔 keepOriginalMp4 回退默认', () => {
    expect(normalizeSettings({ keepOriginalMp4: 'yes' as never }).keepOriginalMp4).toBeTruthy()
    expect(normalizeSettings({ keepOriginalMp4: false }).keepOriginalMp4).toBeFalsy()
  })
})

describe('normalizeProxySettings', () => {
  test('缺省 / null 回退默认代理', () => {
    expect(normalizeProxySettings(null)).toEqual(defaultProxySettings())
    expect(normalizeProxySettings(undefined)).toEqual(defaultProxySettings())
    expect(normalizeProxySettings({})).toEqual(defaultProxySettings())
  })

  test('非法模式回退 system', () => {
    expect(normalizeProxySettings({ mode: 'nope' as never }).mode).toBe('system')
    expect(normalizeProxySettings({ mode: 'custom' }).mode).toBe('custom')
    expect(normalizeProxySettings({ mode: 'direct' }).mode).toBe('direct')
  })

  test('字符串字段 trim，密码原样保留', () => {
    const proxy = normalizeProxySettings({
      mode: 'custom',
      url: '  http://127.0.0.1:7890  ',
      bypass: '  localhost, 10.0.0.0/8  ',
      username: '  user  ',
      password: '  p@ss  ',
    })
    expect(proxy.url).toBe('http://127.0.0.1:7890')
    expect(proxy.bypass).toBe('localhost, 10.0.0.0/8')
    expect(proxy.username).toBe('user')
    expect(proxy.password).toBe('  p@ss  ')
  })

  test('非字符串字段回退默认值，空 bypass 保持为空', () => {
    const proxy = normalizeProxySettings({
      url: 42 as never,
      bypass: 7 as never,
      username: null as never,
      password: null as never,
    })
    expect(proxy.url).toBe('')
    expect(proxy.bypass).toBe(DEFAULT_PROXY_BYPASS)
    expect(proxy.username).toBe('')
    expect(proxy.password).toBe('')
    expect(normalizeProxySettings({ bypass: '' }).bypass).toBe('')
  })
})

describe('splitProxyUrlForForm / buildProxyFormUrl', () => {
  test('拆分完整地址：协议 / 主机 / 端口', () => {
    expect(splitProxyUrlForForm('socks5://127.0.0.1:1080')).toEqual({ protocol: 'socks5', host: '127.0.0.1', port: '1080' })
    expect(splitProxyUrlForForm('https://proxy.local:8443')).toEqual({ protocol: 'https', host: 'proxy.local', port: '8443' })
    expect(splitProxyUrlForForm('127.0.0.1:7890')).toEqual({ protocol: 'http', host: '127.0.0.1', port: '7890' })
  })

  test('空字符串与部分输入可拆分（便于分步填写）', () => {
    expect(splitProxyUrlForForm('')).toEqual({ protocol: 'http', host: '', port: '' })
    expect(splitProxyUrlForForm('127.0.0.1')).toEqual({ protocol: 'http', host: '127.0.0.1', port: '' })
    expect(splitProxyUrlForForm('http://127.0.0.1')).toEqual({ protocol: 'http', host: '127.0.0.1', port: '' })
  })

  test('由表单字段拼回 url；主机为空返回空字符串', () => {
    expect(buildProxyFormUrl({ protocol: 'socks5', host: '127.0.0.1', port: '1080' })).toBe('socks5://127.0.0.1:1080')
    expect(buildProxyFormUrl({ protocol: 'https', host: 'proxy.local', port: '8443' })).toBe('https://proxy.local:8443')
    expect(buildProxyFormUrl({ protocol: 'http', host: '127.0.0.1', port: '' })).toBe('http://127.0.0.1')
    expect(buildProxyFormUrl({ protocol: 'http', host: '', port: '7890' })).toBe('')
  })

  test('拆分的 url 可被主进程 parseProxyUrl 接受（往返一致）', () => {
    for (const url of ['http://127.0.0.1:7890', 'https://proxy.local:8443', 'socks5://127.0.0.1:1080']) {
      const form = splitProxyUrlForForm(url)
      expect(buildProxyFormUrl(form)).toBe(url)
      expect(parseProxyUrl(buildProxyFormUrl(form)).ok).toBe(true)
    }
  })
})

describe('parseProxyUrl / validateProxyUrl', () => {
  test('解析 http / https / socks5 与裸 host:port', () => {
    const http = parseProxyUrl('http://127.0.0.1:7890')
    expect(http.ok).toBeTruthy()
    if (http.ok) {
      expect(http.protocol).toBe('http')
      expect(http.host).toBe('127.0.0.1')
      expect(http.port).toBe(7890)
      expect(http.url).toBe('http://127.0.0.1:7890')
    }

    const bare = parseProxyUrl('127.0.0.1:7890')
    expect(bare.ok).toBeTruthy()
    if (bare.ok) expect(bare.protocol).toBe('http')

    const socks = parseProxyUrl('socks5://127.0.0.1:1080')
    expect(socks.ok).toBeTruthy()
    if (socks.ok) {
      expect(socks.protocol).toBe('socks5')
      expect(socks.port).toBe(1080)
    }

    const https = parseProxyUrl('https://proxy.local')
    expect(https.ok).toBeTruthy()
    if (https.ok) expect(https.port).toBe(443)
  })

  test('解析地址内嵌用户名/密码', () => {
    const parsed = parseProxyUrl('http://user:pass%401@127.0.0.1:8080')
    expect(parsed.ok).toBeTruthy()
    if (parsed.ok) {
      expect(parsed.username).toBe('user')
      expect(parsed.password).toBe('pass@1')
    }
  })

  test('空地址 / 非法协议 / 非法格式给出中文错误', () => {
    const empty = parseProxyUrl('')
    expect(empty.ok).toBeFalsy()
    if (!empty.ok) expect(empty.error).toContain('请填写代理地址')

    const ftp = parseProxyUrl('ftp://127.0.0.1:21')
    expect(ftp.ok).toBeFalsy()
    if (!ftp.ok) expect(ftp.error).toContain('不支持的代理协议')

    const broken = parseProxyUrl('http://')
    expect(broken.ok).toBeFalsy()
  })

  test('validateProxyUrl 合法返回 null', () => {
    expect(validateProxyUrl('socks5://127.0.0.1:1080')).toBeNull()
    expect(validateProxyUrl('')).toBeTruthy()
  })
})

describe('proxyModeLabel', () => {
  test('三种模式的中文名', () => {
    expect(proxyModeLabel('system')).toBe('系统代理')
    expect(proxyModeLabel('custom')).toBe('自定义代理')
    expect(proxyModeLabel('direct')).toBe('直连')
    expect(proxyModeLabel(null)).toBe('系统代理')
  })
})

describe('normalizeThemeMode / themeModeLabel', () => {
  test('合法主题保留，非法/缺失回退 dark', () => {
    expect(normalizeThemeMode('dark')).toBe('dark')
    expect(normalizeThemeMode('light')).toBe('light')
    expect(normalizeThemeMode('system')).toBe('system')
    expect(normalizeThemeMode('nope')).toBe('dark')
    expect(normalizeThemeMode(null)).toBe('dark')
    expect(normalizeThemeMode(undefined)).toBe('dark')
  })

  test('主题中文名', () => {
    expect(themeModeLabel('dark')).toBe('深色')
    expect(themeModeLabel('light')).toBe('浅色')
    expect(themeModeLabel('system')).toBe('跟随系统')
    expect(themeModeLabel(null)).toBe('深色')
  })

  test('normalizeSettings 归一 theme', () => {
    expect(normalizeSettings({ theme: 'light' }).theme).toBe('light')
    expect(normalizeSettings({ theme: 'system' }).theme).toBe('system')
    expect(normalizeSettings({ theme: 'bad' as never }).theme).toBe('dark')
    expect(normalizeSettings({}).theme).toBe('dark')
  })
})

describe('settingsEqual / 生效目录', () => {
  test('相同设置相等，参数变化不等', () => {
    const a = defaultSettings()
    const b = defaultSettings()
    expect(settingsEqual(a, b)).toBeTruthy()
    expect(settingsEqual(a, { ...b, defaultParams: { ...b.defaultParams, quality: 60 } })).toBeFalsy()
    expect(settingsEqual(a, { ...b, maxCacheSizeMb: 2048 })).toBeFalsy()
  })

  test('代理字段变化会被识别为不同', () => {
    const base = defaultSettings()
    expect(settingsEqual(base, { ...base, proxy: { ...base.proxy, mode: 'custom' } })).toBeFalsy()
    expect(settingsEqual(base, { ...base, proxy: { ...base.proxy, url: 'http://127.0.0.1:7890' } })).toBeFalsy()
    expect(settingsEqual(base, { ...base, proxy: { ...base.proxy, username: 'u' } })).toBeFalsy()
    expect(settingsEqual(base, { ...base, proxy: { ...base.proxy, password: 'p' } })).toBeFalsy()
    expect(settingsEqual(base, { ...base, proxy: { ...base.proxy, bypass: 'example.com' } })).toBeFalsy()
  })

  test('旧版本设置缺少 proxy 时按默认代理比较', () => {
    const base = defaultSettings()
    const legacy = { ...base, proxy: undefined as never }
    expect(settingsEqual(base, legacy)).toBeTruthy()
  })

  test('未自定义目录时回退应用默认目录', () => {
    const settings = defaultSettings()
    expect(effectiveOutputDir(settings, 'C:\\data\\gifs')).toBe('C:\\data\\gifs')
    expect(effectiveCacheDir(settings, 'C:\\data\\cache')).toBe('C:\\data\\cache')
    expect(effectiveOutputDir({ ...settings, outputDir: 'D:\\out' }, 'C:\\data\\gifs')).toBe('D:\\out')
  })
})