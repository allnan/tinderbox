import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PreviewDevice, Project } from '../shared/types'
import { IconButton, Button, Segmented, cx } from './ui'
import { ModeToggle } from './color-ui'
import { PreviewLegend, ThemePreview } from './ThemePreview'

/** 设备切换选项 */
const DEVICE_OPTIONS: Array<{ value: PreviewDevice; label: string; icon: 'monitor' | 'smartphone' }> = [
  { value: 'desktop', label: '桌面端', icon: 'monitor' },
  { value: 'mobile', label: '手机端', icon: 'smartphone' },
]

const DEFAULT_WIDTH = 760
const MIN_WIDTH = 480
const SIDEBAR_WIDTH = 248
/** 抽屉打开时给主编辑区保留的最小宽度 */
const MIN_MAIN_WIDTH = 520

/** 当前窗口下抽屉可用的最大宽度（保证主界面仍有可编辑空间） */
function maxDrawerWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - SIDEBAR_WIDTH - MIN_MAIN_WIDTH))
}

/**
 * 停靠式右侧预览面板：从窗口右侧向外展开，主界面自动让出宽度（不遮盖、无遮罩），
 * 因此可以一边在主窗口里改主题/切模式，一边实时看到预览变化。
 * 支持拖动左边缘调整宽度、设备切换（桌面端/手机端）、跳到独立窗口。
 */
export function PreviewDrawer({
  open,
  onClose,
  project,
  mode,
  device,
  onChangeMode,
  onChangeDevice,
  onOpenWindow,
  windowAvailable,
}: {
  open: boolean
  onClose: () => void
  project: Project
  mode: 'light' | 'dark'
  device: PreviewDevice
  onChangeMode: (mode: 'light' | 'dark') => void
  onChangeDevice: (device: PreviewDevice) => void
  onOpenWindow: () => void
  windowAvailable: boolean
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  // 打开时让主界面让出右侧空间（html class 驱动 .app-body 的 padding），关闭时恢复
  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    root.classList.add('preview-drawer-open')
    // 初始宽度按窗口大小收敛，保证主界面仍有足够的可编辑区域
    setWidth((current) => Math.min(current, maxDrawerWidth()))
    return () => {
      root.classList.remove('preview-drawer-open')
      root.classList.remove('preview-drawer-resizing')
      root.style.removeProperty('--preview-drawer-width')
    }
  }, [open])

  // 宽度变化时同步给外壳（.app-body 用这个变量计算 padding）
  useEffect(() => {
    if (!open) return
    document.documentElement.style.setProperty('--preview-drawer-width', `${width}px`)
  }, [open, width])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  /** 拖动面板左边缘调整宽度 */
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: width }
      document.documentElement.classList.add('preview-drawer-resizing')
      setResizing(true)

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        // 拖拽上限：仍给主界面的侧栏之外留出至少 320px
        const max = Math.min(window.innerWidth - SIDEBAR_WIDTH - 320, 1400)
        const next = Math.min(max, Math.max(MIN_WIDTH, drag.startWidth + (drag.startX - moveEvent.clientX)))
        setWidth(next)
      }
      const onUp = () => {
        dragRef.current = null
        document.documentElement.classList.remove('preview-drawer-resizing')
        setResizing(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [width],
  )

  if (!open) return null

  return createPortal(
    <aside
      className={cx('preview-drawer', resizing && 'is-resizing')}
      style={{ width }}
      role="dialog"
      aria-modal="false"
      aria-label="界面预览"
    >
      <div
        className="preview-drawer-resizer"
        onPointerDown={startResize}
        title="拖动调整预览宽度"
        aria-label="拖动调整预览宽度"
      />
      <header className="preview-drawer-head">
        <div className="preview-drawer-title">
          <strong>
            界面预览
            <span className="preview-drawer-live">
              <span className="preview-drawer-live-dot" />
              实时同步
            </span>
          </strong>
          <span>{project.name} · 主窗口可继续编辑 · 实时刷新</span>
        </div>
        <div className="preview-drawer-controls">
          <Segmented<PreviewDevice>
            size="sm"
            value={device}
            onChange={onChangeDevice}
            options={DEVICE_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
              icon: item.icon,
            }))}
          />
          <ModeToggle size="sm" value={mode} onChange={onChangeMode} />
          {windowAvailable ? (
            <Button size="sm" icon="external" onClick={onOpenWindow}>
              独立窗口
            </Button>
          ) : null}
          <IconButton icon="close" label="关闭预览" onClick={onClose} />
        </div>
      </header>

      <div className="preview-drawer-body">
        <div className={cx('preview-drawer-canvas', `is-${device}`)}>
          <ThemePreview project={project} mode={mode} device={device} />
        </div>
        <PreviewLegend project={project} mode={mode} />
      </div>
    </aside>,
    document.body,
  )
}
