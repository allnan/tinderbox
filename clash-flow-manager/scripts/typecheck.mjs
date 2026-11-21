#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileProject, reportDiagnostics } from './lib/ts-compile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = compileProject(root, '.build/typecheck', { noEmit: true })
if (!reportDiagnostics(result)) process.exit(1)
console.log('[typecheck] TypeScript 检查通过')
