import React, { useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  ProxyCheck,
  ProxyMode,
  ProxySettings,
  ProxyTestResult,
  ThemeMode,
  ToolStatus,
} from '../shared/types'
import { useApp } from '../state/store'
import {
  DEFAULT_PROXY_BYPASS,
  MAX_CACHE_SIZE_MAX_MB,
  MAX_CACHE_SIZE_MIN_MB,
  PROXY_PROTOCOLS,
  buildProxyFormUrl,
  effectiveCacheDir,
  effectiveOutputDir,
  normalizeProxySettings,
  normalizeSettings,
  parseProxyUrl,
  proxyModeLabel,
  proxyProtocolLabel,
  settingsEqual,
  splitProxyUrlForForm,
  themeModeLabel,
  type ProxyFormValue,
  type ProxyProtocol,
} from '../core/settings'
import { detectPresetId } from '../core/params'
import { shortenPath } from '../core/filename'
import {
  Button,
  Field,
  Icon,
  IconButton,
  Panel,
  Spinner,
  Switch,
  useToast,
  type IconName,
} from '../components/ui'
import { ParamPanel } from '../components/ParamPanel'

const TOOL_INFO: { key: 'ffmpeg' | 'gifski' | 'gifsicle'; label: string; purpose: string }[] = [
  { key: 'ffmpeg', label: 'ffmpeg', purpose: '解码、缩放、抽帧与生成缩略图' },
  { key: 'gifski', label: 'gifski', purpose: '高质量 GIF 编码（GIF 输出使用）' },
  { key: 'gifsicle', label: 'gifsicle', purpose: 'GIF 极限压缩优化（仅 GIF 输出可用）' },
]

const PROXY_MODE_OPTIONS: { value: ProxyMode; label: string; desc: string; icon: IconName }[] = [
  { value: 'system', label: '系统代理', desc: '跟随 Windows 系统代理设置（默认）', icon: 'monitor' },
  { value: 'custom', label: '自定义代理', desc: '手动填写 HTTP / HTTPS / SOCKS5 地址', icon: 'sliders' },
  { value: 'direct', label: '直连', desc: '不使用代理，适合排障对照', icon: 'bolt' },
]

const THEME_OPTIONS: { value: ThemeMode; label: string; desc: string; icon: IconName }[] = [
  { value: 'dark', label: '深色', desc: '深色界面，适合夜间与暗色桌面', icon: 'moon' },
  { value: 'light', label: '浅色', desc: '浅色界面，适合明亮环境', icon: 'sun' },
  { value: 'system', label: '跟随系统', desc: '随 Windows 深浅色设置自动切换', icon: 'monitor' },
]

function ToolRow({ name, purpose, tools }: { name: 'ffmpeg' | 'gifski' | 'gifsicle'; purpose: string; tools: ToolStatus | null }) {
  const path = tools ? tools[name] : null
  const version = tools ? (name === 'ffmpeg' ? tools.ffmpegVersion : name === 'gifski' ? tools.gifskiVersion : tools.gifsicleVersion) : null
  const ok = Boolean(path)
  return (
    <div className={ok ? 'tool-row is-ok' : 'tool-row is-missing'}>
      <span className={ok ? 'tool-status-icon is-ok' : 'tool-status-icon is-missing'}>
        <Icon name={ok ? 'success' : 'error'} size={16} />
      </span>
      <div className="tool-info">
        <div className="tool-name-line">
          <span className="tool-name mono">{name}</span>
          {version ? <span className="badge badge-success">{version}</span> : null}
          {!ok ? <span className="badge badge-danger">缺失</span> : null}
        </div>
        <div className="tool-purpose">{purpose}</div>
        {path ? (
          <div className="tool-path mono" title={path}>
            {path}
          </div>
        ) : (
          <div className="tool-missing-hint">
            请运行 <code>npm run fetch-tools</code>，或把 <code>{name}.exe</code> 放入 <code>tools/bin/</code> 后重启应用。
          </div>
        )}
      </div>
    </div>
  )
}

