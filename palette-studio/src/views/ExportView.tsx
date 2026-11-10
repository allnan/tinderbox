/**
 * 导出（ExportView）
 *
 * 把当前项目的主题、色板与控件配色导出为 7 种前端可直接使用的代码格式：
 * CSS 变量 / SCSS / Tailwind v3 / Tailwind v4 / W3C Design Tokens / ES Module / Figma 变量。
 *
 * 页面结构：
 * - 7 张格式卡片，点击切换导出目标；
 * - 左侧导出选项（明暗 / 前缀 / 色阶 / 色板 / 控件），修改后实时重新生成；
 * - 右侧仿代码编辑器预览：深色背景、行号、语法着色、状态栏，支持复制与保存为文件。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ExportFormat, ExportOptions } from '../core/export'
import { DEFAULT_EXPORT_OPTIONS, EXPORT_OPTIONS, exportProject } from '../core/export'
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  Panel,
  Segmented,
  Switch,
  cx,
  useToast,
} from '../components/ui'
import type { IconName } from '../components/ui'
import { useCopyText } from '../state/store'
import type { ProjectViewProps } from './types'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 格式卡片图标 */
const FORMAT_ICONS: Record<ExportFormat, IconName> = {
  css: 'code',
  scss: 'code',
  tailwind: 'settings',
  tailwind4: 'sparkles',
  tokens: 'file',
  js: 'code',
  figma: 'palette',
}

/** 各格式保存为文件时的建议文件名 */
const FILE_NAMES: Record<ExportFormat, string> = {
  css: 'theme.css',
  scss: '_variables.scss',
  tailwind: 'tailwind.config.js',
  tailwind4: 'theme.css',
  tokens: 'design-tokens.json',
  js: 'colors.js',
  figma: 'figma-variables.json',
}

/** 各格式的使用提示 */
const FORMAT_TIPS: Record<ExportFormat, string[]> = {
  css: [
    '把代码粘贴到全局样式文件中，通过 var(--color-primary) 引用颜色。',
    '同时导出浅色 / 深色时，在 <html> 上切换 data-theme="dark" 即可整体换肤。',
    '变量前缀可与现有设计系统保持一致，例如改为 brand。',
  ],
  scss: [
    '使用 @use "variables" as *; 引入后，直接以 $color-primary 使用变量。',
    '色板与控件配色以 SCSS 映射（map）形式输出，可用 map.get 读取。',
    '深色模式变量带 -dark 后缀，便于单独维护主题切换。',
  ],
  tailwind: [
    '把 colors 合并进 tailwind.config.js 的 theme.extend 中。',
    '选择「两者」时颜色通过 CSS 变量读取，请同时导入 CSS 变量导出。',
    '完成后即可使用 bg-primary-500、text-text-primary 等工具类。',
  ],
  tailwind4: [
    '粘贴到主 CSS 文件（含 @import "tailwindcss";）中即可生效。',
    'Tailwind v4 会自动把 @theme 中的变量注册为工具类。',
    '深色变量输出在 :root[data-theme="dark"] 中，配合主题切换脚本使用。',
  ],
  tokens: [
    '遵循 W3C Design Tokens 规范，可直接交给 Style Dictionary 等工具处理。',
    '每个颜色附带 $type 与中文 $description，便于设计系统文档化。',
    '深色值记录在 $extensions.paletteStudio.dark 中，不会丢失。',
  ],
  js: [
    '以 ES Module 形式导出，import { colors } from "./colors.js" 即可使用。',
    '颜色对象带 as const 断言，配合 TypeScript 可获得字面量类型提示。',
    '深色模式常量命名为 darkColors / darkScales。',
  ],
  figma: [
    '在 Figma 变量插件中导入 JSON，即可批量创建颜色变量。',
    '变量名按「颜色/浅色/主色」分组，导入后会生成对应变量集合。',
    '如需更完整的设计系统结构，推荐同时使用「设计 Token」导出。',
  ],
}

/** 代码高亮：注释、字符串、HEX 颜色、CSS 变量与 @ 指令 */
const CODE_TOKEN_RE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|#[0-9A-Fa-f]{3,8}\b|(?:--|\$)[\w-]+|@[\w-]+/g

