/* 在 CSS/React 启动前应用主题，避免首帧黑底或白底闪烁。 */
;(function () {
  try {
    var theme = window.__XGIF_INITIAL_THEME__
    if (theme !== 'light' && theme !== 'dark') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    }
    var html = document.documentElement
    html.dataset.theme = theme
    html.style.colorScheme = theme
    html.style.background = theme === 'light' ? '#f3f5f9' : '#0a0d13'
  } catch (error) {
    /* 忽略初始化失败，随后 React 仍会按设置应用主题 */
  }
})()
