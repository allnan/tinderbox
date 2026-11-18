import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 运行 node:test 测试。
 *
 * 这里不调用 `node --test`：那段运行器会为每个测试文件启动子进程，在受限沙箱里
 * 会因命名管道不可用而报 `spawn EPERM`。改为在当前进程内依次 import 测试文件，
 * node:test 仍然会执行并汇总结果，失败时把 process.exitCode 置为非 0。
 *
 * 测试导入的是 dist/ 产物，所以先构建：`npm run build && npm test`；
 * `npm run check` 已按这个顺序执行。
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

if (!fs.existsSync(path.join(root, 'dist', 'index.mjs'))) {
  console.error('[test] 找不到 dist/index.mjs，请先运行 npm run build')
  process.exit(1)
}

const files = ['tests/core.test.mjs', 'tests/picker.test.mjs']
for (const file of files) {
  await import(pathToFileURL(path.join(root, file)).href)
}