/** 把代码切成带语法着色的片段（纯展示用途，不改变原文） */
function highlightCode(code: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  CODE_TOKEN_RE.lastIndex = 0
  while ((match = CODE_TOKEN_RE.exec(code)) !== null) {
    if (match.index > lastIndex) nodes.push(code.slice(lastIndex, match.index))
    const text = match[0]
    let className = 'tok-keyword'
    if (text.startsWith('/*') || text.startsWith('//')) className = 'tok-comment'
    else if (text.startsWith("'") || text.startsWith('"')) className = 'tok-string'
    else if (text.startsWith('#')) className = 'tok-color'
    else if (text.startsWith('--') || text.startsWith('$')) className = 'tok-var'
    nodes.push(
      <span key={`${match.index}-${text.length}`} className={className}>
        {text}
      </span>,
    )
    lastIndex = match.index + text.length
  }
  if (lastIndex < code.length) nodes.push(code.slice(lastIndex))
  return nodes
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export default function ExportView({ project, mode }: ProjectViewProps) {
  const { toast } = useToast()
  const copyText = useCopyText()

  const [format, setFormat] = useState<ExportFormat>('css')
  const [options, setOptions] = useState<ExportOptions>(() => ({ ...DEFAULT_EXPORT_OPTIONS }))
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const codeScrollRef = useRef<HTMLDivElement>(null)

  // 切换格式后把代码预览滚回顶部
  useEffect(() => {
    if (codeScrollRef.current) codeScrollRef.current.scrollTop = 0
  }, [format])

  const option = EXPORT_OPTIONS.find((item) => item.id === format) ?? EXPORT_OPTIONS[0]
  const code = useMemo(() => exportProject(project, format, options), [project, format, options])
  const codeLines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code])
  const highlighted = useMemo(() => highlightCode(code), [code])
  const lineCount = codeLines.length
  const charCount = code.length
  const modeName = mode === 'dark' ? '深色' : '浅色'

  const patchOptions = (patch: Partial<ExportOptions>) => {
    setOptions((current) => ({ ...current, ...patch }))
  }

  const resetOptions = () => {
    setOptions({ ...DEFAULT_EXPORT_OPTIONS })
    toast('已恢复默认导出选项')
  }

  const copyCode = async () => {
    const ok = await copyText(code)
    toast(
      ok ? `已复制 ${option.label} 代码（${lineCount} 行）` : '复制失败，请检查剪贴板权限',
      ok ? 'success' : 'error',
    )
  }

  const saveFile = async () => {
    const defaultPath = FILE_NAMES[format]
    const filters = [{ name: `${option.label} 文件`, extensions: [option.extension] }]
    if (window.desktop) {
      try {
        const result = await window.desktop.saveFile({ content: code, defaultPath, filters })
        if (result.canceled) return
        toast(result.filePath ? `已保存到 ${result.filePath}` : '文件已保存', 'success')
      } catch {
        toast('保存失败，请稍后重试', 'error')
      }
      return
    }
    // 浏览器预览模式：用 Blob + <a download> 触发下载
    try {
      const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = defaultPath
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast(`已开始下载 ${defaultPath}`, 'success')
    } catch {
      toast('当前环境不支持文件下载，请使用「复制代码」', 'error')
    }
  }

  const tips = FORMAT_TIPS[format]

  return (
    <div className="tools-view page-enter">
      <header className="tools-view-head">
        <div className="tools-view-heading">
          <span className="tools-view-icon">
            <Icon name="export" size={18} />
          </span>
          <div>
            <h2 className="tools-view-title">
              导出
              <Badge tone="accent">{EXPORT_OPTIONS.length} 种格式</Badge>
            </h2>
            <p className="tools-view-desc">
              把当前项目的主题、色板与控件配色导出为前端可直接使用的代码，支持一键复制或保存为文件。
            </p>
          </div>
        </div>
        <div className="tools-view-actions">
          <Badge tone="info">{modeName}模式</Badge>
          <Badge tone="default">{option.label}</Badge>
        </div>
      </header>

      <div className={cx('export-notice', !project.theme && 'is-warning')}>
        <Icon name={project.theme ? 'info' : 'warning'} size={15} />
        <span>
          {project.theme
            ? '导出内容会随项目当前色板、主题与控件配色实时变化；点击下方格式卡片切换导出目标。'
            : '当前项目尚未生成主题，导出内容仅包含项目色板；建议先在「主题」标签页生成语义主题。'}
        </span>
        <Badge tone="default" className="export-notice-badge">
          主色 {project.baseColor}
        </Badge>
      </div>

      {/* 格式选择 */}
      <div className="export-format-grid">
        {EXPORT_OPTIONS.map((item) => {
          const active = item.id === format
          return (
            <button
              key={item.id}
              type="button"
              className={cx('export-format-card', active && 'is-active')}
              title={item.description}
              onClick={() => setFormat(item.id)}
            >
              <span className="export-format-icon">
                <Icon name={FORMAT_ICONS[item.id]} size={17} />
              </span>
              <span className="export-format-text">
                <span className="export-format-name">
                  {item.label}
                  {active ? <Icon name="check" size={13} className="export-format-check" /> : null}
                </span>
                <span className="export-format-desc">{item.description}</span>
              </span>
              <span className="export-format-tags">
                <span className="export-format-lang mono">{item.language.toUpperCase()}</span>
                <span className="export-format-ext mono">.{item.extension}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="export-workspace">
        {/* 左侧：导出选项 + 使用提示 */}
        <div className="export-side">
          <Panel
            title="导出选项"
            subtitle="调整后代码会实时重新生成"
            actions={
              <Button size="xs" variant="ghost" icon="refresh" onClick={resetOptions}>
                恢复默认
              </Button>
            }
          >
            <div className="export-options">
              <div className="export-option-row">
                <div className="export-option-label">
                  明暗模式
                  <span className="export-option-hint">导出浅色、深色或同时导出两套</span>
                </div>
                <Segmented
                  size="sm"
                  value={options.mode}
                  onChange={(next) => patchOptions({ mode: next })}
                  options={[
                    { value: 'light', label: '浅色', icon: 'sun' },
                    { value: 'dark', label: '深色', icon: 'moon' },
                    { value: 'both', label: '两者' },
                  ]}
                />
              </div>

              <div className="export-option-row">
                <div className="export-option-label">
                  CSS 变量前缀
                  <span className="export-option-hint">
                    变量名形如 --{options.prefix || 'color'}-primary
                  </span>
                </div>
                <div className="export-prefix">
                  <span className="export-prefix-mark mono">--</span>
                  <Input
                    mono
                    value={options.prefix}
                    placeholder="color"
                    maxLength={24}
                    onChange={(event) => patchOptions({ prefix: event.target.value })}
                  />
                </div>
              </div>

              <div className="export-switch-list">
                <Switch
                  checked={options.includeScales}
                  onChange={(checked) => patchOptions({ includeScales: checked })}
                  disabled={!project.theme}
                  label={
                    <span className="export-switch-text">
                      包含色阶
                      <em>50–950 的 11 级明暗色阶</em>
                    </span>
                  }
                />
                <Switch
                  checked={options.includePalette}
                  onChange={(checked) => patchOptions({ includePalette: checked })}
                  label={
                    <span className="export-switch-text">
                      包含色板
                      <em>项目色板中的 {project.palette.length} 个颜色</em>
                    </span>
                  }
                />
                <Switch
                  checked={options.includeControls}
                  onChange={(checked) => patchOptions({ includeControls: checked })}
                  disabled={!project.theme}
                  label={
                    <span className="export-switch-text">
                      包含控件配色
                      <em>按 24 个控件的属性解析颜色</em>
                    </span>
                  }
                />
              </div>

              {!project.theme ? (
                <div className="export-option-note">
                  项目尚未生成主题，色阶与控件选项暂不可用；生成主题后会自动可用。
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="使用提示" subtitle={`${option.label} · ${option.language.toUpperCase()}`}>
            <ul className="export-tips">
              {tips.map((tip) => (
                <li key={tip} className="export-tip">
                  <Icon name="info" size={12} />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* 右侧：代码预览（仿编辑器） */}
        <Panel
          className="export-code-panel"
          bodyClassName="export-code-body"
          title={
            <span className="export-code-title">
              <Icon name="code" size={15} />
              {option.label} · 代码预览
            </span>
          }
          subtitle={option.description}
          actions={
            <>
              <span className="export-code-stats">
                {lineCount} 行 · {charCount.toLocaleString()} 字符
              </span>
              <IconButton
                icon="list"
                label={showLineNumbers ? '隐藏行号' : '显示行号'}
                active={showLineNumbers}
                onClick={() => setShowLineNumbers((value) => !value)}
              />
              <Button size="sm" icon="copy" onClick={() => void copyCode()}>
                复制代码
              </Button>
              <Button size="sm" variant="primary" icon="save" onClick={() => void saveFile()}>
                保存文件
              </Button>
            </>
          }
        >
          <div className="export-code-shell">
            <div className="export-code-scroll" ref={codeScrollRef}>
              <div className="export-code-inner">
                {showLineNumbers ? (
                  <div className="export-code-gutter" aria-hidden="true">
                    {codeLines.map((_, index) => (
                      <span key={index}>{index + 1}</span>
                    ))}
                  </div>
                ) : null}
                <pre className="export-code-pre">
                  <code>{highlighted}</code>
                </pre>
              </div>
            </div>
            <div className="export-code-statusbar">
              <span>{option.language.toUpperCase()}</span>
              <span>{lineCount} 行</span>
              <span>{charCount.toLocaleString()} 字符</span>
              <span className="export-code-statusbar-spacer" />
              <span>
                {project.name} · 主色 {project.baseColor}
              </span>
              <span>{showLineNumbers ? '行号：开' : '行号：关'}</span>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
