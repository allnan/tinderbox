import React, { useEffect, useMemo, useState } from 'react'
import type { PreviewDevice, ThemeMethodId, ThemeToken } from '../shared/types'
import { THEME_METHODS, generateSemanticTheme } from '../core/palette'
import { bestTextOn } from '../core/color'
import { useApp } from '../state/store'
import { Badge, Button, EmptyState, Icon, Panel, Segmented, cx, relativeTime, useToast } from '../components/ui'
import { ColorDot, ContrastBadge, ModeToggle, ScaleStrip, useColorCopy } from '../components/color-ui'
import { PreviewLegend, ThemePreview, getPreviewColors } from '../components/ThemePreview'
import type { ProjectViewProps } from './types'

/**
 * 语义 token 分组：18 个 token 分成 3 组、每组 6 个，
 * 在宽屏下正好排满一行，信息密度均匀且便于对照。
 */
const TOKEN_GROUPS: Array<{ title: string; hint: string; keys: string[] }> = [
  {
    title: '品牌色',
    hint: '主色及其交互状态、辅助色与强调色',
    keys: ['primary', 'primary-hover', 'primary-active', 'on-primary', 'secondary', 'accent'],
  },
  {
    title: '基础界面',
    hint: '页面背景、表面与三级文字颜色',
    keys: ['background', 'surface', 'surface-raised', 'text-primary', 'text-secondary', 'text-disabled'],
  },
  {
    title: '边框与状态',
    hint: '分割线边框与语义化的反馈颜色',
    keys: ['border', 'border-strong', 'success', 'warning', 'error', 'info'],
  },
]

/** 预览设备切换选项 */
const DEVICE_OPTIONS: Array<{ value: PreviewDevice; label: string; icon: 'monitor' | 'smartphone' }> = [
  { value: 'desktop', label: '桌面端', icon: 'monitor' },
  { value: 'mobile', label: '手机端', icon: 'smartphone' },
]

/**
 * 主题视图：5 种生成方式 → 18 个语义 token（浅/深）→ 8 组色阶 → 界面预览（桌面/手机）。
 * 预览支持内嵌、右侧放大抽屉以及独立窗口三种方式，颜色与设备形态实时同步。
 */