/** 代理测试中的单项检查结果 */
function ProxyCheckRow({ check }: { check: ProxyCheck }) {
  const statusText = check.status === null ? '无法连接' : 'HTTP ' + check.status
  const latencyText = Number.isFinite(check.latencyMs) && check.latencyMs >= 0 ? ' · ' + Math.round(check.latencyMs) + ' ms' : ''
  return (
    <div className={check.ok ? 'proxy-check is-ok' : 'proxy-check is-fail'}>
      <span className={check.ok ? 'proxy-check-icon is-ok' : 'proxy-check-icon is-fail'}>
        <Icon name={check.ok ? 'success' : 'error'} size={15} />
      </span>
      <div className="proxy-check-main">
        <div className="proxy-check-line">
          <span className="proxy-check-name">{check.name}</span>
          <span className="proxy-check-meta mono">
            {statusText}
            {latencyText}
          </span>
        </div>
        <div className="proxy-check-url mono" title={check.url}>
          {check.url}
        </div>
        {check.error ? <div className="proxy-check-error">{check.error}</div> : null}
      </div>
    </div>
  )
}

/** 代理测试总体结果与逐项检查 */
function ProxyTestResultCard({ result, onClear }: { result: ProxyTestResult; onClear: () => void }) {
  return (
    <div className={result.ok ? 'proxy-result is-ok' : 'proxy-result is-fail'} data-testid="proxy-test-result">
      <div className="proxy-result-head">
        <span className={result.ok ? 'proxy-result-status is-ok' : 'proxy-result-status is-fail'}>
          <Icon name={result.ok ? 'success' : 'error'} size={15} />
          {result.ok ? '连接正常' : '连接失败'}
        </span>
        <span className="proxy-result-mode" title={result.effectiveUrl ?? undefined}>
          {proxyModeLabel(result.mode)}
          {result.effectiveUrl ? ' · ' + result.effectiveUrl : ''}
        </span>
        <Button size="xs" variant="ghost" icon="close" onClick={onClear}>
          清除结果
        </Button>
      </div>
      {result.error ? (
        <div className="proxy-result-error">
          <Icon name="warning" size={14} />
          <span>{result.error}</span>
        </div>
      ) : null}
      {result.checks.length > 0 ? (
        <div className="proxy-check-list">
          {result.checks.map((check) => (
            <ProxyCheckRow key={check.name + '|' + check.url} check={check} />
          ))}
        </div>
      ) : null}
      <div className="proxy-result-note">
        <Icon name="info" size={12} />
        逐项分别为 X 解析接口与媒体 CDN 的连通性；全部通过才表示当前网络能正常解析推文并下载媒体。
      </div>
    </div>
  )
}

