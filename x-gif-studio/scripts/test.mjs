import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const OUT = path.join('.build', 'test-app-' + process.pid)
const require = createRequire(import.meta.url)
let failed = false

console.log('[test] 编译 TS 单元测试…')
const result = compileProject(root, OUT)
if (!reportDiagnostics(result)) process.exit(1)

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.name.endsWith('.test.js')) acc.push(full)
  }
  return acc
}

const testFiles = walk(OUT).sort()
globalThis.__XGIF_TESTS__ = []
for (const file of testFiles) {
  try {
    require(path.resolve(file))
  } catch (err) {
    console.error('[test] 加载测试文件失败：' + file)
    console.error(err)
    failed = true
  }
}

const cases = globalThis.__XGIF_TESTS__ || []
let passed = 0
const failures = []
for (const item of cases) {
  try {
    const value = item.fn()
    if (value && typeof value.then === 'function') {
      throw new Error('测试函数不能是 async（请使用同步断言）')
    }
    passed += 1
  } catch (err) {
    failures.push({ name: item.name, message: err && err.message ? err.message : String(err) })
  }
}
for (const failure of failures) console.error('  ✗ ' + failure.name + '\n    ' + failure.message)
console.log('[test] src/core：' + passed + '/' + cases.length + ' 通过' + (failures.length ? '，' + failures.length + ' 失败' : ' ✓'))
if (failures.length) failed = true

// 主进程引擎测试：tests/ 下的 node:test 文件
const engineFiles = walk(path.join(root, 'tests')).filter((file) => file.endsWith('.test.mjs') || file.endsWith('.test.js'))
if (engineFiles.length > 0) {
  console.log('[test] 运行主进程引擎测试（' + engineFiles.length + ' 个文件）…')
  const child = spawnSync(process.execPath, ['--test', ...engineFiles.map((file) => path.relative(root, file))], {
    cwd: root,
    stdio: 'inherit',
  })
  if (child.status !== 0) failed = true
} else {
  console.log('[test] tests/ 下暂无 node:test 文件')
}

process.exit(failed ? 1 : 0)
