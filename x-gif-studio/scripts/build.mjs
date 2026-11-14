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

// 渲染进程运行在 contextIsolation 沙箱中，没有 Node 的 process 全局对象；
// 依赖（React 等）通过 process.env.NODE_ENV 选择开发/生产实现，直接在打包期替换掉，
// 避免运行时报 "process is not defined" 导致白屏。
const replaceProcessEnv = {
  name: 'replace-process-env',
  transform(code) {
    if (!code.includes('process.env.NODE_ENV')) return null
    return { code: code.replace(/process\.env\.NODE_ENV/g, JSON.stringify('production')), map: null }
  },
}

fs.rmSync(path.join(BUILD, 'app'), { recursive: true, force: true })
fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(DIST, { recursive: true })

log('编译 TypeScript…')
const result = compileProject(root, APP_OUT)
if (!reportDiagnostics(result)) process.exit(1)

log('打包渲染进程…')
const bundle = await rollup({
  input: path.join(APP_OUT, 'main.js'),
  plugins: [
    nodeResolve({ browser: true, extensions: ['.js', '.mjs', '.cjs', '.json'], preferBuiltins: false }),
    commonjs({ include: [/\.js$/, /node_modules/], transformMixedEsModules: true }),
    replaceProcessEnv,
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
  name: 'XMediaStudio',
  inlineDynamicImports: true,
  sourcemap: false,
})
await bundle.close()

const rawCode = generated.output[0].code
const beforeKb = (Buffer.byteLength(rawCode) / 1024).toFixed(1)
const minified = await minify(rawCode, {
  compress: { passes: 2, drop_debugger: true },
  mangle: true,
  format: { comments: false },
})
const outputCode = minified.code ?? rawCode
fs.writeFileSync(path.join(DIST, 'assets', 'app.js'), outputCode, 'utf8')

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
  styleLinks.push('    <link rel="stylesheet" href="./' + rel.split(path.sep).join('/') + '" />')
}

const templatePath = path.join(root, 'src', 'index.html')
if (!fs.existsSync(templatePath)) {
  console.error('[build] 缺少 src/index.html')
  process.exit(1)
}
const template = fs.readFileSync(templatePath, 'utf8')
const appTag = '<script src="./assets/app.js"></script>'
let html
if (template.includes('<!-- STYLES -->') || template.includes('<!-- APP -->')) {
  html = template
    .replace('<!-- STYLES -->', styleLinks.join('\n'))
    .replace('<!-- APP -->', appTag)
} else {
  // 模板没有占位注释时兜底注入，避免渲染进程调整 index.html 后构建失败
  html = template
    .replace('</head>', styleLinks.join('\n') + '\n  </head>')
    .replace('</body>', '    ' + appTag + '\n  </body>')
}
if (!html.includes('assets/app.js')) {
  console.error('[build] 注入 app.js 失败：src/index.html 需包含 <!-- APP --> 占位注释或 </body> 标签')
  process.exit(1)
}
fs.writeFileSync(path.join(DIST, 'index.html'), html, 'utf8')

const sizeKb = (fs.statSync(path.join(DIST, 'assets', 'app.js')).size / 1024).toFixed(1)
log('完成：dist/index.html, dist/assets/app.js (' + sizeKb + ' KB，压缩前 ' + beforeKb + ' KB)，' + cssFiles.length + ' 个样式文件，用时 ' + (Date.now() - started) + ' ms')
if (cssFiles.length > 0) log('样式：' + cssFiles.map((file) => path.relative(path.join(root, 'src'), file)).join(', '))