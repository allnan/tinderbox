import React from 'react'
import { Icon } from './ui'
import { useApp } from '../state/store'

/** 自绘标题栏：品牌、工具状态徽标、窗口控制按钮（-webkit-app-region 拖拽由 CSS 控制） */
export function TitleBar() {
  const { info, infoError, desktopAvailable, setView, view, effectiveTheme, toggleTheme } = useApp()
  const [maximized, setMaximized] = React.useState(false)

  React.useEffect(() => {
    if (!window.desktop) return
    void window.desktop.window.isMaximized().then(setMaximized).catch(() => undefined)
    return window.desktop.window.onMaximizedChange(setMaximized)
  }, [])

  const tools = info?.tools ?? null
  const toolsReady = Boolean(tools?.ready)
  const missing = tools?.missing ?? []

  return (
    <header
      className="titlebar"
      onDoubleClick={() => {
        if (window.desktop) void window.desktop.window.toggleMaximize().catch(() => undefined)
      }}
    >
      <div className="titlebar-brand">
        <span className="brand-mark">
          <Icon name="bolt" size={16} />
        </span>
        <div className="brand-text">
          <div className="brand-name">X 媒体工坊</div>
          <div className="brand-sub">解析 X 推文媒体 · 保存原文件 / 导出动图</div>
        </div>
      </div>

      <div className="titlebar-divider" />

      <div className="titlebar-badges">
        {!desktopAvailable ? (
          <span className="tool-badge is-bad" title="当前不在桌面环境中运行">
            <Icon name="warning" size={12} />
            浏览器预览模式
          </span>
        ) : toolsReady ? (
          <button
            type="button"
            className="tool-badge is-ok"
            title="ffmpeg / gifski / gifsicle 均可用"
            onClick={() => setView('settings')}
          >
            <Icon name="success" size={12} />
            工具就绪
          </button>
        ) : (
          <button
            type="button"
            className="tool-badge is-bad"
            title={infoError || (missing.length ? '缺少：' + missing.join('、') : '工具状态异常')}
            onClick={() => setView('settings')}
          >
            <Icon name="warning" size={12} />
            {missing.length ? `缺少 ${missing.length} 个工具` : '工具状态异常'}
          </button>
        )}
        {info?.version ? <span className="titlebar-version mono">v{info.version}</span> : null}
      </div>

      <div className="titlebar-spacer" />

      {view === 'settings' ? null : (
        <>
          <button
            type="button"
            className="titlebar-link titlebar-theme-toggle"
            data-testid="theme-toggle"
            title={effectiveTheme === 'dark' ? '切换浅色主题' : '切换深色主题'}
            aria-label={effectiveTheme === 'dark' ? '切换浅色主题' : '切换深色主题'}
            onClick={() => void toggleTheme()}
          >
            <Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} size={14} />
            {effectiveTheme === 'dark' ? '浅色' : '深色'}
          </button>
          <button type="button" className="titlebar-link" onClick={() => setView('settings')}>
            <Icon name="settings" size={13} />
            设置
          </button>
        </>
      )}

      {desktopAvailable ? (
        <div className="window-controls">
          <button
            type="button"
            className="window-btn"
            title="最小化"
            onClick={() => window.desktop?.window.minimize().catch(() => undefined)}
          >
            <Icon name="minimize" size={15} />
          </button>
          <button
            type="button"
            className="window-btn"
            title={maximized ? '还原' : '最大化'}
            onClick={() => {
              void window.desktop?.window.toggleMaximize().then(setMaximized).catch(() => undefined)
            }}
          >
            <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
          </button>
          <button
            type="button"
            className="window-btn is-close"
            title="关闭"
            onClick={() => window.desktop?.window.close().catch(() => undefined)}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ) : null}
    </header>
  )
}