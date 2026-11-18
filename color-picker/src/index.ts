/**
 * 取色器独立库入口。
 *
 * - 默认入口（`.`)：React 组件 `ColorPicker` + 全部纯函数色彩工具；
 * - `./core`：只包含纯计算（颜色数学、中文色名、OKLCH 全彩色域图），不引入 React / DOM；
 * - `./styles.css`：组件样式。
 */
export { ColorPicker, PRESET_VIVID, PRESET_NEUTRAL, DEFAULT_STORAGE_PREFIX } from './components/ColorPicker'
export type {
  ColorPickerProps,
  PickerMode,
  ApplyMode,
  PickerTab,
  PickerTheme,
} from './components/ColorPicker'
export { buildSpectrumImage, resetSpectrumImageCache } from './spectrum-image'
export * from './core'
