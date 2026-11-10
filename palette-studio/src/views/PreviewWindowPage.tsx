import React, { useEffect, useMemo, useState } from 'react'
import type { PreviewDevice, PreviewPayload } from '../shared/types'
import { Icon, Segmented } from '../components/ui'
import { ContrastBadge, ModeToggle } from '../components/color-ui'
import { PreviewLegend, ThemePreview, getPreviewColors } from '../components/ThemePreview'

/** 设备切换选项 */
const DEVICE_OPTIONS: Array<{ value: PreviewDevice; label: string; icon: 'monitor' | 'smartphone' }> = [
  { value: 'desktop', label: '桌面端', icon: 'monitor' },
  { value: 'mobile', label: '手机端', icon: 'smartphone' },
]

/**
 * 独立预览窗口页面（由 main 进程以 ?view=preview 打开）。
 * 不挂载主应用的 AppProvider：数据完全来自主窗口通过 IPC 推送的 PreviewPayload，
 * 主题、明暗模式、设备形态都会实时同步；在预览窗口里切换模式/设备也会回传给主窗口。
 */
export default function PreviewWindowPage() {
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [bridgeReady, setBridgeReady] = useState(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const bridge = window.desktop?.preview
    if (!bridge) return
    setBridgeReady(true)
    let alive = true
    void bridge.getState().then((state) => {
      if (!alive) return
      if (state) {
        setPayload(state)
        setConnected(true)
      }
    })
    const offState = bridge.onState((state) => {
      if (!alive) return
      setPayload(state)
      setConnected(true)
    })
    return () => {
      alive = false
      offState?.()
    }
  }, [])

  // 窗口自身跟随主应用界面主题（深/浅）
  useEffect(() => {
    document.documentElement.dataset.appTheme = payload?.appTheme ?? 'dark'
  }, [payload?.appTheme])

  const project = payload?.project ?? null
  const theme = project?.theme ?? null
  const mode = payload?.mode ?? 'light'
  const device = payload?.device ?? 'desktop'
  const previewColors = useMemo(() => getPreviewColors(theme, mode), [theme, mode])

  return (
    <div className="preview-window" data-view="preview">
      <header className="preview-window-head">
        <div className="preview-window-brand">
          <span className="brand-mark">
            <Icon name="palette" size={15} />
          </span>
          <div className="preview-window-titles">
            <strong>界面预览</strong>
            <span>{project ? `${project.name} · 实时同步自主窗口` : '等待主窗口同步…'}</span>
          </div>
        </div>

        <span className="preview-window-sync">
          <Icon name={connected ? 'success' : 'refresh'} size={12} />
          {connected ? '实时同步' : bridgeReady ? '等待同步' : '桌面版专用'}
        </span>

        <div className="preview-window-controls">
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
            onChange={(next) => window.desktop?.preview.setDevice(next)}
            options={DEVICE_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
              icon: item.icon,
            }))}
          />
          <ModeToggle size="sm" value={mode} onChange={(next) => window.desktop?.preview.setMode(next)} />
        </div>
      </header>

      <main className="preview-window-body">
        {project && theme ? (
          <>
            <div className="preview-window-stage">
              <ThemePreview project={project} mode={mode} device={device} />
            </div>
            <PreviewLegend project={project} mode={mode} />
          </>
        ) : (
          <div className="preview-window-empty">
            {bridgeReady ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="monitor" size={26} />
                </div>
                <h3 className="empty-title">等待主窗口同步</h3>
                <p className="empty-desc">
                  在「配色工坊」的项目工作台 → 主题页生成语义主题后，这里会实时显示界面预览。
                </p>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <Icon name="warning" size={26} />
                </div>
                <h3 className="empty-title">独立预览窗口仅在桌面版可用</h3>
                <p className="empty-desc">请通过「配色工坊」桌面应用右上角的「独立窗口」按钮打开预览。</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
