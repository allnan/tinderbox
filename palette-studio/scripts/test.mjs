import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const OUT = path.join('.build', `test-app-${process.pid}`)
const require = createRequire(import.meta.url)

// 1) 编译（包含 *.test.ts）
console.log('[test] 编译测试…')
const result = compileProject(root, OUT)
if (!reportDiagnostics(result)) process.exit(1)

// 2) 找出所有测试文件并加载
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
if (testFiles.length === 0) {
  console.log('[test] 没有找到任何 *.test.ts')
  process.exit(0)
}

globalThis.__PALETTE_TESTS__ = []
for (const file of testFiles) {
  try {
    require(path.resolve(file))
  } catch (err) {
    console.error(`[test] 加载测试文件失败：${file}`)
    console.error(err)
    process.exit(1)
  }
}

// 3) 执行
const cases = globalThis.__PALETTE_TESTS__
let passed = 0
const failures = []
for (const item of cases) {
  try {
    item.fn()
    passed += 1
  } catch (err) {
    failures.push({ name: item.name, message: err && err.message ? err.message : String(err) })
  }
}

for (const failure of failures) {
  console.error(`  ✗ ${failure.name}\n    ${failure.message}`)
}
console.log(`\n[test] ${passed}/${cases.length} 通过${failures.length ? `，${failures.length} 失败` : ' ✓'}`)
process.exit(failures.length ? 1 : 0)
