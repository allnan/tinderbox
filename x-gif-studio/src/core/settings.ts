import type { AppSettings, ProxyMode, ProxySettings, ThemeMode } from '../shared/types'
import { GIF_PRESETS } from '../shared/presets'
import { normalizeParams } from './params'

/** 缓存上限（MB）的安全范围 */
export const MAX_CACHE_SIZE_MIN_MB = 64
export const MAX_CACHE_SIZE_MAX_MB = 64 * 1024

/** 默认「不走代理的主机」；与主进程 electron/lib/proxy.cjs 的 DEFAULT_BYPASS 保持一致 */
export const DEFAULT_PROXY_BYPASS = 'localhost;127.0.0.1;<local>'

/** 合法的代理模式（白名单） */
export const PROXY_MODES: ProxyMode[] = ['system', 'custom', 'direct']

/** 合法的界面主题（白名单） */
export const THEME_MODES: ThemeMode[] = ['dark', 'light', 'system']

/** 主题归一：非法/缺失回退 dark（与主进程 electron/lib/settings.cjs 一致） */
export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'system' || value === 'dark' ? value : 'dark'
}

/** 主题模式中文名（界面展示用） */
export function themeModeLabel(mode: ThemeMode | null | undefined): string {
  if (mode === 'light') return '浅色'
  if (mode === 'system') return '跟随系统'
  return '深色'
}

/** 支持的代理协议；裸 host:port 按 http 处理（与主进程一致） */
const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks4']

/** 界面可选的代理协议（与主进程契约一致，不含 socks4） */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

/** 协议中文说明（下拉框用） */
export function proxyProtocolLabel(protocol: ProxyProtocol): string {
  if (protocol === 'socks5') return 'SOCKS5'
  return protocol === 'https' ? 'HTTPS' : 'HTTP'
}

export interface ProxyFormValue {
  protocol: ProxyProtocol
  host: string
  port: string
}

/**
 * 把已保存的代理 url 拆成表单字段（协议 / 主机 / 端口）。
 * 允许不完整输入（例如只有 host 或空字符串），便于分步填写。
 */
export function splitProxyUrlForForm(rawInput: string | null | undefined): ProxyFormValue {
  const raw = String(rawInput || '').trim()
  if (!raw) return { protocol: 'http', host: '', port: '' }
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'http'
  const rest = (schemeMatch ? schemeMatch[2] : raw).replace(/\/+$/, '')
  const protocol: ProxyProtocol = scheme === 'https' ? 'https' : scheme === 'socks5' || scheme === 'socks' ? 'socks5' : 'http'
  // 先按最后一个冒号拆端口（支持 IPv6 方括号形式）
  let host = rest
  let port = ''
  const bracket = rest.match(/^\[([^\]]+)\](?::(\d*))?$/)
  if (bracket) {
    host = '[' + bracket[1] + ']'
    port = bracket[2] || ''
  } else {
    const idx = rest.lastIndexOf(':')
    if (idx > 0 && rest.indexOf(':') === idx) {
      host = rest.slice(0, idx)
      port = rest.slice(idx + 1)
    }
  }
  return { protocol, host: host.trim(), port: port.trim() }
}

/** 由表单字段拼出代理 url（端口可暂缺，便于分步填写） */
export function buildProxyFormUrl(value: Partial<ProxyFormValue>): string {
  const protocol: ProxyProtocol = value.protocol === 'https' ? 'https' : value.protocol === 'socks5' ? 'socks5' : 'http'
  const host = String(value.host || '').trim()
  const port = String(value.port || '').trim()
  if (!host) return ''
  return protocol + '://' + host + (port ? ':' + port : '')
}

export type ProxyUrlParse =
  | { ok: true; protocol: string; host: string; port: number; url: string; username: string; password: string }
  | { ok: false; error: string }

/** 代理默认值：系统代理、空地址、本机回环直连 */
export function defaultProxySettings(): ProxySettings {
  return {
    mode: 'system',
    url: '',
    bypass: DEFAULT_PROXY_BYPASS,
    username: '',
    password: '',
  }
}

/** 代理模式中文名（界面展示用） */
export function proxyModeLabel(mode: ProxyMode | null | undefined): string {
  if (mode === 'custom') return '自定义代理'
  if (mode === 'direct') return '直连'
  return '系统代理'
}

/**
 * 代理配置归一：模式白名单回退 system，字符串字段去首尾空白，密码保持原样。
 * 与主进程 electron/lib/proxy.cjs 的 normalizeProxySettings 行为保持一致。
 */
export function normalizeProxySettings(input: Partial<ProxySettings> | null | undefined): ProxySettings {
  const raw = (input ?? {}) as Partial<ProxySettings>
  const mode = PROXY_MODES.includes(raw.mode as ProxyMode) ? (raw.mode as ProxyMode) : 'system'
  return {
    mode,
    url: typeof raw.url === 'string' ? raw.url.trim() : '',
    bypass: typeof raw.bypass === 'string' ? raw.bypass.trim() : DEFAULT_PROXY_BYPASS,
    username: typeof raw.username === 'string' ? raw.username.trim() : '',
    password: typeof raw.password === 'string' ? raw.password : '',
  }
}

