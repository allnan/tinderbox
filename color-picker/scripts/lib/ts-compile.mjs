import ts from 'typescript'
import path from 'node:path'
import { readFileSync } from 'node:fs'

/**
 * 以编程方式编译 TypeScript（不启动任何子进程），返回诊断信息。
 * 与配色工坊的构建方式一致：纯 JS 工具链，不引入 Vite/esbuild/webpack。
 */
export function compileProject(root, outDir, { noEmit = false, overrides = {} } = {}) {
  const configPath = path.join(root, 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(ts.formatDiagnostics([configFile.error], formatHost))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  const options = {
    ...parsed.options,
    ...overrides,
    noEmit,
    ...(noEmit || !outDir ? {} : { outDir: path.isAbsolute(outDir) ? outDir : path.join(root, outDir) }),
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

/** 编译显式文件列表（演示页等不在 tsconfig include 里的源码） */
export function compileFiles(root, files, outDir, overrides = {}) {
  const configPath = path.join(root, 'tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(ts.formatDiagnostics([configFile.error], formatHost))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  const options = {
    ...parsed.options,
    ...overrides,
    noEmit: false,
    outDir: path.isAbsolute(outDir) ? outDir : path.join(root, outDir),
  }
  const program = ts.createProgram({ rootNames: files, options })
  const emitResult = program.emit()
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics || [])
  return {
    diagnostics,
    errors: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error),
    formatted: ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost),
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

/** 读取 tsconfig 原始配置（用于其它脚本） */
export function readTsconfig(root) {
  const configPath = path.join(root, 'tsconfig.json')
  return JSON.parse(readFileSync(configPath, 'utf8'))
}
