// Electron 启动探针：只打印版本并退出，用于确认当前会话能否运行截图。
const { app } = require('electron')

app.whenReady().then(() => {
  console.log(`[probe] electron=${process.versions.electron} chrome=${process.versions.chrome}`)
  app.quit()
})
