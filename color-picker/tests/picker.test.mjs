import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/**
 * 组件 DOM 测试：在 jsdom 里真实挂载 React 组件，验证打开浮层、切换模式、
 * 确认模式不写回、应用后写回、颜色小窗与主题属性。
 *
 * 注意：必须在挂载组件之前把 jsdom 的 window/document 放到全局，组件内部会直接使用
 * document / getComputedStyle / window.EyeDropper 等浏览器 API。
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom

// Node 22 的 globalThis.navigator / localStorage 是只读 getter，必须用 defineProperty 覆盖
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Node: window.Node,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  localStorage: window.localStorage,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
}
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom 没有 canvas 实现，getContext 会打印 "Not implemented" 并返回 null。
// 这里直接返回 null，既保持安静，也顺带验证取色器在无 canvas 环境下的降级路径。
window.HTMLCanvasElement.prototype.getContext = () => null

test.afterEach(() => {
  document.body.innerHTML = ''
})

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { ColorPicker } = await import('../dist/index.mjs')
const { act } = React

function renderPicker(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root, mount: (next) => act(async () => root.render(React.createElement(ColorPicker, next))) }
}

test('打开浮层、切换色块模式、确认模式不写回、应用后写回', async () => {
  window.localStorage.clear()
  const changes = []
  const picker = renderPicker()
  await picker.mount({ value: '#0097BB', onChange: (hex) => changes.push(hex), storagePrefix: 'test' })

  const trigger = document.querySelector('.cp-trigger')
  assert.ok(trigger, '应渲染触发色块')
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')

  await act(async () => trigger.click())
  assert.ok(document.querySelector('.cp-popover'), '点击后应打开浮层')
  assert.equal(document.querySelectorAll('.cp-mode-tab').length, 3)
  assert.equal(document.querySelectorAll('.cp-mode-tab')[1].getAttribute('aria-selected'), 'true', '首次默认全彩')
  assert.ok(document.querySelector('.cp-actions'), '默认应用方式为确认后')

  const gridTab = document.querySelectorAll('.cp-mode-tab')[2]
  await act(async () => gridTab.click())
  const cells = document.querySelectorAll('.cp-grid-cell')
  assert.equal(cells.length, 72, '12×5 + 12 档灰阶')

  // 第一格是 hsv(0,100,100) = #FF0000
  await act(async () => cells[0].click())
  assert.equal(changes.length, 0, '确认模式下不应立即写回')

  const rgbInputs = document.querySelectorAll('.cp-rgb-input')
  assert.equal(rgbInputs[0].value, '255', 'RGB 读数应跟随内部预览（独立时修正）')
  assert.equal(rgbInputs[1].value, '0')
  assert.equal(rgbInputs[2].value, '0')

  const apply = [...document.querySelectorAll('.cp-actions button')].find((button) => button.textContent === '应用')
  assert.ok(apply)
  await act(async () => apply.click())
  assert.deepEqual(changes, ['#FF0000'])
  assert.equal(document.querySelector('.cp-popover'), null, '应用后应关闭')

  await act(async () => picker.root.unmount())
  picker.container.remove()
})

test('颜色小窗显示中文色名与 HEX', async () => {
  window.localStorage.clear()
  const picker = renderPicker()
  await picker.mount({ value: '#0097BB', onChange: () => {}, storagePrefix: 'info' })
  const trigger = document.querySelector('.cp-trigger')
  await act(async () => trigger.click())
  const swatch = document.querySelector('.cp-field-swatch')
  await act(async () => swatch.click())
  const preview = document.querySelector('.cp-color-preview')
  assert.ok(preview, '应展开颜色小窗')
  const name = preview.textContent.replace('#0097BB', '').trim()
  assert.ok(name.length > 0, `应显示中文色名，实际内容：${preview.textContent}`)
  assert.match(preview.textContent, /#0097BB/)
  await act(async () => swatch.click())
  assert.equal(document.querySelector('.cp-color-preview'), null, '再点应收起')

  await act(async () => picker.root.unmount())
  picker.container.remove()
})

test('立即模式选色即同步，并记录最近颜色', async () => {
  window.localStorage.clear()
  window.localStorage.setItem('live:color-picker-apply-mode', 'live')
  const changes = []
  const picker = renderPicker()
  await picker.mount({ value: '#0097BB', onChange: (hex) => changes.push(hex), storagePrefix: 'live' })
  await act(async () => document.querySelector('.cp-trigger').click())
  await act(async () => document.querySelectorAll('.cp-mode-tab')[2].click())
  await act(async () => document.querySelectorAll('.cp-grid-cell')[0].click())
  assert.equal(changes.at(-1), '#FF0000')

  // 最近颜色在「点色板 / 输入 HEX / 吸管 / 应用确认」时记录；切回「常用」点第一个色块
  await act(async () => document.querySelectorAll('.cp-tab')[0].click())
  await act(async () => document.querySelectorAll('.cp-swatch')[0].click())
  assert.equal(changes.at(-1), '#EF4444')
  const recent = JSON.parse(window.localStorage.getItem('live:recent-colors'))
  assert.equal(recent[0], '#EF4444')

  await act(async () => picker.root.unmount())
  picker.container.remove()
})

test('主题属性与默认打开', async () => {
  window.localStorage.clear()
  const picker = renderPicker()
  await picker.mount({ value: '#0097BB', onChange: () => {}, storagePrefix: 'theme', theme: 'dark', defaultOpen: true })
  const popover = document.querySelector('.cp-popover')
  assert.ok(popover, 'defaultOpen 应直接打开')
  assert.equal(popover.getAttribute('data-cp-theme'), 'dark')
  assert.equal(document.querySelector('.cp-trigger').getAttribute('data-cp-theme'), 'dark')

  await act(async () => picker.root.unmount())
  picker.container.remove()
})
