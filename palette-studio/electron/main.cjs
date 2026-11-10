const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const APP_NAME = '配色工坊'
const APP_ID = 'com.palette.studio'

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {BrowserWindow | null} 独立界面预览窗口 */
let previewWindow = null
/** @type {object | null} 主窗口最近一次推送的预览状态（主题/明暗/设备） */
let previewState = null

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

// 开发/验收辅助参数：--screenshot=<png 路径> 截图后退出；--smoke-log=<log 路径> 收集渲染进程日志
function findArg(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : null
}
const screenshotPath = findArg('--screenshot=')
const smokeLogPath = findArg('--smoke-log=')
const shotsDir = findArg('--shots-dir=')

function writeSmokeLog(line) {
  if (!smokeLogPath) return
  try {
    fs.appendFileSync(smokeLogPath, line + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 数据持久化
// ---------------------------------------------------------------------------

function dataDir() {
  return path.join(app.getPath('userData'), 'data')
}

function dataFile() {
  return path.join(dataDir(), 'palette-studio.json')
}

async function readState() {
  try {
    const raw = await fsp.readFile(dataFile(), 'utf8')
    return { data: JSON.parse(raw), path: dataFile() }
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[state:load]', err)
    // 尝试从备份恢复
    try {
      const backup = await fsp.readFile(path.join(dataDir(), 'palette-studio.backup.json'), 'utf8')
      return { data: JSON.parse(backup), path: dataFile(), recovered: true }
    } catch {
      return { data: null, path: dataFile() }
    }
  }
}

async function writeState(state) {
  const dir = dataDir()
  await fsp.mkdir(dir, { recursive: true })
  const file = dataFile()
  const tmp = file + '.tmp'
  const json = JSON.stringify(state, null, 2)
  // 先备份旧数据，再原子写入
  try {
    await fsp.copyFile(file, path.join(dir, 'palette-studio.backup.json'))
  } catch {
    /* 首次保存没有旧文件 */
  }
  await fsp.writeFile(tmp, json, 'utf8')
  await fsp.rename(tmp, file)
  return { ok: true, path: file, size: Buffer.byteLength(json) }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
    if (!saved || typeof saved !== 'object') return null
    const displays = screen.getAllDisplays()
    const visible = displays.some((display) => {
      const area = display.workArea
      return (
        typeof saved.x === 'number' &&
        typeof saved.y === 'number' &&
        saved.x < area.x + area.width - 80 &&
        saved.x + 80 > area.x &&
        saved.y < area.y + area.height - 80 &&
        saved.y + 80 > area.y
      )
    })
    return { ...saved, visible }
  } catch {
    return null
  }
}

function writeWindowState(window) {
  if (!window || window.isDestroyed()) return
  try {
    const bounds = window.getNormalBounds()
    fs.writeFileSync(
      windowStateFile(),
      JSON.stringify(
        { ...bounds, maximized: window.isMaximized(), savedAt: Date.now() },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* 忽略窗口状态保存失败 */
  }
}

/** 创建（或聚焦）独立界面预览窗口：复用同一份渲染产物，通过 ?view=preview 进入预览页面 */
function createPreviewWindow() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.show()
    previewWindow.focus()
    if (previewState) previewWindow.webContents.send('preview:state', previewState)
    return { ok: true, reused: true }
  }

  previewWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    title: `${APP_NAME} · 界面预览`,
    backgroundColor: '#0b0d12',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  previewWindow.once('ready-to-show', () => {
    previewWindow?.show()
    previewWindow?.focus()
  })
  previewWindow.webContents.on('did-finish-load', () => {
    writeSmokeLog('[preview-window] did-finish-load')
    if (previewState && previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.webContents.send('preview:state', previewState)
    }
  })
  previewWindow.on('closed', () => {
    writeSmokeLog('[preview-window] closed')
    previewWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:closed')
  })
  previewWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: { view: 'preview' },
  })
  return { ok: true }
}

