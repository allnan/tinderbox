const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程唯一的桌面能力入口。字段与 src/shared/types.ts 的 DesktopApi 一一对应。
 * 渲染进程没有 Node 权限，所有文件/网络操作都必须走这里。
 */
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    toggleDevTools: () => ipcRenderer.invoke('app:toggle-devtools'),
    openOutputDir: () => ipcRenderer.invoke('app:open-output-dir'),
    openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
    openCacheDir: () => ipcRenderer.invoke('app:open-cache-dir'),
  },
  tweet: {
    fetch: (url) => ipcRenderer.invoke('tweet:fetch', { url }),
  },
  media: {
    prepare: (req) => ipcRenderer.invoke('media:prepare', req),
    save: (req) => ipcRenderer.invoke('media:save', req),
    exportAs: (filePath, defaultName) => ipcRenderer.invoke('media:export-as', { filePath, defaultName }),
    open: (filePath) => ipcRenderer.invoke('media:open', { filePath }),
    reveal: (filePath) => ipcRenderer.invoke('media:reveal', { filePath }),
    remove: (filePath) => ipcRenderer.invoke('media:remove', { filePath }),
    copyPath: (filePath) => ipcRenderer.invoke('media:copy-path', { filePath }),
    toDisplayUrl: (filePath) => ipcRenderer.invoke('media:display-url', { filePath }),
    videoThumbnail: (filePath) => ipcRenderer.invoke('media:video-thumbnail', { filePath }),
    probeFile: (filePath) => ipcRenderer.invoke('media:probe-file', { filePath }),
  },
  gif: {
    convert: (req) => ipcRenderer.invoke('gif:convert', req),
    info: (filePath) => ipcRenderer.invoke('gif:info', { filePath }),
    exportAs: (filePath, defaultName) => ipcRenderer.invoke('gif:export-as', { filePath, defaultName }),
    open: (filePath) => ipcRenderer.invoke('gif:open', { filePath }),
    reveal: (filePath) => ipcRenderer.invoke('gif:reveal', { filePath }),
    remove: (filePath) => ipcRenderer.invoke('gif:remove', { filePath }),
    copyPath: (filePath) => ipcRenderer.invoke('gif:copy-path', { filePath }),
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    get: (tweetId) => ipcRenderer.invoke('history:get', { tweetId }),
    remove: (tweetId, deleteFiles) => ipcRenderer.invoke('history:remove', { tweetId, deleteFiles: Boolean(deleteFiles) }),
    removeResult: (tweetId, resultId) => ipcRenderer.invoke('history:remove-result', { tweetId, resultId }),
    removeSaved: (tweetId, savedId) => ipcRenderer.invoke('history:remove-saved', { tweetId, savedId }),
    clear: () => ipcRenderer.invoke('history:clear'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', { settings }),
    chooseDirectory: (kind) => ipcRenderer.invoke('settings:choose-directory', { kind }),
  },
  proxy: {
    test: (proxy) => ipcRenderer.invoke('proxy:test', { proxy }),
  },
  jobs: {
    cancel: (jobId) => ipcRenderer.invoke('jobs:cancel', { jobId }),
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('job:progress', listener)
      return () => ipcRenderer.removeListener('job:progress', listener)
    },
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:write', { text }),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizedChange: (callback) => {
      const listener = (_event, value) => callback(Boolean(value))
      ipcRenderer.on('window:maximized-changed', listener)
      return () => ipcRenderer.removeListener('window:maximized-changed', listener)
    },
  },
})
