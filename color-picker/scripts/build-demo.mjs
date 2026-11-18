import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { rollup } from 'rollup'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { compileFiles, reportDiagnostics } from './lib/ts-compile.mjs'

/**
 * 构建演示页：把 demo/main.tsx 和 src 一起编译，再由 Rollup 打成单个 IIFE
 * （React 也打进包里，双击 demo/index.html 或 http 静态服务都能直接打开）。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const OUT = 'demo/dist'
const log = (...args) => console.log('[demo]', ...args)

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const sourceFiles = walk(path.join(root, 'src')).filter((file) => /\.(ts|tsx)$/.test(file))
const demoFiles = walk(path.join(root, 'demo')).filter((file) => /\.(ts|tsx)$/.test(file) && !file.includes(`${path.sep}dist${path.sep}`))
const files = [...sourceFiles, ...demoFiles]

log(`编译 ${files.length} 个源文件…`)
const compiled = compileFiles(root, files, '.build/demo', {
  rootDir: '.',
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: false,
  declarationMap: false,
  emitDeclarationOnly: false,
  noEmit: false,
})
if (!reportDiagnostics(compiled, '演示页')) process.exit(1)

log('打包演示页…')
const bundle = await rollup({
  input: path.join(root, '.build/demo/demo/main.js'),
  plugins: [
    // 构建期固定为 production，Rollup 才能摇掉 React 的开发分支（演示包体积约减一个量级）
    {
      name: 'define-process-env',
      transform(code) {
        if (!code.includes('process.env.NODE_ENV')) return null
        return { code: code.replaceAll('process.env.NODE_ENV', '"production"'), map: null }
      },
    },
    nodeResolve({ browser: true, extensions: ['.js', '.mjs', '.cjs', '.json'], preferBuiltins: false }),
    commonjs({ include: [/\.js$/, /node_modules/], transformMixedEsModules: true }),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') return
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
    warn(warning)
  },
})
const generated = await bundle.generate({ format: 'iife', name: 'ColorPickerDemo', inlineDynamicImports: true, sourcemap: false })
await bundle.close()
fs.writeFileSync(path.join(OUT, 'demo.js'), generated.output[0].code, 'utf8')

fs.copyFileSync(path.join(root, 'src', 'components', 'color-picker.css'), path.join(OUT, 'color-picker.css'))
fs.copyFileSync(path.join(root, 'demo', 'demo.css'), path.join(OUT, 'demo.css'))

const sizeKb = (fs.statSync(path.join(OUT, 'demo.js')).size / 1024).toFixed(1)
log(`完成：demo/index.html + demo/dist/demo.js（${sizeKb} KB）+ 2 个样式文件`)
log('打开方式：直接双击 demo/index.html，或 npm run serve 后访问 http://127.0.0.1:4173/')