function createWindow() {
  const saved = readWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1500,
    height: saved?.height ?? 950,
    ...(saved?.visible ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1180,
    minHeight: 760,
    show: false,
    frame: false,
    backgroundColor: '#0b0d12',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (screenshotPath || shotsDir) {
      // 截图模式：显示但不抢焦点，保证 Chromium 正常渲染动画后再截图
      mainWindow.showInactive()
      return
    }
    if (saved?.maximized) mainWindow.maximize()
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    writeSmokeLog(`[console:${level}] ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeSmokeLog(`[render-process-gone] ${JSON.stringify(details)}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    writeSmokeLog(`[did-fail-load] ${code} ${description} ${url}`)
  })
  mainWindow.webContents.on('did-finish-load', async () => {
    writeSmokeLog('[did-finish-load]')
    if (!screenshotPath && !shotsDir) return
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const evaluate = (code) => mainWindow.webContents.executeJavaScript(code)
    const capture = async (file) => {
      const image = await mainWindow.webContents.capturePage()
      fs.writeFileSync(file, image.toPNG())
      writeSmokeLog(`[shot] ${file}`)
    }
    try {
      await wait(1800)
      const domInfo = await evaluate(`JSON.stringify({
        rootLength: (document.getElementById('root') || {}).innerHTML ? document.getElementById('root').innerHTML.length : 0,
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
        errors: window.__ERRORS__ || [],
        view: document.querySelector('.page-title, .workspace-title') ? (document.querySelector('.page-title, .workspace-title').textContent || '').trim() : ''
      })`)
      writeSmokeLog(`[dom] ${domInfo}`)

      if (screenshotPath) {
        await capture(screenshotPath)
      }

      if (shotsDir) {
        fs.mkdirSync(shotsDir, { recursive: true })
        await capture(path.join(shotsDir, '01-projects.png'))
        await evaluate(`(document.querySelector('.project-card') || {click(){}}).click()`)
        await wait(1100)
        writeSmokeLog(`[dom] ${await evaluate('document.querySelector(".workspace-title") ? document.querySelector(".workspace-title").textContent : "workspace-missing"')}`)
        await capture(path.join(shotsDir, '02-palette.png'))

        const tabCount = await evaluate(`document.querySelectorAll('.tab').length`)
        writeSmokeLog(`[tabs] ${tabCount}`)
        for (let index = 1; index < tabCount; index += 1) {
          await evaluate(`(document.querySelectorAll('.tab')[${index}] || {click(){}}).click()`)
          await wait(1000)
          await capture(path.join(shotsDir, `0${index + 2}-tab-${index + 1}.png`))
        }

        // 设置页
        await evaluate(`(document.querySelectorAll('.sidebar-foot-btn')[0] || {click(){}}).click()`)
        await wait(900)
        await capture(path.join(shotsDir, '09-settings.png'))

        // 切换浅色主题
        await evaluate(`(document.querySelectorAll('.segmented-item')[1] || {click(){}}).click()`)
        await wait(900)
        await capture(path.join(shotsDir, '10-settings-light.png'))

        // 返回项目总览（浅色）
        await evaluate(`(document.querySelectorAll('.sidebar-item')[0] || {click(){}}).click()`)
        await wait(900)
        await capture(path.join(shotsDir, '11-projects-light.png'))

        // 新建项目弹窗
        await evaluate(
          `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '新建项目')?.click()`,
        )
        await wait(800)
        await capture(path.join(shotsDir, '12-new-project-dialog.png'))
        await evaluate(`document.querySelector('.modal-header .icon-btn')?.click()`)
        await wait(500)

        // 打开项目并切到深色预览
        await evaluate(`(document.querySelector('.project-card') || {click(){}}).click()`)
        await wait(1100)
        await evaluate(
          `(document.querySelectorAll('.workspace-actions .segmented-item')[1] || {click(){}}).click()`,
        )
        await wait(1000)
        await capture(path.join(shotsDir, '13-palette-dark-preview.png'))

        // 主题页（深色预览）
        await evaluate(`(document.querySelectorAll('.tab')[1] || {click(){}}).click()`)
        await wait(1100)
        await capture(path.join(shotsDir, '14-theme-dark-preview.png'))

        // ---- 界面预览：放大抽屉 / 手机端 / 独立窗口 ----
        await evaluate(
          `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('放大预览'))?.click()`,
        )
        await wait(900)
        await capture(path.join(shotsDir, '15-preview-drawer.png'))
        writeSmokeLog(
          `[preview-drawer] opened=${await evaluate(`Boolean(document.querySelector('.preview-drawer'))`)}`,
        )
        // 验证抽屉是停靠式（不遮挡主界面）且顶栏按钮可以真正命中（不在窗口拖拽区/未被遮挡）
        writeSmokeLog(
          `[preview-drawer-hit] ${await evaluate(`(() => {
            const drawer = document.querySelector('.preview-drawer')
            if (!drawer) return JSON.stringify({ ok: false })
            const item = [...drawer.querySelectorAll('.segmented-item')].find((b) => (b.textContent || '').includes('手机端'))
            const rect = item ? item.getBoundingClientRect() : null
            const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
            const body = document.querySelector('.app-body')
            return JSON.stringify({
              ok: true,
              drawerTop: Math.round(drawer.getBoundingClientRect().top),
              segTop: rect ? Math.round(rect.top) : null,
              hitSegmented: Boolean(hit && hit.closest('.segmented-item')),
              appBodyPaddingRight: body ? getComputedStyle(body).paddingRight : null,
              overlay: Boolean(document.querySelector('.preview-drawer-overlay')),
            })
          })()`)}`,
        )

        // 用真实鼠标事件点击「手机端」，确认顶部按钮不再被窗口拖拽区/遮挡吞掉点击
        const segPoint = JSON.parse(
          await evaluate(`(() => {
            const item = [...document.querySelectorAll('.preview-drawer .segmented-item')].find((b) => (b.textContent || '').includes('手机端'))
            if (!item) return 'null'
            const rect = item.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })
          })()`),
        )
        if (segPoint) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: segPoint.x, y: segPoint.y })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: segPoint.x, y: segPoint.y, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: segPoint.x, y: segPoint.y, button: 'left', clickCount: 1 })
          await wait(800)
          writeSmokeLog(
            `[preview-drawer-real-click] mobile=${await evaluate(`Boolean(document.querySelector('.preview-drawer .tp-phone'))`)}`,
          )
        }

        // 抽屉内切换到手机端
        await evaluate(
          `[...document.querySelectorAll('.preview-drawer .segmented-item')].find((b) => (b.textContent || '').includes('手机端'))?.click()`,
        )
        await wait(900)
        await capture(path.join(shotsDir, '16-preview-drawer-mobile.png'))
        writeSmokeLog(
          `[preview-drawer-device] ${await evaluate(`JSON.stringify({
            mobile: Boolean(document.querySelector('.tp-phone')),
            errors: window.__ERRORS__ || [],
          })`)}`,
        )

        // 切回桌面端并打开独立预览窗口
        await evaluate(
          `[...document.querySelectorAll('.preview-drawer .segmented-item')].find((b) => (b.textContent || '').includes('桌面端'))?.click()`,
        )
        await wait(600)
        await evaluate(
          `[...document.querySelectorAll('.preview-drawer button')].find((b) => (b.textContent || '').includes('独立窗口'))?.click()`,
        )
        await wait(2400)
        if (previewWindow && !previewWindow.isDestroyed()) {
          const previewImage = await previewWindow.webContents.capturePage()
          fs.writeFileSync(path.join(shotsDir, '17-preview-window.png'), previewImage.toPNG())
          writeSmokeLog('[shot] 17-preview-window.png')
          const previewDom = await previewWindow.webContents.executeJavaScript(
            `JSON.stringify({ text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 220), hasPreview: Boolean(document.querySelector('.theme-preview')), errors: window.__ERRORS__ || [] })`,
          )
          writeSmokeLog(`[preview-window-dom] ${previewDom}`)
          previewWindow.close()
        } else {
          writeSmokeLog('[preview-window] 预览窗口未创建')
        }
        await wait(500)
        await evaluate(`document.querySelector('.preview-drawer .icon-btn[aria-label="关闭预览"]')?.click()`)
        await wait(500)

        // 取色器验收：回到色板 → 打开「添加颜色」弹窗 → 打开自研取色器 → 截图
        await evaluate(`(document.querySelectorAll('.tab')[0] || {click(){}}).click()`)
        await wait(900)
        await evaluate(
          `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '添加颜色')?.click()`,
        )
        await wait(800)
        await evaluate(`document.querySelector('.modal .cp-trigger')?.click()`)
        await wait(700)
        await capture(path.join(shotsDir, '18-color-picker.png'))
        writeSmokeLog(
          `[color-picker] ${await evaluate(`JSON.stringify({
            open: Boolean(document.querySelector('.cp-popover')),
            activeMode: (document.querySelector('.cp-mode-item.is-active .cp-mode-tab') || {}).textContent,
            modeTabs: document.querySelectorAll('.cp-mode-tab').length,
            grid: Boolean(document.querySelector('.cp-grid')),
            gridCells: document.querySelectorAll('.cp-grid-cell').length,
            pinnedMode: (document.querySelector('.cp-mode-item.is-pinned .cp-mode-tab') || {}).textContent,
            applyMode: ([...document.querySelectorAll('.cp-apply-btn')].find((b) => b.classList.contains('is-active')) || {}).textContent,
            hasAlpha: Boolean(document.querySelector('.cp-alpha')),
            popoverHeight: (document.querySelector('.cp-popover') || {}).offsetHeight || 0,
            errors: window.__ERRORS__ || [],
          })`)}`,
        )
        writeSmokeLog(
          `[color-picker-state] ${await evaluate(`JSON.stringify({ hex: (document.querySelector('.cp-hex') || {}).value })`)}`,
        )
        // 首次使用默认值：默认取色方式应为全彩、应用方式应为确认后（用户未保存过偏好时）
        writeSmokeLog(
          `[color-picker-defaults] ${await evaluate(`JSON.stringify({
            activeMode: (document.querySelector('.cp-mode-item.is-active .cp-mode-tab') || {}).textContent,
            pinnedMode: (document.querySelector('.cp-mode-item.is-pinned .cp-mode-tab') || {}).textContent,
            applyMode: ([...document.querySelectorAll('.cp-apply-btn')].find((b) => b.classList.contains('is-active')) || {}).textContent,
          })`)}`,
        )
        // 颜色小窗：点当前颜色块浮层展开（中文色名 + HEX），不应改变取色器高度，再点收起
        const colorInfoHeightBefore = await evaluate(`(document.querySelector('.cp-popover') || {}).offsetHeight || 0`)
        await evaluate(`(document.querySelector('.cp-color-field .cp-field-swatch') || {click(){}}).click()`)
        await wait(350)
        const colorInfoHeightAfter = await evaluate(`(document.querySelector('.cp-popover') || {}).offsetHeight || 0`)
        writeSmokeLog(
          `[color-picker-color-info] ${await evaluate(`(() => {
            const card = document.querySelector('.cp-color-preview')
            const swatch = document.querySelector('.cp-color-preview-swatch')
            const pop = document.querySelector('.cp-popover')
            const cr = card ? card.getBoundingClientRect() : null
            const sr = swatch ? swatch.getBoundingClientRect() : null
            const pr = pop ? pop.getBoundingClientRect() : null
            const sameBg = card && pop ? getComputedStyle(card).backgroundColor === getComputedStyle(pop).backgroundColor : false
            return JSON.stringify({
              visible: Boolean(card),
              name: (document.querySelector('.cp-color-preview-name') || {}).textContent || '',
              hex: (document.querySelector('.cp-color-preview-hex') || {}).textContent || '',
              width: cr ? Math.round(cr.width) : 0,
              height: cr ? Math.round(cr.height) : 0,
              square: cr ? Math.abs(cr.width - cr.height) < 1 : false,
              swatchWidth: sr ? Math.round(sr.width) : 0,
              swatchHeight: sr ? Math.round(sr.height) : 0,
              swatchSquare: sr ? Math.abs(sr.width - sr.height) < 1 : false,
              leftOfPopover: cr && pr ? cr.right <= pr.left : false,
              gap: cr && pr ? Math.round(pr.left - cr.right) : 0,
              alignTop: cr && pr ? Math.abs(cr.top - pr.top) < 1 : false,
              sameBg,
            })
          })()`)} heightBefore=${colorInfoHeightBefore} heightAfter=${colorInfoHeightAfter} heightStable=${colorInfoHeightBefore === colorInfoHeightAfter}`,
        )
        await capture(path.join(shotsDir, '22-color-picker-info.png'))
        await evaluate(`(document.querySelector('.cp-color-field .cp-field-swatch') || {click(){}}).click()`)
        await wait(250)
        writeSmokeLog(
          `[color-picker-color-info-toggle] visibleAfterClick=${await evaluate(`Boolean(document.querySelector('.cp-color-preview'))`)}`,
        )
        // 强调色锁定：即使全局 --accent 变化，取色器内部控件（pin/标签）颜色也不应跟着变
        const accentLockBefore = await evaluate(`JSON.stringify({
          root: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          pin: getComputedStyle(document.querySelector('.cp-mode-pin')).color,
          tab: getComputedStyle(document.querySelector('.cp-tab.is-active')).color,
        })`)
        await evaluate(`document.documentElement.style.setProperty('--accent', '#F14000')`)
        await wait(300)
        const accentLockAfter = await evaluate(`JSON.stringify({
          pin: getComputedStyle(document.querySelector('.cp-mode-pin')).color,
          tab: getComputedStyle(document.querySelector('.cp-tab.is-active')).color,
        })`)
        const beforeObj = JSON.parse(accentLockBefore)
        const afterObj = JSON.parse(accentLockAfter)
        await evaluate(`document.documentElement.style.setProperty('--accent', '${beforeObj.root}')`)
        writeSmokeLog(
          `[color-picker-accent-lock] root=${beforeObj.root} pinBefore=${beforeObj.pin} pinAfter=${afterObj.pin} tabBefore=${beforeObj.tab} tabAfter=${afterObj.tab} locked=${beforeObj.pin === afterObj.pin && beforeObj.tab === afterObj.tab}`,
        )
        const openHex = await evaluate(`(document.querySelector('.cp-hex') || {}).value`)
        writeSmokeLog(
          `[color-picker-restore-initial] openHex=${openHex} disabled=${await evaluate(`Boolean((document.querySelector('.cp-restore-btn') || {}).disabled)`)}`,
        )
        // 首次打开默认全彩：先切到色块模式，验证「单击即选」；面板高度在切换后记录
        await evaluate(`[...document.querySelectorAll('.cp-mode-tab')][2]?.click()`)
        await wait(400)
        const popoverHeightBefore = await evaluate(`(document.querySelector('.cp-popover') || {}).offsetHeight || 0`)
        // 真实鼠标单击色块网格（第 3 行第 7 列），验证「一格一点就换色」
        const gridPoint = JSON.parse(
          await evaluate(`(() => {
            const cell = document.querySelectorAll('.cp-grid-cell')[2 * 12 + 6]
            if (!cell) return 'null'
            const rect = cell.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), expect: cell.title })
          })()`),
        )
        if (gridPoint) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: gridPoint.x, y: gridPoint.y })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: gridPoint.x, y: gridPoint.y, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: gridPoint.x, y: gridPoint.y, button: 'left', clickCount: 1 })
          await wait(500)
          writeSmokeLog(
            `[color-picker-grid-click] ${await evaluate(`JSON.stringify({ hex: (document.querySelector('.cp-hex') || {}).value, expect: ${JSON.stringify(gridPoint.expect)}, cells: document.querySelectorAll('.cp-grid-cell').length })`)}`,
          )
        }
        // 恢复按钮固定占位：改动后点亮，点击恢复进入时颜色，且面板高度不变
        const restoreActive = await evaluate(`!((document.querySelector('.cp-restore-btn') || {}).disabled)`)
        const restoreTitle = await evaluate(`(document.querySelector('.cp-restore-btn') || {}).title`)
        const restoreHexText = await evaluate(`(document.querySelector('.cp-initial-hex') || {}).textContent`)
        const popoverHeightAfter = await evaluate(`(document.querySelector('.cp-popover') || {}).offsetHeight || 0`)
        await capture(path.join(shotsDir, '21-color-picker-revert.png'))
        await evaluate(`(document.querySelector('.cp-restore-btn') || {click(){}}).click()`)
        await wait(450)
        const afterRevertHex = await evaluate(`(document.querySelector('.cp-hex') || {}).value`)
        const afterRevertExternal = await evaluate(`(document.querySelector('.modal .hex-input') || {}).value`)
        const restoreDisabledAgain = await evaluate(`Boolean((document.querySelector('.cp-restore-btn') || {}).disabled)`)
        writeSmokeLog(
          `[color-picker-restore] activeAfterChange=${restoreActive} title=${JSON.stringify(restoreTitle)} initialHexText=${restoreHexText} openHex=${openHex} afterHex=${afterRevertHex} afterExternal=${afterRevertExternal} match=${afterRevertHex === openHex} disabledAgain=${restoreDisabledAgain} heightStable=${popoverHeightBefore === popoverHeightAfter}(${popoverHeightBefore}->${popoverHeightAfter})`,
        )

        // 真实鼠标点击透明度条，验证 alpha 输出（8 位 HEX）
        const alphaPoint = JSON.parse(
          await evaluate(`(() => {
            const el = document.querySelector('.cp-alpha')
            if (!el) return 'null'
            const rect = el.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(rect.left + rect.width * 0.5), y: Math.round(rect.top + rect.height / 2) })
          })()`),
        )
        if (alphaPoint) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: alphaPoint.x, y: alphaPoint.y })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: alphaPoint.x, y: alphaPoint.y, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: alphaPoint.x, y: alphaPoint.y, button: 'left', clickCount: 1 })
          await wait(500)
          writeSmokeLog(
            `[color-picker-alpha] ${await evaluate(`JSON.stringify({
              hex: (document.querySelector('.cp-hex') || {}).value,
              alphaInput: [...document.querySelectorAll('.cp-rgb-item')].filter((item) => (item.textContent || '').includes('A'))[0]?.querySelector('input')?.value,
            })`)}`,
          )
        }

        // 面板模式仍在：切换后应出现 SV 面板
        await evaluate(`[...document.querySelectorAll('.cp-mode-tab')][0]?.click()`)
        await wait(400)
        writeSmokeLog(
          `[color-picker-panel] ${await evaluate(`JSON.stringify({
            sv: Boolean(document.querySelector('.cp-sv')),
            hue: Boolean(document.querySelector('.cp-hue')),
            activeMode: (document.querySelector('.cp-mode-item.is-active .cp-mode-tab') || {}).textContent,
          })`)}`,
        )
        // pin 交互：未 pin 的选中 tab 悬停出现 pin；已 pin 但未选中的 tab 显示淡化 pin
        const panelItemPoint = JSON.parse(
          await evaluate(`(() => {
            const el = document.querySelectorAll('.cp-mode-item')[0]
            if (!el) return 'null'
            const rect = el.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })
          })()`),
        )
        if (panelItemPoint) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: panelItemPoint.x, y: panelItemPoint.y })
          await wait(350)
          writeSmokeLog(
            `[color-picker-pin-hover] ${await evaluate(`JSON.stringify({
              activePinOpacity: (() => { const el = document.querySelector('.cp-mode-item.is-active .cp-mode-pin'); return el ? getComputedStyle(el).opacity : 'missing' })(),
              pinnedInactiveOpacity: (() => { const el = document.querySelector('.cp-mode-item.is-pinned:not(.is-active) .cp-mode-pin'); return el ? getComputedStyle(el).opacity : 'missing' })(),
              pinnedMode: (document.querySelector('.cp-mode-item.is-pinned .cp-mode-tab') || {}).textContent,
            })`)}`,
          )
        }

        // 全彩矩形模式：整块色板，点矩形任意位置取色
        await evaluate(`[...document.querySelectorAll('.cp-mode-tab')][1]?.click()`)
        await wait(500)
        await capture(path.join(shotsDir, '19-color-picker-full.png'))
        writeSmokeLog(
          `[color-picker-full] ${await evaluate(`JSON.stringify({
            spectrum: Boolean(document.querySelector('.cp-spectrum')),
            activeMode: (document.querySelector('.cp-mode-item.is-active .cp-mode-tab') || {}).textContent,
            errors: window.__ERRORS__ || [],
          })`)}`,
        )
        // 进入全彩时记录光标初始位置（用于验证「恢复」后光标跟随回初始颜色）
        const spectrumCursorEntry = await evaluate(`(() => {
          const c = document.querySelector('.cp-spectrum-cursor')
          return JSON.stringify({ left: parseFloat(c.style.left), top: parseFloat(c.style.top) })
        })()`)
        // 色域图上下边缘取色：最底行必须是纯黑、最顶行必须是纯白，不能出现 010000 之类杂色
        const spectrumRectForEdges = JSON.parse(
          await evaluate(`(() => {
            const el = document.querySelector('.cp-spectrum')
            const rect = el.getBoundingClientRect()
            return JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
          })()`),
        )
        const sampleSpectrumHex = async (xRatio, y) => {
          const x = Math.round(spectrumRectForEdges.left + spectrumRectForEdges.width * xRatio)
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x, y })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
          await wait(180)
          return await evaluate(`(document.querySelector('.cp-hex') || {}).value`)
        }
        const bottomRow = []
        for (const ratio of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          bottomRow.push(await sampleSpectrumHex(ratio, Math.round(spectrumRectForEdges.top + spectrumRectForEdges.height - 1)))
        }
        const topRow = []
        for (const ratio of [0.1, 0.5, 0.9]) {
          topRow.push(await sampleSpectrumHex(ratio, Math.round(spectrumRectForEdges.top + 1)))
        }
        writeSmokeLog(
          `[color-picker-extremes] bottomAllBlack=${bottomRow.every((hex) => /^#000000/i.test(String(hex)))} topAllWhite=${topRow.every((hex) => /^#FFFFFF/i.test(String(hex)))} bottom=${bottomRow.join(',')} top=${topRow.join(',')}`,
        )

        // 极值色名：纯白 / 纯黑应叫「白色 / 黑色」
        await evaluate(`(document.querySelector('.cp-color-field .cp-field-swatch') || {click(){}}).click()`)
        await wait(300)
        const topColorName = await evaluate(`(document.querySelector('.cp-color-preview-name') || {}).textContent || ''`)
        await evaluate(`(document.querySelector('.cp-color-field .cp-field-swatch') || {click(){}}).click()`)
        await wait(200)
        await sampleSpectrumHex(0.5, Math.round(spectrumRectForEdges.top + spectrumRectForEdges.height - 1))
        await evaluate(`(document.querySelector('.cp-color-field .cp-field-swatch') || {click(){}}).click()`)
        await wait(300)
        const bottomColorName = await evaluate(`(document.querySelector('.cp-color-preview-name') || {}).textContent || ''`)
        await evaluate(`(document.querySelector('.cp-color-field .cp-field-swatch') || {click(){}}).click()`)
        await wait(200)
        writeSmokeLog(`[color-picker-extreme-names] topName=${topColorName} bottomName=${bottomColorName}`)
        // 全彩光标：沿纵向从底部拖到顶部，光标应连续跟随鼠标且完整显示（不被面板裁剪）
        const spectrumRect = JSON.parse(
          await evaluate(`(() => {
            const el = document.querySelector('.cp-spectrum')
            if (!el) return 'null'
            const rect = el.getBoundingClientRect()
            return JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
          })()`),
        )
        if (spectrumRect) {
          const dragX = Math.round(spectrumRect.left + spectrumRect.width * 0.5)
          const dragStartY = Math.round(spectrumRect.top + spectrumRect.height * 0.95)
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: dragX, y: dragStartY })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: dragX, y: dragStartY, button: 'left', clickCount: 1 })
          let maxDevPx = 0
          let maxTopPercentDev = 0
          let allInside = true
          let spectrumOverflow = ''
          let spectrumRadius = ''
          for (const ratio of [0.95, 0.8, 0.6, 0.4, 0.2, 0.05]) {
            const pointerY = Math.round(spectrumRect.top + spectrumRect.height * ratio)
            mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: dragX, y: pointerY })
            await wait(140)
            const info = JSON.parse(
              await evaluate(`(() => {
                const s = document.querySelector('.cp-spectrum')
                const c = document.querySelector('.cp-spectrum-cursor')
                const cr = c.getBoundingClientRect()
                const pr = document.querySelector('.cp-popover').getBoundingClientRect()
                return JSON.stringify({
                  cx: (cr.left + cr.right) / 2,
                  cy: (cr.top + cr.bottom) / 2,
                  top: parseFloat(c.style.top),
                  rect: { top: cr.top, left: cr.left, bottom: cr.bottom, right: cr.right },
                  popover: { top: pr.top, left: pr.left, bottom: pr.bottom, right: pr.right },
                  overflow: getComputedStyle(s).overflow,
                  radius: getComputedStyle(s).borderRadius,
                })
              })()`),
            )
            maxDevPx = Math.max(maxDevPx, Math.hypot(info.cx - dragX, info.cy - pointerY))
            maxTopPercentDev = Math.max(maxTopPercentDev, Math.abs(info.top - ratio * 100))
            allInside =
              allInside &&
              info.rect.top >= info.popover.top &&
              info.rect.bottom <= info.popover.bottom &&
              info.rect.left >= info.popover.left &&
              info.rect.right <= info.popover.right
            spectrumOverflow = info.overflow
            spectrumRadius = info.radius
          }
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: dragX, y: dragStartY, button: 'left', clickCount: 1 })
          writeSmokeLog(
            `[color-picker-spectrum-drag] maxDevPx=${maxDevPx.toFixed(1)} maxTopPercentDev=${maxTopPercentDev.toFixed(2)} allInside=${allInside} overflow=${spectrumOverflow} radius=${spectrumRadius}`,
          )
        }
        // 边缘圆圈可拖动：光标停在面板顶部后，按住露在面板外侧的那一半圆圈往下拖
        if (spectrumRect) {
          const edgeX = Math.round(spectrumRect.left + spectrumRect.width * 0.35)
          const topY = Math.round(spectrumRect.top + spectrumRect.height * 0.02)
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: edgeX, y: topY })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: edgeX, y: topY, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: edgeX, y: topY, button: 'left', clickCount: 1 })
          await wait(250)
          const edgeInfo = JSON.parse(
            await evaluate(`(() => {
              const c = document.querySelector('.cp-spectrum-cursor')
              const cr = c.getBoundingClientRect()
              const s = document.querySelector('.cp-spectrum').getBoundingClientRect()
              const px = Math.round((cr.left + cr.right) / 2)
              const py = Math.round(cr.top + 2)
              const hit = document.elementFromPoint(px, py)
              return JSON.stringify({ px, py, spectrumTop: s.top, hitClass: String((hit && hit.className) || '') })
            })()`),
          )
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: edgeInfo.px, y: edgeInfo.py })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: edgeInfo.px, y: edgeInfo.py, button: 'left', clickCount: 1 })
          const edgeTargetY = Math.round(spectrumRect.top + spectrumRect.height * 0.5)
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: edgeInfo.px, y: edgeTargetY })
          await wait(250)
          const edgeMove = JSON.parse(
            await evaluate(`(() => {
              const c = document.querySelector('.cp-spectrum-cursor')
              const cr = c.getBoundingClientRect()
              return JSON.stringify({ cy: (cr.top + cr.bottom) / 2, top: parseFloat(c.style.top) })
            })()`),
          )
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: edgeInfo.px, y: edgeTargetY, button: 'left', clickCount: 1 })
          writeSmokeLog(
            `[color-picker-spectrum-edge-drag] outsidePanel=${edgeInfo.py < edgeInfo.spectrumTop} hit=${edgeInfo.hitClass} movedDevPx=${Math.abs(edgeMove.cy - edgeTargetY).toFixed(1)} top=${edgeMove.top}`,
          )
        }
        // 点「恢复」后，全彩光标也应回到初始颜色的位置
        const cursorBeforeRestore = await evaluate(`(() => {
          const c = document.querySelector('.cp-spectrum-cursor')
          return JSON.stringify({ left: parseFloat(c.style.left), top: parseFloat(c.style.top) })
        })()`)
        await evaluate(`(document.querySelector('.cp-restore-btn') || {click(){}}).click()`)
        await wait(400)
        const cursorAfterRestore = await evaluate(`(() => {
          const c = document.querySelector('.cp-spectrum-cursor')
          return JSON.stringify({ left: parseFloat(c.style.left), top: parseFloat(c.style.top) })
        })()`)
        writeSmokeLog(
          `[color-picker-spectrum-restore] entry=${spectrumCursorEntry} before=${cursorBeforeRestore} after=${cursorAfterRestore} backToInitial=${(() => {
            const entry = JSON.parse(spectrumCursorEntry)
            const after = JSON.parse(cursorAfterRestore)
            return Math.abs(after.left - entry.left) < 1 && Math.abs(after.top - entry.top) < 1
          })()}`,
        )
        const spectrumPoint = JSON.parse(
          await evaluate(`(() => {
            const el = document.querySelector('.cp-spectrum')
            if (!el) return 'null'
            const rect = el.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(rect.left + rect.width * 0.7), y: Math.round(rect.top + rect.height * 0.7) })
          })()`),
        )
        if (spectrumPoint) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: spectrumPoint.x, y: spectrumPoint.y })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: spectrumPoint.x, y: spectrumPoint.y, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: spectrumPoint.x, y: spectrumPoint.y, button: 'left', clickCount: 1 })
          await wait(500)
          const fullHex = await evaluate(`(document.querySelector('.cp-hex') || {}).value`)
          const fullMatch = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})/i.exec(String(fullHex))
          // 点击位置约 hue 252°、亮度 30%：蓝色分量应最高
          const blueDominant = fullMatch
            ? parseInt(fullMatch[3], 16) > parseInt(fullMatch[1], 16) &&
              parseInt(fullMatch[3], 16) > parseInt(fullMatch[2], 16)
            : false
          writeSmokeLog(`[color-picker-full-click] hex=${fullHex} blueDominant=${blueDominant}`)
        }

        // 点击选中 tab 的 pin 设为默认，然后关闭重开验证默认模式被记住（全彩）
        await evaluate(`(document.querySelector('.cp-mode-item.is-active .cp-mode-pin') || {click(){}}).click()`)
        await wait(250)
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await wait(300)
        await evaluate(`document.querySelector('.modal .cp-trigger')?.click()`)
        await wait(500)
        writeSmokeLog(
          `[color-picker-default-mode] ${await evaluate(`JSON.stringify({
            activeMode: (document.querySelector('.cp-mode-item.is-active .cp-mode-tab') || {}).textContent,
            spectrum: Boolean(document.querySelector('.cp-spectrum')),
            pinnedMode: (document.querySelector('.cp-mode-item.is-pinned .cp-mode-tab') || {}).textContent,
          })`)}`,
        )
        // 恢复默认色块模式
        await evaluate(`[...document.querySelectorAll('.cp-mode-tab')][2]?.click()`)
        await wait(250)
        await evaluate(`(document.querySelector('.cp-mode-item.is-active .cp-mode-pin') || {click(){}}).click()`)
        await wait(250)

        // ---- 应用方式：确认后同步（在全彩模式里点选，内部预览要变、外部不变） ----
        await evaluate(`[...document.querySelectorAll('.cp-apply-btn')][1]?.click()`)
        await wait(300)
        const beforeExternal = await evaluate(`(document.querySelector('.modal .hex-input') || {}).value`)
        await evaluate(`[...document.querySelectorAll('.cp-mode-tab')][1]?.click()`)
        await wait(500)
        const confirmPoint = JSON.parse(
          await evaluate(`(() => {
            const el = document.querySelector('.cp-spectrum')
            if (!el) return 'null'
            const rect = el.getBoundingClientRect()
            return JSON.stringify({ x: Math.round(rect.left + rect.width * 0.62), y: Math.round(rect.top + rect.height * 0.38) })
          })()`),
        )
        if (confirmPoint) {
          mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: confirmPoint.x, y: confirmPoint.y })
          mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: confirmPoint.x, y: confirmPoint.y, button: 'left', clickCount: 1 })
          mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: confirmPoint.x, y: confirmPoint.y, button: 'left', clickCount: 1 })
          await wait(500)
        }
        const pendingHex = await evaluate(`(document.querySelector('.cp-hex') || {}).value`)
        const previewFill = await evaluate(`(getComputedStyle(document.querySelector('.cp-color-field .cp-field-swatch') || document.body).backgroundColor)`)
        await capture(path.join(shotsDir, '20-color-picker-confirm.png'))
        writeSmokeLog(
          `[color-picker-apply-mode] ${await evaluate(`JSON.stringify({
            mode: ([...document.querySelectorAll('.cp-apply-btn')].find((b) => b.classList.contains('is-active')) || {}).textContent,
            actions: Boolean(document.querySelector('.cp-actions')),
            externalUnchanged: ${JSON.stringify(beforeExternal)} === (document.querySelector('.modal .hex-input') || {}).value,
            restoreActive: !(document.querySelector('.cp-restore-btn') || {}).disabled,
          })`)}`,
        )
        writeSmokeLog(`[color-picker-confirm-full] pending=${pendingHex} previewFill=${previewFill}`)
        await evaluate(`(document.querySelector('.cp-actions .cp-btn-primary') || {click(){}}).click()`)
        await wait(500)
        const afterApply = await evaluate(`(document.querySelector('.modal .hex-input') || {}).value`)
        writeSmokeLog(
          `[color-picker-confirm-apply] before=${beforeExternal} pending=${pendingHex} afterApply=${afterApply} closed=${await evaluate(`!document.querySelector('.cp-popover')`)} match=${afterApply === pendingHex}`,
        )

        // 重新打开：应用方式应记住「确认后」；测试取消不写回
        await evaluate(`document.querySelector('.modal .cp-trigger')?.click()`)
        await wait(400)
        writeSmokeLog(
          `[color-picker-apply-mode-persist] ${await evaluate(`JSON.stringify({
            mode: ([...document.querySelectorAll('.cp-apply-btn')].find((b) => b.classList.contains('is-active')) || {}).textContent,
          })`)}`,
        )
        const beforeCancel = await evaluate(`(document.querySelector('.modal .hex-input') || {}).value`)
        await evaluate(`[...document.querySelectorAll('.cp-mode-tab')][2]?.click()`)
        await wait(300)
        await evaluate(`document.querySelectorAll('.cp-grid-cell')[40]?.click()`)
        await wait(300)
        const cancelPending = await evaluate(`(document.querySelector('.cp-hex') || {}).value`)
        await evaluate(`(document.querySelector('.cp-actions .cp-btn-ghost') || {click(){}}).click()`)
        await wait(400)
        const afterCancel = await evaluate(`(document.querySelector('.modal .hex-input') || {}).value`)
        writeSmokeLog(
          `[color-picker-confirm-cancel] before=${beforeCancel} pending=${cancelPending} after=${afterCancel} unchanged=${beforeCancel === afterCancel}`,
        )
        await evaluate(`document.querySelector('.modal-header .icon-btn')?.click()`)
        await wait(400)

        const errors = await evaluate(`JSON.stringify(window.__ERRORS__ || [])`)
        writeSmokeLog(`[renderer-errors] ${errors}`)
      }
    } catch (err) {
      writeSmokeLog(`[screenshot-error] ${String(err && err.stack ? err.stack : err)}`)
    }
    app.quit()
  })

  const sendMaxState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaxState)
  mainWindow.on('unmaximize', sendMaxState)
  mainWindow.on('enter-full-screen', sendMaxState)
  mainWindow.on('leave-full-screen', sendMaxState)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('close', () => {
    if (!screenshotPath && !shotsDir) writeWindowState(mainWindow)
  })
  mainWindow.on('closed', () => {
    // 主窗口关闭时一并关闭独立预览窗口，避免应用残留
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close()
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('state:load', async () => readState())

ipcMain.handle('state:save', async (_event, state) => {
  if (!state || typeof state !== 'object') return { ok: false, error: 'invalid state' }
  try {
    return await writeState(state)
  } catch (err) {
    console.error('[state:save]', err)
    return { ok: false, error: String(err) }
  }
})

ipcMain.handle('state:reveal', async () => {
  const dir = dataDir()
  await fsp.mkdir(dir, { recursive: true })
  shell.openPath(dir)
  return { ok: true, path: dir }
})

ipcMain.handle('file:save', async (_event, options) => {
  const { content, defaultPath, filters } = options || {}
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出文件',
    defaultPath: defaultPath || 'palette.css',
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  await fsp.writeFile(result.filePath, String(content ?? ''), 'utf8')
  return { canceled: false, filePath: result.filePath }
})

ipcMain.handle('file:open', async (_event, options) => {
  const { filters } = options || {}
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入文件',
    properties: ['openFile'],
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePaths.length) return { canceled: true }
  const filePath = result.filePaths[0]
  const content = await fsp.readFile(filePath, 'utf8')
  return { canceled: false, filePath, content }
})

ipcMain.handle('clipboard:write', async (_event, text) => {
  clipboard.writeText(String(text ?? ''))
  return { ok: true }
})

// ---- 窗口控制（按事件来源窗口处理，主窗口与独立预览窗口都适用） ----

function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender)
}

