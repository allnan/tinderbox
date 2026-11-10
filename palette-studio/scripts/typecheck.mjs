import ts from 'typescript'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = compileProject(root, '.build/typecheck', { noEmit: true })
const ok = reportDiagnostics(result, 'TypeScript')
if (ok) console.log(`[typecheck] 通过，共检查 ${result.files.length} 个文件`)
process.exit(ok ? 0 : 1)
