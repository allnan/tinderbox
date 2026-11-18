import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { rollup } from 'rollup'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'

/**
 * 构建独立库：
 * 1. TypeScript 编译到 .build/js（ESM，供 Rollup 打包）；
 * 2. Rollup 打包 index / core 两个入口，输出 ESM（.mjs）与 CommonJS（.cjs）；
 * 3. TypeScript 只输出声明文件到 dist；
 * 4. 复制取色器 CSS 到 dist/color-picker.css。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const BUILD = '.build/js'
const DIST = 'dist'
const log = (...args) => console.log('[build]', ...args)
const started = Date.now()

fs.rmSync(BUILD, { recursive: true, force: true })
fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(DIST, { recursive: true })

// 1) 编译 JS
log('编译 TypeScript（ESM）…')
const compiled = compileProject(root, BUILD, {
  overrides: {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
  },
})
if (!reportDiagnostics(compiled)) process.exit(1)

// 2) 打包两个入口
const external = (id) =>
  id === 'react' ||
  id === 'react-dom' ||
  id.startsWith('react/') ||
  id.startsWith('react-dom/')

const entries = [
  { name: 'index', input: path.join(BUILD, 'index.js') },
  { name: 'core', input: path.join(BUILD, 'core', 'index.js') },
]

for (const entry of entries) {
  log(`打包 ${entry.name}…`)
  const bundle = await rollup({
    input: entry.input,
    external,
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
  const esm = await bundle.generate({ format: 'es', sourcemap: false })
  const cjs = await bundle.generate({ format: 'cjs', exports: 'named', sourcemap: false })
  await bundle.close()
  fs.writeFileSync(path.join(DIST, `${entry.name}.mjs`), esm.output[0].code, 'utf8')
  fs.writeFileSync(path.join(DIST, `${entry.name}.cjs`), cjs.output[0].code, 'utf8')
}

// 3) 声明文件
log('输出类型声明…')
const declarations = compileProject(root, DIST, {
  overrides: {
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    // 保持 tsconfig 里的 module/moduleResolution 即可
  },
})
if (!reportDiagnostics(declarations, '声明文件')) process.exit(1)

// 4) CSS
fs.copyFileSync(path.join(root, 'src', 'components', 'color-picker.css'), path.join(DIST, 'color-picker.css'))

const sizes = fs
  .readdirSync(DIST, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `${entry.name} ${(fs.statSync(path.join(DIST, entry.name)).size / 1024).toFixed(1)} KB`)
log(`完成：${sizes.join('，')}；用时 ${Date.now() - started} ms`)
