import React from 'react'
import { AppProvider, useApp } from './state/store'
import { Icon, ToastProvider } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import ParseView from './views/ParseView'
import HistoryView from './views/HistoryView'
import SettingsView from './views/SettingsView'

function LoadingSplash() {
  return (
    <div className="loading-splash">
      <div className="loading-logo">
        <Icon name="bolt" size={26} />
      </div>
      <div className="loading-title">X 媒体工坊</div>
      <div className="loading-desc">正在读取桌面信息…</div>
      <span className="spinner" style={{ width: 18, height: 18, marginTop: 14 }} />
    </div>
  )
}

function Shell() {
  const { ready, view, desktopAvailable } = useApp()

  if (!ready) return <LoadingSplash />

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="main">
          {!desktopAvailable ? (
            <div className="global-banner" role="status">
              <Icon name="warning" size={14} />
              浏览器预览模式：桌面能力（window.desktop）未注入，解析/转换/历史/设置不可用。
            </div>
          ) : null}
          <div className="main-inner">
            <ErrorBoundary key={view}>
              {view === 'parse' ? <ParseView /> : null}
              {view === 'history' ? <HistoryView /> : null}
              {view === 'settings' ? <SettingsView /> : null}
            </ErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  )
}

export function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </ToastProvider>
  )
}

export default App