ipcMain.handle('window:minimize', (event) => senderWindow(event)?.minimize())
ipcMain.handle('window:toggle-maximize', (event) => {
  const window = senderWindow(event)
  if (!window) return false
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
  return window.isMaximized()
})
ipcMain.handle('window:close', (event) => senderWindow(event)?.close())
ipcMain.handle('window:is-maximized', (event) => Boolean(senderWindow(event)?.isMaximized()))
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  name: APP_NAME,
  dataPath: dataFile(),
  platform: process.platform,
  isDev,
}))
ipcMain.handle('app:toggle-devtools', (event) => {
  senderWindow(event)?.webContents.toggleDevTools()
})

// ---- 独立界面预览窗口 ----

ipcMain.handle('preview:open', () => createPreviewWindow())

ipcMain.handle('preview:close', () => {
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.close()
  return { ok: true }
})

ipcMain.handle('preview:is-open', () => Boolean(previewWindow && !previewWindow.isDestroyed()))

ipcMain.handle('preview:get-state', () => previewState)

// 主窗口推送预览状态（主题/明暗/设备）→ 缓存并转发给预览窗口
ipcMain.on('preview:update', (_event, payload) => {
  previewState = payload
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.webContents.send('preview:state', payload)
  }
})

// 预览窗口里切换明暗/设备 → 回传给主窗口执行设置更新
ipcMain.on('preview:set-mode', (_event, mode) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:set-mode', mode)
})

ipcMain.on('preview:set-device', (_event, device) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview:set-device', device)
})

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    nativeTheme.themeSource = 'dark'
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}
