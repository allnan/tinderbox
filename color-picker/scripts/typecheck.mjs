import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

const result = compileProject(root, '', { noEmit: true })
if (!reportDiagnostics(result)) process.exit(1)
console.log('[typecheck] 0 错误')
