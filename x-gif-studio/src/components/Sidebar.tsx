import React, { useState } from 'react'
import { Icon, type IconName } from './ui'
import { useApp } from '../state/store'
import type { AppView } from '../state/store'
import { SidebarTasks } from './SidebarTasks'

interface NavItem {
  view: AppView
  label: string
  description: string
  icon: IconName
}

const NAV_ITEMS: NavItem[] = [
  { view: 'parse', label: '解析推文', description: '解析 → 保存 / 导出动图', icon: 'parse' },
  { view: 'history', label: '历史记录', description: '按推文查看媒体与动图', icon: 'history' },
  { view: 'settings', label: '设置', description: '外观、工具与目录', icon: 'settings' },
]

export function Sidebar() {
  const { view, setView, history, info, desktopAvailable, openOutputDir, startNewParse, showParseResult, tweet, parseScreen } = useApp()
  const tools = info?.tools ?? null
  // 历史数量按「推文链接」统计（去重后的推文条数），不按 GIF 结果个数
  const historyCount = new Set(history.map((entry) => entry.id)).size
  // 「X 上的 GIF 实际是 MP4」提示：只提示一次，关闭后持久记住（便携数据目录内的 localStorage）
  const [tipDismissed, setTipDismissed] = useState(() => {
    try {
      return window.localStorage.getItem('xmediastudio:sidebar-tip-dismissed') === '1'
    } catch {
      return false
    }
  })
  const dismissTip = () => {
    setTipDismissed(true)
    try {
      window.localStorage.setItem('xmediastudio:sidebar-tip-dismissed', '1')
    } catch {
      /* localStorage 不可用时仅本次隐藏 */
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <span className="sidebar-section-title">工作台</span>
      </div>

      <nav className="sidebar-nav">
        <button
          type="button"
          data-nav="new-parse"
          className={view === 'parse' && parseScreen === 'home' ? 'sidebar-item is-active' : 'sidebar-item'}
          data-testid="sidebar-new-parse"
          title="回到解析页，粘贴 X 链接开始解析"
          onClick={() => {
            startNewParse()
            setView('parse')
          }}
        >
          <span className="sidebar-item-icon">
            <Icon name="plus" size={17} />
          </span>
          <span className="sidebar-item-text">
            <span className="sidebar-item-label">解析</span>
            <span className="sidebar-item-desc">粘贴 X 链接开始解析</span>
          </span>
          {view === 'parse' && parseScreen === 'home' ? <span className="sidebar-item-active-bar" /> : null}
        </button>
        <button
          type="button"
          data-nav="parse-result"
          className={
            (view === 'parse' && parseScreen === 'result' ? 'sidebar-item is-active' : 'sidebar-item') +
            (tweet ? '' : ' is-disabled')
          }
          data-testid="sidebar-parse-result"
          disabled={!tweet}
          title={tweet ? '查看当前解析结果' : '还没有解析结果，先粘贴 X 链接'}
          onClick={() => {
            if (!tweet) return
            showParseResult()
            setView('parse')
          }}
        >
          <span className="sidebar-item-icon">
            <Icon name="parse" size={17} />
          </span>
          <span className="sidebar-item-text">
            <span className="sidebar-item-label">结果</span>
            <span className="sidebar-item-desc">{tweet ? '查看当前解析结果' : '暂无解析结果'}</span>
          </span>
          {view === 'parse' && parseScreen === 'result' ? <span className="sidebar-item-active-bar" /> : null}
        </button>
        {NAV_ITEMS.filter((item) => item.view !== 'parse').map((item) => (
          <button
            key={item.view}
            type="button"
            data-nav={item.view}
            className={view === item.view ? 'sidebar-item is-active' : 'sidebar-item'}
            onClick={() => setView(item.view)}
          >
            <span className="sidebar-item-icon">
              <Icon name={item.icon} size={17} />
            </span>
            <span className="sidebar-item-text">
              <span className="sidebar-item-label">{item.label}</span>
              <span className="sidebar-item-desc">{item.description}</span>
            </span>
            {item.view === 'history' && historyCount > 0 ? (
              <span className="sidebar-item-badge" title={`${historyCount} 条推文`}>
                {historyCount}
              </span>
            ) : null}
            {view === item.view ? <span className="sidebar-item-active-bar" /> : null}
          </button>
        ))}
      </nav>


      {tipDismissed ? null : (
        <div className="sidebar-tip">
          <Icon name="sparkles" size={14} />
          <p>X 上的动图实际是视频文件：推荐先保存原始文件；需要分享时再导出动图（GIF / WebP），按逐帧时间戳还原，不抽帧。</p>
          <button
            type="button"
            className="sidebar-tip-close"
            aria-label="不再提示"
            title="不再提示"
            data-testid="sidebar-tip-close"
            onClick={dismissTip}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <SidebarTasks />

      <div className="sidebar-footer">
        <div className="sidebar-tool-status">
          <span className="sidebar-tool-title">外部工具</span>
          {(['ffmpeg', 'gifski', 'gifsicle'] as const).map((name) => {
            const value = tools ? tools[name] : null
            const tone = tools ? (value ? 'is-ok' : 'is-missing') : 'is-unknown'
            return (
              <div key={name} className="sidebar-tool-row">
                <span className={`tool-dot ${tone}`} />
                <span className="sidebar-tool-name mono">{name}</span>
                <span className="sidebar-tool-version">
                  {!desktopAvailable ? '未检测' : tools ? (value ? tools[`${name}Version`] ?? '可用' : '缺失') : '检测中…'}
                </span>
              </div>
            )
          })}
        </div>

        <button
          type="button"
          className="sidebar-foot-btn"
          onClick={() => void openOutputDir()}
          disabled={!desktopAvailable}
          title={desktopAvailable ? '在资源管理器中打开动图输出目录' : '桌面环境不可用'}
        >
          <Icon name="folder" size={15} />
          <span>打开输出目录</span>
        </button>

        <div className="sidebar-foot-meta">
          <span>{desktopAvailable ? '桌面版' : '浏览器预览'}</span>
          {info?.version ? <span className="mono">v{info.version}</span> : null}
        </div>
      </div>
    </aside>
  )
}