export default function SettingsView() {
  const {
    settings,
    info,
    infoError,
    settingsError,
    desktopAvailable,
    saveSettings,
    chooseDirectory,
    openOutputDir,
    openCacheDir,
    refreshInfo,
    setThemePreview,
    openDataDir,
  } = useApp()
  const { toast } = useToast()
  const [draft, setDraft] = useState<AppSettings>(() => normalizeSettings(settings))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cacheText, setCacheText] = useState(String(normalizeSettings(settings).maxCacheSizeMb))
  const [checkingTools, setCheckingTools] = useState(false)
  const [showProxyPassword, setShowProxyPassword] = useState(false)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyTest, setProxyTest] = useState<ProxyTestResult | null>(null)
  const [proxyTestError, setProxyTestError] = useState<string | null>(null)
  // 自定义代理表单：协议 / 主机 / 端口分段填写，内部仍写回完整 url（与主进程契约一致）
  const [proxyForm, setProxyForm] = useState<ProxyFormValue>(() => splitProxyUrlForForm(normalizeSettings(settings).proxy.url))

  useEffect(() => {
    const next = normalizeSettings(settings)
    setDraft(next)
    setCacheText(String(next.maxCacheSizeMb))
    setDirty(false)
    setProxyTest(null)
    setProxyTestError(null)
    setProxyForm(splitProxyUrlForForm(next.proxy.url))
    setThemePreview(null)
  }, [settings, setThemePreview])

  // 离开设置页时取消主题临时预览，回到已保存主题
  useEffect(() => () => setThemePreview(null), [setThemePreview])

  const updateDraft = (patch: Partial<AppSettings>) => {
    const next = normalizeSettings({ ...draftRef.current, ...patch })
    draftRef.current = next
    setDraft(next)
    setDirty(!settingsEqual(next, settings))
  }

  const updateProxy = (patch: Partial<ProxySettings>) => {
    // 配置改动后旧的测试结果不再可信，直接清空
    setProxyTest(null)
    setProxyTestError(null)
    updateDraft({ proxy: { ...draftRef.current.proxy, ...patch } })
  }

  const tools = info?.tools ?? null
  const readyCount = tools ? [tools.ffmpeg, tools.gifski, tools.gifsicle].filter(Boolean).length : 0
  const outputPath = effectiveOutputDir(draft, info?.outputDir ?? null)
  const cachePath = effectiveCacheDir(draft, info?.cacheDir ?? null)

  const proxyUrlError = (() => {
    if (draft.proxy.mode !== 'custom' || !draft.proxy.url.trim()) return null
    const parsed = parseProxyUrl(draft.proxy.url)
    return parsed.ok ? null : parsed.error
  })()

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveSettings(draftRef.current)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    const next = normalizeSettings(settings)
    draftRef.current = next
    setDraft(next)
    setCacheText(String(next.maxCacheSizeMb))
    setDirty(false)
    setProxyTest(null)
    setProxyTestError(null)
    setProxyForm(splitProxyUrlForForm(next.proxy.url))
    setThemePreview(null)
  }

  const updateProxyForm = (patch: Partial<ProxyFormValue>) => {
    const next = { ...proxyForm, ...patch }
    setProxyForm(next)
    updateProxy({ url: buildProxyFormUrl(next) })
  }

  const handleProxyHostChange = (raw: string) => {
    // 支持直接粘贴完整地址（http://host:port / socks5://host:port），自动拆分协议与端口
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || raw.split(':').length > 2) {
      const parsed = splitProxyUrlForForm(raw)
      setProxyForm(parsed)
      updateProxy({ url: buildProxyFormUrl(parsed) })
      return
    }
    updateProxyForm({ host: raw })
  }

  const proxyHostError =
    draft.proxy.mode === 'custom' && !proxyForm.host.trim() ? '请填写代理主机或 IP' : null
  const proxyPortError = (() => {
    if (draft.proxy.mode !== 'custom') return null
    const port = proxyForm.port.trim()
    if (!port) return '请填写端口'
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return '端口应为 1-65535 的数字'
    return null
  })()
  const proxyEndpointReady = Boolean(proxyForm.host.trim()) && !proxyHostError && !proxyPortError

  const handleChoose = async (kind: 'output' | 'cache') => {
    const dir = await chooseDirectory(kind)
    if (!dir) return
    updateDraft(kind === 'output' ? { outputDir: dir } : { cacheDir: dir })
  }

  const handleCheckTools = async () => {
    setCheckingTools(true)
    try {
      await refreshInfo()
      toast('已重新检测工具状态', 'success')
    } finally {
      setCheckingTools(false)
    }
  }

  const handleTestProxy = async () => {
    setProxyTest(null)
    setProxyTestError(null)
    const candidate = normalizeProxySettings(draftRef.current.proxy)
    if (candidate.mode === 'custom') {
      const parsed = parseProxyUrl(candidate.url)
      if (!parsed.ok) {
        setProxyTestError(parsed.error)
        toast(parsed.error, 'warning')
        return
      }
    }
    const bridge = window.desktop
    if (!bridge || !bridge.proxy || typeof bridge.proxy.test !== 'function') {
      const message = '当前桌面桥接不支持代理测试，请更新或重新打包应用后重试'
      setProxyTestError(message)
      toast(message, 'error')
      return
    }
    setProxyTesting(true)
    try {
      const response = await bridge.proxy.test(candidate)
      if (response.ok) {
        setProxyTest(response.data)
        if (response.data.ok) toast('代理连接正常', 'success')
        else toast('代理连接失败，请查看检查结果', 'warning')
      } else {
        setProxyTestError(response.error || '代理测试失败')
        toast(response.error || '代理测试失败', 'error')
      }
    } catch (error) {
      const message = '代理测试失败：' + (error instanceof Error ? error.message : String(error))
      setProxyTestError(message)
      toast(message, 'error')
    } finally {
      setProxyTesting(false)
    }
  }

  const commitCacheSize = () => {
    const value = Number(cacheText)
    if (!Number.isFinite(value) || cacheText.trim() === '') {
      setCacheText(String(draftRef.current.maxCacheSizeMb))
      return
    }
    updateDraft({ maxCacheSizeMb: value })
    setCacheText(String(normalizeSettings({ ...draftRef.current, maxCacheSizeMb: value }).maxCacheSizeMb))
  }

  return (
    <div className="view settings-view" data-view="settings">
      <header className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">外观主题、外部工具、网络代理、便携数据目录与默认导出设置；保存后长期保留</p>
        </div>
        <div className="page-actions">
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void handleCheckTools()} disabled={!desktopAvailable || checkingTools}>
            {checkingTools ? '检测中…' : '重新检测工具'}
          </Button>
        </div>
      </header>

      {!desktopAvailable ? (
        <div className="notice is-warning">
          <Icon name="warning" size={16} />
          <div>当前运行环境没有桌面能力，设置无法读写；此页面用于界面预览。</div>
        </div>
      ) : null}
      {infoError ? (
        <div className="notice is-danger">
          <Icon name="error" size={16} />
          <div>{infoError}</div>
        </div>
      ) : null}
      {settingsError ? (
        <div className="notice is-danger" role="alert">
          <Icon name="error" size={16} />
          <div>
            <strong>设置保存失败：</strong>
            {settingsError}
          </div>
        </div>
      ) : null}

      <div className="settings-stack">
        <Panel
          title="外部工具"
          subtitle={tools ? `${readyCount}/3 可用${tools.ready ? '，可以开始转换' : '，请先补齐缺失工具'}` : '正在读取工具状态…'}
          actions={
            <span className={tools?.ready ? 'badge badge-success' : 'badge badge-warning'}>
              {tools?.ready ? '工具就绪' : '工具未就绪'}
            </span>
          }
        >
          {TOOL_INFO.map((item) => (
            <ToolRow key={item.key} name={item.key} purpose={item.purpose} tools={tools} />
          ))}
        </Panel>

        <Panel
          title="外观"
          subtitle="界面主题；选择后立即预览，保存后持久化，重启仍保留"
          actions={<span className="badge badge-accent">{themeModeLabel(draft.theme)}</span>}
        >
          <div className="theme-mode-row" role="radiogroup" aria-label="界面主题">
            {THEME_OPTIONS.map((option) => {
              const active = draft.theme === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={'theme-mode-' + option.value}
                  className={active ? 'theme-mode is-active' : 'theme-mode'}
                  onClick={() => {
                    updateDraft({ theme: option.value })
                    setThemePreview(option.value)
                  }}
                >
                  <span className="theme-mode-preview" data-theme-preview={option.value}>
                    <span className="theme-mode-preview-bar" />
                    <span className="theme-mode-preview-body" />
                  </span>
                  <span className="theme-mode-text">
                    <span className="theme-mode-title">
                      <Icon name={option.icon} size={14} />
                      {option.label}
                    </span>
                    <span className="theme-mode-desc">{option.desc}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="theme-note">
            <Icon name="info" size={13} />
            <span>「跟随系统」会随 Windows 的深浅色设置自动切换；切换只影响界面，不影响动图导出结果。</span>
          </div>
        </Panel>

        <Panel
          title="网络代理"
          subtitle="X 链接解析、视频/图片下载与界面缩略图都会经过该代理；保存后立即生效，无需重启"
          actions={<span className="badge badge-accent">{proxyModeLabel(draft.proxy.mode)}</span>}
        >
          <div className="proxy-mode-row" role="radiogroup" aria-label="代理模式">
            {PROXY_MODE_OPTIONS.map((option) => {
              const active = draft.proxy.mode === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={'proxy-mode-' + option.value}
                  className={active ? 'proxy-mode is-active' : 'proxy-mode'}
                  onClick={() => updateProxy({ mode: option.value })}
                >
                  <span className="proxy-mode-icon">
                    <Icon name={option.icon} size={16} />
                  </span>
                  <span className="proxy-mode-text">
                    <span className="proxy-mode-title">{option.label}</span>
                    <span className="proxy-mode-desc">{option.desc}</span>
                  </span>
                </button>
              )
            })}
          </div>

          {draft.proxy.mode === 'system' ? (
            <div className="proxy-hint">
              <Icon name="info" size={14} />
              <span>
                自动跟随 Windows「Internet 选项 → 连接 → 局域网设置」中的代理。代理软件（Clash / V2Ray / Shadowsocks 等）已开启「系统代理」时，选这个即可，无需填写地址。
              </span>
            </div>
          ) : null}
          {draft.proxy.mode === 'direct' ? (
            <div className="proxy-hint is-warning">
              <Icon name="warning" size={14} />
              <span>
                直连模式不经过任何代理。如果所在网络无法直接访问 X，推文解析与媒体下载会失败；仅建议在本机可直连或做网络排障对照时使用。
              </span>
            </div>
          ) : null}

          {draft.proxy.mode === 'custom' ? (
            <div className="proxy-custom">
              <div className="proxy-field-grid">
                <div className="proxy-endpoint-grid">
                  <Field label="协议">
                    <select
                      className="input"
                      data-testid="proxy-protocol-select"
                      value={proxyForm.protocol}
                      onChange={(event) => updateProxyForm({ protocol: event.target.value as ProxyProtocol })}
                    >
                      {PROXY_PROTOCOLS.map((protocol) => (
                        <option key={protocol} value={protocol}>
                          {proxyProtocolLabel(protocol)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="主机 / IP"
                    hint="例如 127.0.0.1 或 proxy.example.com；也支持粘贴完整地址"
                    error={proxyHostError ?? undefined}
                  >
                    <input
                      className="input mono"
                      type="text"
                      spellCheck={false}
                      placeholder="127.0.0.1"
                      value={proxyForm.host}
                      data-testid="proxy-host-input"
                      onChange={(event) => handleProxyHostChange(event.target.value)}
                    />
                  </Field>
                  <Field label="端口" hint="1-65535" error={proxyPortError ?? undefined}>
                    <input
                      className="input mono"
                      type="text"
                      inputMode="numeric"
                      spellCheck={false}
                      placeholder="7890"
                      value={proxyForm.port}
                      data-testid="proxy-port-input"
                      onChange={(event) => updateProxyForm({ port: event.target.value.replace(/[^\d]/g, '').slice(0, 5) })}
                    />
                  </Field>
                </div>
                {proxyEndpointReady ? (
                  <div className="proxy-endpoint-url">
                    <Icon name="link" size={12} />
                    <span className="mono">实际代理：{buildProxyFormUrl(proxyForm)}</span>
                  </div>
                ) : null}
                <Field
                  className="is-wide"
                  label="不走代理的主机"
                  hint="分号、逗号或空格分隔；localhost、127.0.0.1、<local> 始终直连"
                >
                  <input
                    className="input mono"
                    type="text"
                    spellCheck={false}
                    placeholder={DEFAULT_PROXY_BYPASS}
                    value={draft.proxy.bypass}
                    onChange={(event) => updateProxy({ bypass: event.target.value })}
                  />
                </Field>
                <Field label="用户名（可选）" hint="代理需要认证时填写">
                  <input
                    className="input"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={draft.proxy.username}
                    onChange={(event) => updateProxy({ username: event.target.value })}
                  />
                </Field>
                <Field label="密码（可选）" hint="仅保存在本机（加密存储）">
                  <div className="password-wrap">
                    <input
                      className="input password-input"
                      type={showProxyPassword ? 'text' : 'password'}
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.proxy.password}
                      aria-label="代理密码"
                      onChange={(event) => updateProxy({ password: event.target.value })}
                    />
                    <IconButton
                      icon={showProxyPassword ? 'eye-off' : 'eye'}
                      label={showProxyPassword ? '隐藏密码' : '显示密码'}
                      onClick={() => setShowProxyPassword((value) => !value)}
                    />
                  </div>
                </Field>
              </div>
              {!proxyForm.host.trim() ? (
                <div className="proxy-empty-hint">
                  <Icon name="info" size={13} />
                  <span>自定义模式需要填写代理主机与端口（例如 127.0.0.1 + 7890）；如果使用系统代理，请切换上方「系统代理」。</span>
                </div>
              ) : null}
              <div className="proxy-security-note">
                <Icon name="info" size={13} />
                <span>
                  代理密码由主进程使用 Windows 系统加密能力保存，设置文件中不落明文，也不会写入日志；换机器或换用户后需要重新填写。
                </span>
              </div>
            </div>
          ) : null}

          <div className="proxy-actions">
            <Button
              size="sm"
              variant="secondary"
              icon="bolt"
              data-testid="proxy-test-button"
              onClick={() => void handleTestProxy()}
              disabled={!desktopAvailable || proxyTesting || (draft.proxy.mode === 'custom' && !proxyEndpointReady)}
            >
              {proxyTesting ? (
                <>
                  <Spinner size={13} />
                  测试中…
                </>
              ) : (
                '测试连接'
              )}
            </Button>
            <span className="proxy-actions-note">
              <Icon name="info" size={13} />
              测试会临时应用当前填写的配置，结束后自动恢复已保存设置；每项检查最长约 15 秒，请耐心等待。
            </span>
          </div>

          {proxyTestError ? (
            <div className="proxy-inline-error" role="alert" data-testid="proxy-test-error">
              <Icon name="error" size={14} />
              <span>{proxyTestError}</span>
            </div>
          ) : null}

          {proxyTest ? <ProxyTestResultCard result={proxyTest} onClear={() => setProxyTest(null)} /> : null}
        </Panel>

        <Panel title="目录" subtitle="媒体与动图输出位置、便携数据目录与缓存；留空使用应用默认目录">
          <div className="dir-section">
            <div className="dir-block" data-testid="data-dir-row">
              <div className="dir-head">
                <div className="dir-heading">
                  <div className="settings-name">数据目录</div>
                  <div className="settings-desc">媒体、动图与历史记录保存在程序目录的数据文件夹（userdata），不占用 C 盘用户目录</div>
                </div>
                <div className="dir-actions">
                  <Button size="xs" variant="secondary" icon="folder" onClick={() => void openDataDir()} disabled={!desktopAvailable}>
                    打开数据目录
                  </Button>
                </div>
              </div>
              <div className="dir-path-wrap">
                <input
                  className="input dir-path-input mono"
                  type="text"
                  readOnly
                  value={info?.dataDir ? shortenPath(info.dataDir, 110) : '未读取到数据目录'}
                  title={info?.dataDir ?? '未读取到数据目录'}
                  data-testid="data-dir-path"
                  aria-label="数据目录"
                />
                <span className="badge badge-success">便携</span>
              </div>
            </div>

            <div className="dir-block" data-testid="output-dir-row">
              <div className="dir-head">
                <div className="dir-heading">
                  <div className="settings-name">输出目录</div>
                  <div className="settings-desc">保存的媒体与动图默认保存到这里</div>
                </div>
                <div className="dir-actions">
                  <Button size="xs" variant="secondary" icon="folder" onClick={() => void handleChoose('output')} disabled={!desktopAvailable}>
                    选择目录
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => updateDraft({ outputDir: null })} disabled={!draft.outputDir}>
                    恢复默认
                  </Button>
                  <Button size="xs" variant="ghost" icon="external" onClick={() => void openOutputDir()} disabled={!desktopAvailable}>
                    打开
                  </Button>
                </div>
              </div>
              <div className="dir-path-wrap">
                <input
                  className="input dir-path-input mono"
                  type="text"
                  readOnly
                  value={outputPath ? shortenPath(outputPath, 110) : '未设置'}
                  title={outputPath ?? '未设置'}
                  data-testid="output-dir-path"
                  aria-label="输出目录"
                />
                {draft.outputDir ? <span className="badge badge-accent">自定义</span> : <span className="badge">默认</span>}
              </div>
            </div>

            <div className="dir-block" data-testid="cache-dir-row">
              <div className="dir-head">
                <div className="dir-heading">
                  <div className="settings-name">缓存目录</div>
                  <div className="settings-desc">原始视频、缩略图与抽帧临时文件</div>
                </div>
                <div className="dir-actions">
                  <Button size="xs" variant="secondary" icon="folder" onClick={() => void handleChoose('cache')} disabled={!desktopAvailable}>
                    选择目录
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => updateDraft({ cacheDir: null })} disabled={!draft.cacheDir}>
                    恢复默认
                  </Button>
                  <Button size="xs" variant="ghost" icon="external" onClick={() => void openCacheDir()} disabled={!desktopAvailable}>
                    打开
                  </Button>
                </div>
              </div>
              <div className="dir-path-wrap">
                <input
                  className="input dir-path-input mono"
                  type="text"
                  readOnly
                  value={cachePath ? shortenPath(cachePath, 110) : '未设置'}
                  title={cachePath ?? '未设置'}
                  data-testid="cache-dir-path"
                  aria-label="缓存目录"
                />
                {draft.cacheDir ? <span className="badge badge-accent">自定义</span> : <span className="badge">默认</span>}
              </div>
            </div>

            <div className="settings-field-row">
              <div className="settings-label">
                <div className="settings-name">保留原始视频缓存</div>
                <div className="settings-desc">关闭后转换完成会尽量清理已下载的源视频，节省磁盘空间</div>
              </div>
              <div className="settings-field-control">
                <Switch
                  checked={draft.keepOriginalMp4}
                  onChange={(value) => updateDraft({ keepOriginalMp4: value })}
                  label={draft.keepOriginalMp4 ? '保留' : '不保留'}
                />
              </div>
            </div>

            <div className="settings-field-row">
              <div className="settings-label">
                <div className="settings-name">缓存上限</div>
                <div className="settings-desc">
                  超过上限时清理最旧的媒体缓存（{MAX_CACHE_SIZE_MIN_MB}–{MAX_CACHE_SIZE_MAX_MB} MB）
                </div>
              </div>
              <div className="settings-field-control cache-control">
                <input
                  className="input cache-input"
                  type="number"
                  min={MAX_CACHE_SIZE_MIN_MB}
                  max={MAX_CACHE_SIZE_MAX_MB}
                  step={64}
                  value={cacheText}
                  onChange={(event) => setCacheText(event.target.value)}
                  onBlur={commitCacheSize}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitCacheSize()
                  }}
                  disabled={!desktopAvailable}
                  aria-label="缓存上限 MB"
                />
                <span className="cache-unit">MB</span>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="默认导出设置" subtitle="新建导出任务时沿用这里的设置">
          <ParamPanel
            params={draft.defaultParams}
            presetId={detectPresetId(draft.defaultParams)}
            onChange={(params, preset) =>
              updateDraft({ defaultParams: params, ...(preset ? { defaultPresetId: preset } : {}) })
            }
          />
        </Panel>

        <Panel title="关于">
          <div className="about-block">
            <div className="about-logo">
              <Icon name="bolt" size={24} />
            </div>
            <div>
              <div className="about-name">{info?.name ?? 'X 媒体工坊'}</div>
              <div className="about-desc">解析 X 推文媒体，保存原始文件，或导出 GIF / WebP 动图的 Windows 桌面工具</div>
              <div className="about-meta">
                <span>版本 {info?.version ?? '—'}</span>
                <span>·</span>
                <span>{desktopAvailable ? (info?.isPackaged ? '安装/便携版' : '开发模式') : '浏览器预览'}</span>
                {info?.dataDir ? (
                  <>
                    <span>·</span>
                    <span className="mono" title={info.dataDir}>
                      数据目录：{info.dataDir}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="about-actions">
              <Button
                size="sm"
                variant="ghost"
                icon="monitor"
                onClick={() => void window.desktop?.app.toggleDevTools().catch(() => undefined)}
                disabled={!desktopAvailable}
              >
                开发者工具
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <div className="settings-savebar">
        <div className={dirty ? 'savebar-status is-dirty' : 'savebar-status'}>
          <Icon name={dirty ? 'info' : 'success'} size={14} />
          {dirty ? '有未保存的修改' : '设置已同步'}
        </div>
        <div className="savebar-actions">
          <Button size="sm" variant="ghost" onClick={handleReset} disabled={!dirty || saving}>
            放弃修改
          </Button>
          <Button size="sm" variant="primary" icon="save" onClick={() => void handleSave()} disabled={!dirty || saving || !desktopAvailable}>
            {saving ? (
              <>
                <Spinner size={13} />
                保存中…
              </>
            ) : (
              '保存设置'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}