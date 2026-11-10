import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'
import { rollup } from 'rollup'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { minify } from 'terser'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const BUILD = '.build'
const APP_OUT = path.join(BUILD, 'app')
const DIST = 'dist'

const log = (...args) => console.log('[build]', ...args)
const started = Date.now()

// 1) 清理（只清自己的产物目录，避免与并行运行的测试/类型检查互相干扰）
fs.rmSync(path.join(BUILD, 'app'), { recursive: true, force: true })
fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(DIST, { recursive: true })

// 2) TypeScript 编译（CommonJS 输出，供 Rollup 打包 + 测试直接 require）
log('编译 TypeScript…')
const result = compileProject(root, APP_OUT)
if (!reportDiagnostics(result)) process.exit(1)

// 3) Rollup 打包为单文件 IIFE
log('打包渲染进程…')
const bundle = await rollup({
  input: path.join(APP_OUT, 'main.js'),
  plugins: [
    nodeResolve({ browser: true, extensions: ['.js', '.mjs', '.cjs', '.json'], preferBuiltins: false }),
    commonjs({ include: [/\.js$/, /node_modules/], transformMixedEsModules: true }),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') return
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
    warn(warning)
  },
})
fs.mkdirSync(path.join(DIST, 'assets'), { recursive: true })
const generated = await bundle.generate({
  format: 'iife',
  name: 'PaletteStudio',
  inlineDynamicImports: true,
  sourcemap: false,
})
await bundle.close()

// 压缩产物（Terser 为纯 JS 实现，不依赖子进程）
const rawCode = generated.output[0].code
const beforeKb = (Buffer.byteLength(rawCode) / 1024).toFixed(1)
const minified = await minify(rawCode, {
  compress: { passes: 2, drop_debugger: true },
  mangle: true,
  format: { comments: false },
})
const outputCode = minified.code ?? rawCode
fs.writeFileSync(path.join(DIST, 'assets', 'app.js'), outputCode, 'utf8')

// 4) 收集并复制 CSS（src 下所有 .css，保留相对路径），自动注入 index.html
function walk(dir, filter, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, filter, acc)
    else if (filter(full)) acc.push(full)
  }
  return acc
}

const cssFiles = walk(path.join(root, 'src'), (file) => file.endsWith('.css')).sort((a, b) => {
  const pa = path.relative(root, a)
  const pb = path.relative(root, b)
  if (pa.includes('global.css')) return -1
  if (pb.includes('global.css')) return 1
  return pa.localeCompare(pb)
})
const styleLinks = []
for (const cssFile of cssFiles) {
  const rel = path.relative(path.join(root, 'src'), cssFile)
  const dest = path.join(DIST, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(cssFile, dest)
  styleLinks.push(`    <link rel="stylesheet" href="./${rel.split(path.sep).join('/')}" />`)
}

// 5) 生成 index.html
const template = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')
const html = template
  .replace('<!-- STYLES -->', styleLinks.join('\n'))
  .replace('<!-- APP -->', '<script src="./assets/app.js"></script>')
fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8')

const sizeKb = (fs.statSync(path.join(DIST, 'assets', 'app.js')).size / 1024).toFixed(1)
log(`完成：dist/index.html, dist/assets/app.js (${sizeKb} KB，压缩前 ${beforeKb} KB), ${cssFiles.length} 个样式文件，用时 ${Date.now() - started} ms`)
