/**
 * 取色器演示页：同时演示触发色块、三种取色方式、主题切换与 OKLCH 全彩色域图。
 * 通过 `?theme=dark` 切深色、`?open=full` 让全彩取色器首次打开（截图用）。
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ColorPicker, buildSpectrumImage } from '../src/index'
import type { PickerTheme } from '../src/index'

type PageTheme = 'light' | 'dark'

const params = new URLSearchParams(window.location.search)
const initialTheme: PageTheme = params.get('theme') === 'dark' ? 'dark' : 'light'
const autoOpen = params.get('open') === 'full'

function SpectrumFigure() {
  const [src, setSrc] = useState('')
  useEffect(() => {
    setSrc(buildSpectrumImage())
  }, [])
  return (
    <figure className="demo-spectrum">
      {src ? (
        <img src={src} alt="OKLCH 全彩色域图：横轴色相，纵轴明度" />
      ) : (
        <div className="demo-spectrum-empty">当前环境不支持 canvas，无法生成色域图</div>
      )}
      <figcaption>
        横轴色相 0°–360°，纵轴感知明度 L 1→0；每个像素取该位置 sRGB 能显示的最大色度，所以整张图都是「该明度下最鲜艳的颜色」。
      </figcaption>
    </figure>
  )
}

function TriggerRow({ theme, appTheme }: { theme: PickerTheme; appTheme: PageTheme }) {
  const [color, setColor] = useState('#0097BB')
  const [other, setOther] = useState('#F97316')
  return (
    <div className="demo-stage">
      <div className="demo-triggers">
        <ColorPicker value={color} onChange={setColor} storagePrefix="demo-trigger" theme={appTheme} size={46} />
        <ColorPicker value={color} onChange={setColor} storagePrefix="demo-trigger" theme={appTheme} size={34} />
        <ColorPicker
          value={other}
          onChange={setOther}
          storagePrefix="demo-trigger"
          theme={appTheme}
          size={34}
          showTriggerLabel
        />
        <div className="demo-readout">
          当前颜色 <code>{color}</code>
        </div>
      </div>
      <p className="demo-note">点击色块打开取色器；带 HEX 文本的触发块适合同一行展示。演示主题：{theme}</p>
    </div>
  )
}

function ModeRow({ appTheme }: { appTheme: PageTheme }) {
  const [gridColor, setGridColor] = useState('#22C55E')
  const [panelColor, setPanelColor] = useState('#3B82F6')
  return (
    <div className="demo-two-col">
      <div className="demo-subcard">
        <h3>色块模式</h3>
        <p>12 色相 × 5 档明度 + 12 档灰阶，单击即选。</p>
        <div className="demo-inline">
          <ColorPicker value={gridColor} onChange={setGridColor} storagePrefix="demo-grid" theme={appTheme} defaultMode="grid" size={40} />
          <code>{gridColor}</code>
        </div>
      </div>
      <div className="demo-subcard">
        <h3>面板模式</h3>
        <p>HSV 的饱和度/明度面板 + 色相条，适合精细微调。</p>
        <div className="demo-inline">
          <ColorPicker value={panelColor} onChange={setPanelColor} storagePrefix="demo-panel" theme={appTheme} defaultMode="panel" size={40} />
          <code>{panelColor}</code>
        </div>
      </div>
    </div>
  )
}

function App() {
  const [theme, setTheme] = useState<PageTheme>(initialTheme)
  const [fullColor, setFullColor] = useState('#0097BB')

  useEffect(() => {
    document.documentElement.dataset.demoTheme = theme
  }, [theme])

  return (
    <div className={theme === 'dark' ? 'demo-shell is-dark' : 'demo-shell'}>
      <header className="demo-header">
        <div className="demo-heading">
          <p className="demo-eyebrow">Tinderbox · 独立组件</p>
          <h1>
            取色器 <span>Color Picker</span>
          </h1>
          <p className="demo-lede">
            从「配色工坊」独立出来的设计参考实现。面板 / OKLCH 全彩 / 色块三种取色方式合在同一个浮层里，
            支持透明度、中文色名、常用与最近颜色，以及「立即 / 确认后」两种应用方式。
          </p>
          <ul className="demo-chips">
            <li>零第三方依赖</li>
            <li>三种取色方式</li>
            <li>OKLCH 全彩色域图</li>
            <li>#RRGGBBAA</li>
            <li>深浅主题</li>
          </ul>
        </div>
        <div className="demo-theme-switch" role="group" aria-label="切换演示主题">
          <button type="button" className={theme === 'light' ? 'is-active' : ''} onClick={() => setTheme('light')}>
            浅色
          </button>
          <button type="button" className={theme === 'dark' ? 'is-active' : ''} onClick={() => setTheme('dark')}>
            深色
          </button>
        </div>
      </header>

      <main className="demo-main">
        <section className="demo-card">
          <div className="demo-card-head">
            <h2>全彩取色</h2>
            <span className="demo-tag">OKLCH 色域切片</span>
          </div>
          <p className="demo-card-desc">
            横向选色相、纵向选明度，每个点都是 sRGB 在该位置能显示的最鲜艳颜色。光标直接跟随指针坐标，
            接近黑/白时不会因为色相不稳定而跳动。
          </p>
          <div className="demo-stage">
            <div className="demo-inline">
              <ColorPicker
                value={fullColor}
                onChange={setFullColor}
                storagePrefix="demo-full"
                defaultMode="full"
                theme={theme}
                defaultOpen={autoOpen}
                size={46}
              />
              <code>{fullColor}</code>
            </div>
            <p className="demo-note">点击色块打开；顶部「全彩」tab 上方的图钉可把它设为下次默认。</p>
          </div>
        </section>

        <section className="demo-card">
          <div className="demo-card-head">
            <h2>触发色块与头部</h2>
            <span className="demo-tag">Trigger / Header</span>
          </div>
          <p className="demo-card-desc">
            触发按钮是方形色块（右下角带吸管角标），可配置边长或在右侧显示 HEX。浮层头部的顺序固定为
            当前颜色 → 初始颜色 → 恢复 → 吸管。
          </p>
          <TriggerRow theme={theme} appTheme={theme} />
        </section>

        <section className="demo-card">
          <div className="demo-card-head">
            <h2>色块与面板</h2>
            <span className="demo-tag">Grid / Panel</span>
          </div>
          <p className="demo-card-desc">
            色块模式一格一个颜色，不必在细滑条上瞄准；面板模式保留 HSV 的连续微调。两种方式与全彩共用同一块画布区域。
          </p>
          <ModeRow appTheme={theme} />
        </section>

        <section className="demo-card">
          <div className="demo-card-head">
            <h2>OKLCH 全彩色域图</h2>
            <span className="demo-tag">720 × 360</span>
          </div>
          <p className="demo-card-desc">
            下面这张图就是取色器「全彩」模式使用的底图，由 <code>buildSpectrumImage()</code> 在首次进入全彩模式时生成并缓存。
          </p>
          <SpectrumFigure />
        </section>

        <section className="demo-card demo-code-card">
          <div className="demo-card-head">
            <h2>接入方式</h2>
            <span className="demo-tag">npm / 本地引用</span>
          </div>
          <pre className="demo-code">
{`import { ColorPicker } from '@tinderbox/color-picker'
import '@tinderbox/color-picker/styles.css'

<ColorPicker
  value={color}
  onChange={setColor}
  storagePrefix="my-app"
/>`}
          </pre>
          <p className="demo-note">
            详细 Props、主题令牌与 Electron / Tauri 接入见 <code>docs/使用说明.md</code>。
          </p>
        </section>
      </main>

      <footer className="demo-footer">
        <span>配色工坊取色器 · 独立存档</span>
        <span>零第三方色彩依赖 · React 19 + TypeScript</span>
      </footer>
    </div>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root')
createRoot(container).render(<App />)
