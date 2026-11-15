/* eslint-disable */
/**
 * Tauri 版桌面桥接层（真实实现，tauri-shim.js）
 * ---------------------------------------------------------------------------
 * 由 scripts/prepare-dist.mjs 注入到从 x-gif-studio/dist 复制的页面中（在 app.js 之前），
 * 用 window.desktop 复刻 Electron preload 的 DesktopApi；所有方法都通过 Tauri invoke
 * 调用 Rust 后端真实命令（推文解析、媒体下载/保存、GIF/WebP 转换、工具下载、历史、设置、文件操作、代理）。
 *
 * 进度事件（任务进度 / 工具下载进度）由前端轮询 jobs_poll / tools_poll 实现。
 * 本地文件显示使用 Tauri asset 协议（convertFileSrc），远程图片保持原 https 地址由 WebView2 系统代理加载。
 */
;(function () {
  'use strict'

  var internals = window.__TAURI_INTERNALS__

  function invoke(command, args) {
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject(new Error('Tauri IPC 不可用（当前页面未运行在 Tauri 窗口中）'))
    }
    return internals.invoke(command, args || {})
  }

  function ok(data) {
    return { ok: true, data: data }
  }

  function fail(message) {
    return { ok: false, error: String(message || '未知错误') }
  }

  function call(command, args) {
    return invoke(command, args).catch(function (error) {
      return fail(error && error.message ? error.message : error)
    })
  }

  function expectOk(response) {
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? response.error : '操作失败')
    }
    return response.data
  }

  function convertFileSrc(path) {
    if (typeof internals.convertFileSrc === 'function') {
      try {
        return internals.convertFileSrc(path)
      } catch (error) {
        /* 回退到手工拼接 */
      }
    }
    return 'http://asset.localhost/' + encodeURIComponent(path)
  }

  function displayUrl(path) {
    var text = String(path == null ? '' : path)
    if (!text) return ''
    if (/^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i.test(text)) return text
    return convertFileSrc(text)
  }

  // -------------------------------------------------------------------------
  // 进度轮询（jobs.onProgress / tools.onProgress）
  // -------------------------------------------------------------------------

  var jobSubscribers = new Set()
  var jobTimer = null
  var lastJobSnapshot = ''

  function ensureJobPolling() {
    if (jobTimer || jobSubscribers.size === 0) return
    jobTimer = setInterval(function () {
      if (jobSubscribers.size === 0) {
        clearInterval(jobTimer)
        jobTimer = null
        return
      }
      call('jobs_poll').then(function (response) {
        if (!response || response.ok !== true || !Array.isArray(response.data)) return
        var snapshot = JSON.stringify(response.data)
        if (snapshot === lastJobSnapshot) return
        lastJobSnapshot = snapshot
        response.data.forEach(function (progress) {
          jobSubscribers.forEach(function (callback) {
            try {
              callback(progress)
            } catch (error) {
              /* 忽略订阅回调异常 */
            }
          })
        })
      }).catch(function () {})
    }, 300)
  }

  var toolSubscribers = new Set()
  var toolTimer = null
  var lastToolSnapshot = ''

  function ensureToolPolling() {
    if (toolTimer || toolSubscribers.size === 0) return
    toolTimer = setInterval(function () {
      if (toolSubscribers.size === 0) {
        clearInterval(toolTimer)
        toolTimer = null
        return
      }
      call('tools_poll').then(function (response) {
        if (!response || response.ok !== true || !response.data) return
        var progress = response.data
        var snapshot = JSON.stringify(progress)
        if (snapshot === lastToolSnapshot) return
        lastToolSnapshot = snapshot
        toolSubscribers.forEach(function (callback) {
          try {
            callback(progress)
          } catch (error) {
            /* 忽略订阅回调异常 */
          }
        })
      }).catch(function () {})
    }, 300)
  }

  // -------------------------------------------------------------------------
  // DesktopApi
  // -------------------------------------------------------------------------

  var desktop = {
    isDesktop: true,

    app: {
      info: function () {
        return call('app_info')
      },
      toggleDevTools: function () {
        return call('app_toggle_devtools').then(function () {})
      },
      openOutputDir: function () {
        return call('app_open_output_dir')
      },
      openCacheDir: function () {
        return call('app_open_cache_dir')
      },
      openDataDir: function () {
        return call('app_open_data_dir')
      },
    },

    tools: {
      download: function (names) {
        return call('tools_download', { names: Array.isArray(names) && names.length > 0 ? names : null })
      },
      onProgress: function (callback) {
        if (typeof callback !== 'function') return function () {}
        toolSubscribers.add(callback)
        ensureToolPolling()
        return function () {
          toolSubscribers.delete(callback)
        }
      },
    },

    tweet: {
      fetch: function (url) {
        return call('tweet_fetch', { url: String(url == null ? '' : url) })
      },
    },

    media: {
      prepare: function (request) {
        return call('media_prepare', { request: request })
      },
      save: function (request) {
        return call('media_save', { request: request })
      },
      exportAs: function (filePath, defaultName) {
        return call('media_export_as', { filePath: filePath, defaultName: defaultName || null })
      },
      open: function (filePath) {
        return call('media_open', { filePath: filePath })
      },
      reveal: function (filePath) {
        return call('media_reveal', { filePath: filePath })
      },
      remove: function (filePath) {
        return call('media_remove', { filePath: filePath })
      },
      copyPath: function (filePath) {
        return desktop.clipboard.writeText(filePath)
      },
      toDisplayUrl: function (filePath) {
        return Promise.resolve(displayUrl(filePath))
      },
      videoThumbnail: function (filePath) {
        return call('media_video_thumbnail', { filePath: filePath })
          .then(function (response) {
            if (response && response.ok === true && response.data) return displayUrl(response.data)
            return ''
          })
          .catch(function () {
            return ''
          })
      },
      probeFile: function (filePath) {
        return call('media_probe_file', { filePath: filePath }).then(function (response) {
          if (response && response.ok === true) return response.data
          return null
        }).catch(function () {
          return null
        })
      },
    },

    gif: {
      convert: function (request) {
        return call('gif_convert', { request: request })
      },
      info: function (filePath) {
        return call('gif_info', { filePath: filePath })
      },
      exportAs: function (filePath, defaultName) {
        return call('gif_export_as', { filePath: filePath, defaultName: defaultName || null })
      },
      open: function (filePath) {
        return call('gif_open', { filePath: filePath })
      },
      reveal: function (filePath) {
        return call('gif_reveal', { filePath: filePath })
      },
      remove: function (filePath) {
        return call('gif_remove', { filePath: filePath })
      },
      copyPath: function (filePath) {
        return desktop.clipboard.writeText(filePath)
      },
    },

    history: {
      list: function () {
        return call('history_list')
      },
      get: function (tweetId) {
        return call('history_get', { tweetId: tweetId })
      },
      remove: function (tweetId, deleteFiles) {
        return call('history_remove', { tweetId: tweetId, deleteFiles: Boolean(deleteFiles) })
      },
      removeResult: function (tweetId, resultId) {
        return call('history_remove_result', { tweetId: tweetId, resultId: resultId })
      },
      removeSaved: function (tweetId, savedId) {
        return call('history_remove_saved', { tweetId: tweetId, savedId: savedId })
      },
      clear: function () {
        return call('history_clear')
      },
    },

    settings: {
      get: function () {
        return call('settings_get')
      },
      save: function (settings) {
        return call('settings_save', { settings: settings })
      },
      chooseDirectory: function (kind) {
        return call('settings_choose_directory', { kind: kind }).then(function (response) {
          if (response && response.ok === true) return ok(response.data)
          return response
        })
      },
    },

    proxy: {
      test: function (proxy) {
        return call('proxy_test', { proxy: proxy })
      },
    },

    jobs: {
      cancel: function (jobId) {
        return call('jobs_cancel', { jobId: jobId })
      },
      onProgress: function (callback) {
        if (typeof callback !== 'function') return function () {}
        jobSubscribers.add(callback)
        ensureJobPolling()
        return function () {
          jobSubscribers.delete(callback)
        }
      },
    },

    clipboard: {
      writeText: function (text) {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
          return Promise.resolve(fail('当前环境不支持剪贴板写入'))
        }
        return navigator.clipboard
          .writeText(String(text == null ? '' : text))
          .then(function () {
            return ok(true)
          })
          .catch(function (error) {
            return fail('复制失败：' + (error && error.message ? error.message : error))
          })
      },
    },

    window: {
      minimize: function () {
        return invoke('window_minimize').catch(function () {})
      },
      toggleMaximize: function () {
        return invoke('window_toggle_maximize').catch(function () {
          return false
        })
      },
      isMaximized: function () {
        return invoke('window_is_maximized').catch(function () {
          return false
        })
      },
      close: function () {
        return invoke('window_close').catch(function () {})
      },
      onMaximizedChange: function () {
        return function () {}
      },
    },
  }

  // -------------------------------------------------------------------------
  // 无边框窗口：标题栏拖动（WebView2 不支持 Electron 的 -webkit-app-region）
  // -------------------------------------------------------------------------

  function installTitlebarDrag() {
    var armed = false
    var startX = 0
    var startY = 0

    document.addEventListener('mousedown', function (event) {
      if (event.button !== 0 || event.detail > 1) return
      var target = event.target
      if (!(target instanceof Element)) return
      if (!target.closest('.titlebar')) return
      if (target.closest('button, a, input, textarea, select, .window-controls, .titlebar-badges, .titlebar-link')) return
      armed = true
      startX = event.clientX
      startY = event.clientY
    })

    document.addEventListener('mousemove', function (event) {
      if (!armed) return
      var dx = event.clientX - startX
      var dy = event.clientY - startY
      if (dx * dx + dy * dy < 16) return
      armed = false
      invoke('window_start_drag').catch(function () {})
    })

    document.addEventListener('mouseup', function () {
      armed = false
    })

    window.addEventListener('blur', function () {
      armed = false
    })
  }

  window.desktop = desktop
  window.__XGIF_TAURI__ = { isTauri: true, shell: 'tauri' }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installTitlebarDrag)
  } else {
    installTitlebarDrag()
  }

  console.info('[Tauri] window.desktop 已注入：所有桌面能力通过 Tauri invoke 调用 Rust 后端')
})()
