/** 桌面端（Electron preload）暴露的桥接 API 类型 */
import type { AppData, PreviewDevice, PreviewPayload } from './types'

export interface DesktopBridge {
  isDesktop: boolean
  loadState: () => Promise<{ data: AppData | null; path: string; recovered?: boolean }>
  saveState: (state: AppData) => Promise<{ ok: boolean; path?: string; error?: string }>
  revealDataDir: () => Promise<{ ok: boolean; path: string }>
  saveFile: (options: {
    content: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<{ canceled: boolean; filePath?: string }>
  openFile: (options?: {
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<{ canceled: boolean; filePath?: string; content?: string }>
  writeClipboard: (text: string) => Promise<{ ok: boolean }>
  getAppInfo: () => Promise<{
    version: string
    name: string
    dataPath: string
    platform: string
    isDev: boolean
  }>
  getVersion: () => Promise<string>
  toggleDevTools: () => Promise<void>
  /** 独立预览窗口（主窗口 → 预览窗口实时同步主题/设备形态） */
  preview: {
    /** 打开（或聚焦）独立预览窗口 */
    open: () => Promise<{ ok: boolean; reused?: boolean }>
    /** 关闭独立预览窗口 */
    close: () => Promise<{ ok: boolean }>
    /** 预览窗口是否已打开 */
    isOpen: () => Promise<boolean>
    /** 主窗口推送最新预览状态（主进程会缓存并转发给预览窗口） */
    update: (payload: PreviewPayload) => void
    /** 预览窗口读取当前预览状态 */
    getState: () => Promise<PreviewPayload | null>
    /** 预览窗口订阅状态更新 */
    onState: (callback: (payload: PreviewPayload) => void) => () => void
    /** 主窗口订阅预览窗口关闭事件 */
    onClosed: (callback: () => void) => () => void
    /** 预览窗口请求切换明暗模式（会回传给主窗口） */
    setMode: (mode: 'light' | 'dark') => void
    /** 预览窗口请求切换设备形态（会回传给主窗口） */
    setDevice: (device: PreviewDevice) => void
    /** 主窗口订阅预览窗口发起的模式切换 */
    onSetMode: (callback: (mode: 'light' | 'dark') => void) => () => void
    /** 主窗口订阅预览窗口发起的设备切换 */
    onSetDevice: (callback: (device: PreviewDevice) => void) => () => void
  }
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
  }
}

declare global {
  interface Window {
    desktop?: DesktopBridge
  }
}

export {}