export default function ThemeView({ project, mode }: ProjectViewProps) {
  const { data, actions } = useApp()
  const { toast } = useToast()
  const copy = useColorCopy()

  const theme = project.theme
  const [method, setMethod] = useState<ThemeMethodId>(theme?.method ?? 'balanced')

  // 主题被重新生成（或在别处切换方式）后，让选择器跟随最新的主题元信息
  useEffect(() => {
    if (project.theme) setMethod(project.theme.method)
  }, [project.theme])

  /** token 字典：key → ThemeToken，避免渲染时反复 find */
  const tokenMap = useMemo(() => {
    const map: Record<string, ThemeToken> = {}
    for (const token of theme?.tokens ?? []) map[token.key] = token
    return map
  }, [theme])

  const tokenGroups = useMemo(
    () =>
      TOKEN_GROUPS.map((group) => ({
        ...group,
        tokens: group.keys
          .map((key) => tokenMap[key])
          .filter((token): token is ThemeToken => Boolean(token)),
      })),
    [tokenMap],
  )

  const methodMeta = THEME_METHODS.find((item) => item.id === method) ?? THEME_METHODS[0]
  const currentMethodMeta = theme ? THEME_METHODS.find((item) => item.id === theme.method) : null
  const baseColor = theme?.baseColor ?? project.baseColor
  /** 主题生成后主色又被修改：提示重新生成，避免主题与主色不一致 */
  const drift = Boolean(theme && theme.baseColor !== project.baseColor)

  const generateTheme = () => {
    if (data.settings.autoSnapshot) actions.createSnapshot(project.id, '重新生成主题前')
    const next = generateSemanticTheme(project.baseColor, method)
    actions.setTheme(project.id, next)
    toast(
      `已生成「${methodMeta.label}」主题：${next.tokens.length} 个语义色 / ${next.scales.length} 组色阶`,
      'success',
    )
  }

  const changeMode = (next: 'light' | 'dark') => actions.updateSettings({ previewMode: next })

  // ---- 界面预览：明暗模式与设备形态持久化在设置中，放大面板由 App 外壳统一渲染 ----
  const device = data.settings.previewDevice
  const previewColors = useMemo(() => getPreviewColors(theme, mode), [theme, mode])

  const changeDevice = (next: PreviewDevice) => actions.updateSettings({ previewDevice: next })

  /** 打开右侧停靠预览面板（由 App 监听事件后渲染，避免遮住主界面） */
  const openPreviewDrawer = () => {
    window.dispatchEvent(new CustomEvent('app:open-preview-drawer'))
  }

  /** 打开独立预览窗口（Electron 专用；浏览器预览时降级提示） */
  const openPreviewWindow = async () => {
    if (!window.desktop?.preview) {
      toast('独立预览窗口仅在桌面版可用', 'warning')
      return
    }
    await window.desktop.preview.open()
  }

  return (
    <div className="theme-view fade-in">


      {/* ================= 主题概览 + 生成方式 ================= */}
      <Panel
        title="语义主题"
        subtitle="选择一个生成方式，从主色派生 18 个语义色 token（浅色 / 深色）与 8 组色阶"
        actions={
          <Badge tone={theme ? (drift ? 'warning' : 'success') : 'default'}>
            <Icon name={theme ? (drift ? 'warning' : 'success') : 'layers'} size={11} />
            {theme ? (drift ? '主色已变更' : '主题已生成') : '未生成主题'}
          </Badge>
        }
      >
        <div className="theme-overview">
          <div className="theme-overview-head">
            <div className="theme-overview-main">
              <button
                type="button"
                className="theme-overview-swatch"
                style={{ background: baseColor }}
                title={`点击复制 ${baseColor}`}
                onClick={() => void copy(baseColor)}
              >
                <span className="theme-overview-swatch-icon" style={{ color: bestTextOn(baseColor) }}>
                  <Icon name="layers" size={18} />
                </span>
              </button>
              <div className="theme-overview-info">
                <div className="theme-overview-label">
                  {theme ? '当前主题主色' : '项目主色（尚未生成主题）'}
                </div>
                <div className="theme-overview-hex-row">
                  <button
                    type="button"
                    className="theme-overview-hex mono"
                    title="点击复制主题主色"
                    onClick={() => void copy(baseColor)}
                  >
                    {baseColor}
                  </button>
                  {currentMethodMeta ? (
                    <Badge tone="accent">
                      <Icon name="sparkles" size={11} /> {currentMethodMeta.label}
                    </Badge>
                  ) : null}
                  {drift ? (
                    <Badge tone="warning">
                      <Icon name="warning" size={11} /> 与当前主色不一致
                    </Badge>
                  ) : null}
                </div>
                <div className="theme-overview-meta">
                  {theme ? (
                    <>
                      <span>
                        <Icon name="layers" size={12} /> {theme.tokens.length} 个 token
                      </span>
                      <span>
                        <Icon name="grid" size={12} /> {theme.scales.length} 组色阶
                      </span>
                      <span>
                        <Icon name="clock" size={12} /> {relativeTime(theme.createdAt)}生成
                      </span>
                    </>
                  ) : (
                    <span>选择生成方式后，点击右侧按钮即可获得完整的浅色 / 深色主题。</span>
                  )}
                </div>
              </div>
            </div>
            <div className="theme-overview-action">
              <Button variant="primary" icon="sparkles" onClick={generateTheme}>
                根据主色生成主题
              </Button>
              <span className="theme-overview-action-hint">当前方式：{methodMeta.label}</span>
            </div>
          </div>

          <div className="theme-method-grid">
            {THEME_METHODS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cx('theme-method-card', item.id === method && 'is-selected')}
                onClick={() => setMethod(item.id)}
              >
                <span className="theme-method-head">
                  <span className="theme-method-radio" aria-hidden="true" />
                  <span className="theme-method-name">{item.label}</span>
                  {theme?.method === item.id ? <span className="theme-method-applied">已应用</span> : null}
                </span>
                <span className="theme-method-desc">{item.description}</span>
              </button>
            ))}
          </div>

          <p className="theme-generate-hint">
            <Icon name="info" size={12} /> 将使用「{methodMeta.label}」方式：{methodMeta.description}
            。生成后会同步刷新控件配色的默认绑定。
          </p>

          {drift ? (
            <div className="theme-drift">
              <Icon name="warning" size={14} />
              <span>
                当前主题基于 {theme?.baseColor ?? '—'} 生成，而项目主色已改为 {project.baseColor}
                ，建议重新生成主题以保持一致。
              </span>
            </div>
          ) : null}
        </div>
      </Panel>

      {theme ? (
        <>
      {/* ================= 界面预览（内嵌 / 右侧停靠放大 / 独立窗口） ================= */}
      <Panel
        title="界面预览"
        subtitle="用当前主题渲染的迷你前端界面，直观检查颜色层级与可读性；可放大预览或在新窗口中实时对照"
        actions={
          <>
            <span className="theme-preview-contrast">
              <span className="theme-preview-contrast-label">正文</span>
              <ContrastBadge fg={previewColors.text} bg={previewColors.background} />
            </span>
            <span className="theme-preview-contrast">
              <span className="theme-preview-contrast-label">主按钮</span>
              <ContrastBadge fg={previewColors.onPrimary} bg={previewColors.primary} />
            </span>
            <Segmented<PreviewDevice>
              size="sm"
              value={device}
              onChange={changeDevice}
              options={DEVICE_OPTIONS.map((item) => ({
                value: item.value,
                label: item.label,
                icon: item.icon,
              }))}
            />
            <ModeToggle size="sm" value={mode} onChange={changeMode} />
            <Button size="sm" variant="primary" icon="maximize" onClick={openPreviewDrawer}>
              放大预览
            </Button>
            <Button size="sm" icon="external" onClick={() => void openPreviewWindow()}>
              独立窗口
            </Button>
          </>
        }
      >
        <div className={cx('theme-preview-stage', device === 'mobile' && 'is-mobile-stage')}>
          <ThemePreview project={project} mode={mode} device={device} />
        </div>
        <PreviewLegend project={project} mode={mode} />
      </Panel>

          {/* ================= 语义 token 网格 ================= */}
          <Panel
            title="语义色 Token"
            subtitle="浅色 / 深色两套值，当前预览模式高亮；点击任一色块复制"
            actions={<ModeToggle size="sm" value={mode} onChange={changeMode} />}
          >
            <div className="theme-token-groups">
              {tokenGroups.map((group) => (
                <section key={group.title} className="theme-token-group">
                  <header className="theme-token-group-head">
                    <span className="theme-token-group-title">{group.title}</span>
                    <span className="theme-token-group-hint">{group.hint}</span>
                    <span className="theme-token-group-count mono">{group.tokens.length}</span>
                  </header>
                  <div className="theme-token-grid">
                    {group.tokens.map((token) => (
                      <article key={token.key} className="theme-token-card">
                        <div className="theme-token-swatches">
                          <button
                            type="button"
                            className={cx('theme-token-swatch', mode === 'light' && 'is-active')}
                            style={{ background: token.light, color: bestTextOn(token.light) }}
                            title={`浅色 ${token.light}（点击复制）`}
                            onClick={() => void copy(token.light)}
                          >
                            <span className="theme-token-mode">
                              <Icon name="sun" size={10} /> 浅色
                            </span>
                            <span className="mono theme-token-value">{token.light}</span>
                          </button>
                          <button
                            type="button"
                            className={cx('theme-token-swatch', mode === 'dark' && 'is-active')}
                            style={{ background: token.dark, color: bestTextOn(token.dark) }}
                            title={`深色 ${token.dark}（点击复制）`}
                            onClick={() => void copy(token.dark)}
                          >
                            <span className="theme-token-mode">
                              <Icon name="moon" size={10} /> 深色
                            </span>
                            <span className="mono theme-token-value">{token.dark}</span>
                          </button>
                        </div>
                        <div className="theme-token-meta">
                          <span className="theme-token-label">{token.label}</span>
                          <span className="mono theme-token-key" title={token.description}>
                            {token.key}
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </Panel>

          {/* ================= 8 组色阶 ================= */}
          <Panel
            title="色阶体系"
            subtitle={`${theme.scales.length} 组色阶 · 每组 50–950，跟随${mode === 'dark' ? '深色' : '浅色'}模式，点击色块复制`}
            actions={
              <Badge tone={mode === 'dark' ? 'info' : 'default'}>
                <Icon name={mode === 'dark' ? 'moon' : 'sun'} size={11} />
                {mode === 'dark' ? '深色色阶' : '浅色色阶'}
              </Badge>
            }
          >
            <div className="theme-scale-list">
              {theme.scales.map((scale) => {
                const scaleColors = mode === 'dark' ? scale.dark : scale.light
                const baseHex = scaleColors['500'] ?? Object.values(scaleColors)[0] ?? '#808080'
                return (
                  <div key={scale.key} className="theme-scale-row">
                    <div className="theme-scale-head">
                      <ColorDot hex={baseHex} size={14} radius={4} border />
                      <span className="theme-scale-label">{scale.label}</span>
                      <span className="mono theme-scale-key">{scale.key}</span>
                    </div>
                    <ScaleStrip
                      light={scale.light}
                      dark={scale.dark}
                      mode={mode}
                      onCopy={(hex) => void copy(hex)}
                    />
                  </div>
                )
              })}
            </div>
          </Panel>

        </>
      ) : (
        <Panel>
          <EmptyState
            icon="layers"
            title="还没有生成语义主题"
            description="选择一种生成方式后，会基于项目主色生成 18 个语义色 token（浅色 / 深色）与 8 组色阶，并用它们渲染界面预览。"
            action={
              <Button variant="primary" icon="sparkles" onClick={generateTheme}>
                根据主色生成主题
              </Button>
            }
          />
        </Panel>
      )}
    </div>
  )
}