/**
 * 解析自定义代理地址（纯函数，与主进程 parseProxyUrl 的规则一致）：
 * - 支持 http://、https://、socks5://、socks4://，裸 host:port 按 http；
 * - 缺省端口按协议补全（http 80 / https 443 / socks 1080）；
 * - 地址里携带的 user:pass@ 会被解出，供认证回填。
 */
export function parseProxyUrl(rawInput: string | null | undefined): ProxyUrlParse {
  const raw = String(rawInput ?? '').trim()
  if (!raw) {
    return { ok: false, error: '请填写代理地址，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080' }
  }
  let value = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) value = 'http://' + value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: '代理地址格式不正确：' + raw }
  }
  const protocol = parsed.protocol.replace(':', '').toLowerCase()
  if (!PROXY_SCHEMES.includes(protocol)) {
    return { ok: false, error: '不支持的代理协议：' + protocol + '（支持 http / https / socks5）' }
  }
  const host = parsed.hostname
  if (!host) return { ok: false, error: '代理地址缺少主机名：' + raw }
  const defaultPort = protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 80
  const port = parsed.port ? Number(parsed.port) : defaultPort
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: '代理端口不正确：' + parsed.port }
  }
  let username = ''
  let password = ''
  try {
    username = parsed.username ? decodeURIComponent(parsed.username) : ''
    password = parsed.password ? decodeURIComponent(parsed.password) : ''
  } catch {
    // 非法转义时忽略地址内嵌凭据，由用户单独填写
  }
  return { ok: true, protocol, host, port, url: protocol + '://' + host + ':' + port, username, password }
}

/** 代理地址校验：合法返回 null，非法返回可直接展示的中文错误 */
export function validateProxyUrl(rawInput: string | null | undefined): string | null {
  const parsed = parseProxyUrl(rawInput)
  return parsed.ok ? null : parsed.error
}

export function defaultSettings(): AppSettings {
  return {
    outputDir: null,
    cacheDir: null,
    defaultParams: normalizeParams(null),
    defaultPresetId: 'source',
    keepOriginalMp4: true,
    maxCacheSizeMb: 4096,
    proxy: defaultProxySettings(),
    theme: 'dark',
  }
}

function normalizeDir(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 设置兜底与校验：settings:get 的返回值、用户编辑后的保存请求都走这里。
 * 尤其是 defaultParams / proxy 可能缺失或来自旧版本，必须补齐为完整合法结构。
 */
export function normalizeSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const fallback = defaultSettings()
  const raw = (input ?? {}) as Partial<AppSettings>
  const presetId =
    typeof raw.defaultPresetId === 'string' && GIF_PRESETS.some((preset) => preset.id === raw.defaultPresetId)
      ? raw.defaultPresetId
      : fallback.defaultPresetId
  const maxCache = Number(raw.maxCacheSizeMb)
  return {
    outputDir: normalizeDir(raw.outputDir),
    cacheDir: normalizeDir(raw.cacheDir),
    defaultParams: normalizeParams(raw.defaultParams),
    defaultPresetId: presetId,
    keepOriginalMp4: typeof raw.keepOriginalMp4 === 'boolean' ? raw.keepOriginalMp4 : fallback.keepOriginalMp4,
    maxCacheSizeMb: Number.isFinite(maxCache)
      ? Math.min(MAX_CACHE_SIZE_MAX_MB, Math.max(MAX_CACHE_SIZE_MIN_MB, Math.round(maxCache)))
      : fallback.maxCacheSizeMb,
    proxy: normalizeProxySettings(raw.proxy),
    theme: normalizeThemeMode(raw.theme),
  }
}

/** 两份设置是否一致（用于「有未保存更改」判断；proxy 逐字段比较） */
export function settingsEqual(a: AppSettings, b: AppSettings): boolean {
  return (
    a.outputDir === b.outputDir &&
    a.cacheDir === b.cacheDir &&
    a.defaultPresetId === b.defaultPresetId &&
    a.keepOriginalMp4 === b.keepOriginalMp4 &&
    a.maxCacheSizeMb === b.maxCacheSizeMb &&
    JSON.stringify(a.defaultParams) === JSON.stringify(b.defaultParams) &&
    JSON.stringify(normalizeProxySettings(a.proxy)) === JSON.stringify(normalizeProxySettings(b.proxy)) &&
    normalizeThemeMode(a.theme) === normalizeThemeMode(b.theme)
  )
}

/** 生效的输出目录：用户未自定义时回退到应用默认目录 */
export function effectiveOutputDir(settings: AppSettings, fallback: string | null): string | null {
  return settings.outputDir ?? fallback
}

/** 生效的缓存目录 */
export function effectiveCacheDir(settings: AppSettings, fallback: string | null): string | null {
  return settings.cacheDir ?? fallback
}