import React, { useEffect, useState } from 'react'
import type { AppData } from '../shared/types'
import { useApp } from '../state/store'
import { createDemoProject, normalizeAppData } from '../shared/defaults'
import {
  Button,
  ConfirmDialog,
  Field,
  Icon,
  Panel,
  Segmented,
  Switch,
  formatTime,
  useToast,
} from '../components/ui'
import { ModeToggle } from '../components/color-ui'

interface AppInfo {
  version: string
  name: string
  dataPath: string
  platform: string
  isDev: boolean
}

export default function SettingsView() {
  const { data, actions, saveStatus } = useApp()
  const { toast } = useToast()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [pendingImport, setPendingImport] = useState<AppData | null>(null)

  useEffect(() => {
    void window.desktop?.getAppInfo().then(setInfo)
  }, [])

  const exportAll = async () => {
    const content = JSON.stringify(data, null, 2)
    if (window.desktop) {
      const result = await window.desktop.saveFile({
        content,
        defaultPath: 'palette-studio-backup.json',
        filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      })
      if (!result.canceled) toast('已导出全部数据', 'success')
      return
    }
    const blob = new Blob([content], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'palette-studio-backup.json'
    anchor.click()
    URL.revokeObjectURL(url)
    toast('已导出全部数据', 'success')
  }

  const importAll = async () => {
    if (window.desktop) {
      const result = await window.desktop.openFile({
        filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      })
      if (result.canceled || !result.content) return
      try {
        setPendingImport(normalizeAppData(JSON.parse(result.content)))
      } catch {
        toast('文件格式不正确，无法导入', 'error')
      }
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        setPendingImport(normalizeAppData(JSON.parse(await file.text())))
      } catch {
        toast('文件格式不正确，无法导入', 'error')
      }
    }
    input.click()
  }

  return (
    <div className="page-enter">
      <div className="main-inner" style={{ maxWidth: 980 }}>
        <div className="page-header">
          <div>
            <h1 className="page-title">设置</h1>
            <p className="page-subtitle">应用外观、颜色格式与本地数据管理。</p>
          </div>
        </div>

        <div className="settings-stack">
          <Panel title="外观与偏好" subtitle="调整界面主题、颜色复制格式与默认预览模式">
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-label">
                  <div className="settings-name">应用主题</div>
                  <div className="settings-desc">深色更适合长时间调色，浅色适合明亮环境。</div>
                </div>
                <Segmented
                  value={data.settings.theme}
                  onChange={(theme) => actions.updateSettings({ theme })}
                  options={[
                    { value: 'dark', label: '深色', icon: 'moon' },
                    { value: 'light', label: '浅色', icon: 'sun' },
                  ]}
                />
              </div>

              <div className="settings-row">
                <div className="settings-label">
                  <div className="settings-name">颜色复制格式</div>
                  <div className="settings-desc">点击色块或色值时，复制到剪贴板的格式。</div>
                </div>
                <Segmented
                  value={data.settings.colorFormat}
                  onChange={(colorFormat) => actions.updateSettings({ colorFormat })}
                  options={[
                    { value: 'hex', label: 'HEX' },
                    { value: 'rgb', label: 'RGB' },
                    { value: 'hsl', label: 'HSL' },
                    { value: 'oklch', label: 'OKLCH' },
                  ]}
                />
              </div>

              <div className="settings-row">
                <div className="settings-label">
                  <div className="settings-name">默认预览模式</div>
                  <div className="settings-desc">主题、控件预览默认展示浅色还是深色配色。</div>
                </div>
                <ModeToggle
                  value={data.settings.previewMode}
                  onChange={(previewMode) => actions.updateSettings({ previewMode })}
                />
              </div>

              <div className="settings-row">
                <div className="settings-label">
                  <div className="settings-name">自动保存快照</div>
                  <div className="settings-desc">重新生成主题前自动记录当前配色，方便回滚。</div>
                </div>
                <Switch
                  checked={data.settings.autoSnapshot}
                  onChange={(autoSnapshot) => actions.updateSettings({ autoSnapshot })}
                />
              </div>
            </div>
          </Panel>

          <Panel title="数据与存储" subtitle="所有项目数据保存在本机，不会上传网络">
            <div className="settings-list">
              <div className="settings-row">
                <div className="settings-label">
                  <div className="settings-name">数据文件</div>
                  <div className="settings-desc mono" style={{ wordBreak: 'break-all' }}>
                    {info?.dataPath ?? '（浏览器预览模式使用 localStorage）'}
                  </div>
                  <div className="settings-desc">
                    保存状态：
                    {saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存失败' : '已自动保存'}
                  </div>
                </div>
                <div className="settings-actions">
                  <Button size="sm" icon="folder" onClick={() => void window.desktop?.revealDataDir()}>
                    打开数据目录
                  </Button>
                  <Button size="sm" icon="download" onClick={() => void exportAll()}>
                    导出全部数据
                  </Button>
                  <Button size="sm" icon="import" onClick={() => void importAll()}>
                    导入数据
                  </Button>
                  <Button
                    size="sm"
                    icon="sparkles"
                    onClick={() => {
                      const demo = createDemoProject()
                      actions.replaceData({ ...data, projects: [demo, ...data.projects], activeProjectId: demo.id })
                      toast('已添加示例项目', 'success')
                    }}
                  >
                    添加示例项目
                  </Button>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-label">
                  <div className="settings-name">项目统计</div>
                  <div className="settings-desc">
                    共 {data.projects.length} 个项目 ·{' '}
                    {data.projects.reduce((sum, project) => sum + project.palette.length, 0)} 个颜色记录 ·{' '}
                    {data.projects.reduce((sum, project) => sum + project.snapshots.length, 0)} 条快照
                  </div>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="快捷键">
            <div className="shortcut-grid">
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">N</kbd>
                <span>新建项目</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">1</kbd>
                <span>色板</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">2</kbd>
                <span>主题</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">3</kbd>
                <span>控件配色</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">4</kbd>
                <span>对比度</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">5</kbd>
                <span>导出</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Ctrl</kbd>
                <kbd className="kbd">6</kbd>
                <span>记录</span>
              </div>
              <div className="shortcut-item">
                <kbd className="kbd">Esc</kbd>
                <span>关闭弹窗</span>
              </div>
            </div>
          </Panel>

          <Panel title="关于">
            <div className="about-block">
              <div className="about-logo">
                <Icon name="palette" size={30} />
              </div>
              <div>
                <div className="about-name">配色工坊</div>
                <div className="about-desc">前端配色管理工具 · 为每个前端项目生成、记录并导出专属配色。</div>
                <div className="about-meta">
                  版本 {info?.version ?? '1.0.0'} · {info?.platform === 'win32' ? 'Windows 桌面版' : info?.platform ?? '桌面版'}
                  {info ? ` · ${formatTime(Date.now())}` : ''}
                </div>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingImport)}
        title="导入数据"
        message={`将用备份数据覆盖当前全部项目（当前共 ${data.projects.length} 个项目），此操作不可撤销。确定继续吗？`}
        confirmText="覆盖导入"
        danger
        onCancel={() => setPendingImport(null)}
        onConfirm={() => {
          if (pendingImport) {
            actions.replaceData(pendingImport)
            toast('数据已导入', 'success')
          }
          setPendingImport(null)
        }}
      />
    </div>
  )
}
