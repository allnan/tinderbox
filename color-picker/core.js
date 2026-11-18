/**
 * 兼容入口（CommonJS）：
 * 一些旧工具或 `moduleResolution: "node"` 的 TypeScript 项目不认识 package.json 的
 * `exports` 子路径，会把 `@tinderbox/color-picker/core` 解析到这个文件。
 * 现代解析器请使用 `exports` 指向的 `dist/core.mjs` / `dist/core.cjs`。
 */
module.exports = require('./dist/core.cjs')
