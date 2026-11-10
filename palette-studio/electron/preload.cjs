const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程可用的桌面能力。所有能力都走 IPC，渲染进程本身没有 Node 权限。
 * 类型声明见 src/shared/desktop.d.ts。
 */
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  revealDataDir: () => ipcRenderer.invoke('state:reveal'),
  saveFile: (options) => ipcRenderer.invoke('file:save', options),
  openFile: (options) => ipcRenderer.invoke('file:open', options),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  toggleDevTools: () => ipcRenderer.invoke('app:toggle-devtools'),
  /** 独立预览窗口桥接 */
  preview: {
    open: () => ipcRenderer.invoke('preview:open'),
    close: () => ipcRenderer.invoke('preview:close'),
    isOpen: () => ipcRenderer.invoke('preview:is-open'),
    update: (payload) => ipcRenderer.send('preview:update', payload),
    getState: () => ipcRenderer.invoke('preview:get-state'),
    onState: (callback) => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('preview:state', listener)
      return () => ipcRenderer.removeListener('preview:state', listener)
    },
    onClosed: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('preview:closed', listener)
      return () => ipcRenderer.removeListener('preview:closed', listener)
    },
    setMode: (mode) => ipcRenderer.send('preview:set-mode', mode),
    setDevice: (device) => ipcRenderer.send('preview:set-device', device),
    onSetMode: (callback) => {
      const listener = (_event, mode) => callback(mode)
      ipcRenderer.on('preview:set-mode', listener)
      return () => ipcRenderer.removeListener('preview:set-mode', listener)
    },
    onSetDevice: (callback) => {
      const listener = (_event, device) => callback(device)
      ipcRenderer.on('preview:set-device', listener)
      return () => ipcRenderer.removeListener('preview:set-device', listener)
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, value) => callback(Boolean(value))
      ipcRenderer.on('window:maximized-changed', listener)
      return () => ipcRenderer.removeListener('window:maximized-changed', listener)
    },
  },
})
