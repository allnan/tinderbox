import ts from 'typescript'
import path from 'node:path'
import { readFileSync } from 'node:fs'

/**
 * 以编程方式编译整个 src（不启动任何子进程），返回诊断信息。
 */
export function compileProject(root, outDir, { noEmit = false } = {}) {
  const configPath = path.join(root, 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(ts.formatDiagnostics([configFile.error], formatHost))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  const options = {
    ...parsed.options,
    noEmit,
    ...(noEmit ? {} : { outDir: path.isAbsolute(outDir) ? outDir : path.join(root, outDir) }),
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options })
  const emitResult = noEmit ? { diagnostics: [] } : program.emit()
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics || [])
  return {
    diagnostics,
    errors: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error),
    formatted: ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost),
    files: parsed.fileNames,
  }
}

const formatHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => '\n',
}

/** 打印诊断信息（若有） */
export function reportDiagnostics(result, label = 'TypeScript') {
  const message = result.formatted.trim()
  if (message) console.log(message)
  if (result.errors.length > 0) {
    console.error(`\n[${label}] 发现 ${result.errors.length} 个类型错误`)
    return false
  }
  return true
}

/** 读取 tsconfig 的 include（用于其它脚本） */
export function readTsconfig(root) {
  const configPath = path.join(root, 'tsconfig.json')
  return JSON.parse(readFileSync(configPath, 'utf8'))
}
