import React, { useMemo } from 'react'
import type { GeneratedTheme, PreviewDevice, Project } from '../shared/types'
import { Icon, cx } from './ui'
import { ColorDot } from './color-ui'

/* eslint-disable react/no-unstable-nested-components */

/** 预览图例：展示迷你界面里几类颜色分别取自哪个 token */
export const PREVIEW_LEGEND: Array<{ key: string; label: string }> = [
  { key: 'primary', label: '导航 / 主按钮' },
  { key: 'surface', label: '卡片表面' },
  { key: 'border', label: '边框与分割线' },
  { key: 'text-primary', label: '正文' },
  { key: 'accent', label: '强调色' },
  { key: 'success', label: '成功状态' },
]

/** 迷你界面用到的颜色（全部来自 theme.tokens 的当前模式，缺省时用中性回退色） */
export interface PreviewColors {
  background: string
  surface: string
  raised: string
  border: string
  borderStrong: string
  text: string
  textSecondary: string
  textDisabled: string
  primary: string
  primaryHover: string
  primaryActive: string
  onPrimary: string
  secondary: string
  accent: string
  success: string
  warning: string
  error: string
  info: string
}

/** 从主题 token 计算当前模式的预览颜色 */
export function getPreviewColors(theme: GeneratedTheme | null, mode: 'light' | 'dark'): PreviewColors {
  const tokenMap = new Map<string, string>()
  for (const token of theme?.tokens ?? []) tokenMap.set(token.key, token[mode])
  const pick = (key: string, fallback: string) => tokenMap.get(key) ?? fallback
  return {
    background: pick('background', '#F5F6F8'),
    surface: pick('surface', '#FFFFFF'),
    raised: pick('surface-raised', '#FFFFFF'),
    border: pick('border', '#E5E7EB'),
    borderStrong: pick('border-strong', '#D1D5DB'),
    text: pick('text-primary', '#111827'),
    textSecondary: pick('text-secondary', '#6B7280'),
    textDisabled: pick('text-disabled', '#9CA3AF'),
    primary: pick('primary', '#4F7CFF'),
    primaryHover: pick('primary-hover', '#3D68EA'),
    primaryActive: pick('primary-active', '#3456C9'),
    onPrimary: pick('on-primary', '#FFFFFF'),
    secondary: pick('secondary', '#7C5CFF'),
    accent: pick('accent', '#F59E0B'),
    success: pick('success', '#10B981'),
    warning: pick('warning', '#F59E0B'),
    error: pick('error', '#EF4444'),
    info: pick('info', '#38BDF8'),
  }
}

/** 注入到预览容器上的 CSS 变量（--pv-*） */
function previewStyleOf(colors: PreviewColors): React.CSSProperties & Record<string, string> {
  return {
    background: colors.background,
    color: colors.text,
    '--pv-bg': colors.background,
    '--pv-surface': colors.surface,
    '--pv-raised': colors.raised,
    '--pv-border': colors.border,
    '--pv-border-strong': colors.borderStrong,
    '--pv-text': colors.text,
    '--pv-text-secondary': colors.textSecondary,
    '--pv-text-disabled': colors.textDisabled,
    '--pv-primary': colors.primary,
    '--pv-primary-hover': colors.primaryHover,
    '--pv-primary-active': colors.primaryActive,
    '--pv-on-primary': colors.onPrimary,
    '--pv-secondary': colors.secondary,
    '--pv-accent': colors.accent,
    '--pv-success': colors.success,
    '--pv-warning': colors.warning,
    '--pv-error': colors.error,
    '--pv-info': colors.info,
  }
}

/** 桌面网页版预览（浏览器窗口 + 侧边导航 + 看板） */
function DesktopPreview({ colors, mode }: { colors: PreviewColors; mode: 'light' | 'dark' }) {
  return (
    <div className="theme-preview" style={previewStyleOf(colors)}>
      {/* 浏览器窗口栏 */}
      <div className="theme-preview-chrome">
        <span className="theme-preview-dot is-error" />
        <span className="theme-preview-dot is-warning" />
        <span className="theme-preview-dot is-success" />
        <span className="theme-preview-url">app.acme.design / design-system</span>
      </div>

      <div className="theme-preview-body">
        {/* 侧边导航 */}
        <aside className="theme-preview-nav">
          <div className="tp-brand">
            <span className="tp-brand-mark">
              <Icon name="palette" size={13} />
            </span>
            <span className="tp-brand-name">Acme 设计系统</span>
          </div>
          <nav className="tp-nav">
            <span className="tp-nav-label">工作区</span>
            <span className="tp-nav-item is-active">
              <Icon name="grid" size={12} /> 概览
            </span>
            <span className="tp-nav-item">
              <Icon name="palette" size={12} /> 配色方案
            </span>
            <span className="tp-nav-item">
              <Icon name="layers" size={12} /> 组件库
            </span>
            <span className="tp-nav-item">
              <Icon name="history" size={12} /> 变更记录
            </span>
          </nav>
          <nav className="tp-nav">
            <span className="tp-nav-label">设置</span>
            <span className="tp-nav-item">
              <Icon name="settings" size={12} /> 偏好设置
            </span>
            <span className="tp-nav-item">
              <Icon name="external" size={12} /> 导出中心
            </span>
          </nav>
          <div className="tp-account">
            <span className="tp-avatar">设</span>
            <span className="tp-account-name">设计团队</span>
          </div>
        </aside>

        {/* 主内容区 */}
        <div className="theme-preview-main">
          <header className="tp-topbar">
            <div className="tp-crumbs">
              <span>设计系统</span>
              <span className="tp-crumb-sep">/</span>
              <span className="tp-crumb-current">概览</span>
            </div>
            <div className="tp-topbar-actions">
              <span className="tp-search">
                <Icon name="search" size={12} />
                <span>搜索颜色或组件</span>
              </span>
              <span className="tp-btn tp-btn-primary">
                <Icon name="plus" size={12} /> 新建项目
              </span>
            </div>
          </header>

          <div className="tp-content">
            <div className="tp-welcome">
              <div>
                <div className="tp-heading">晚上好，设计师</div>
                <div className="tp-subheading">这是你的设计系统概览，所有颜色都来自当前主题 token。</div>
              </div>
              <div className="tp-welcome-actions">
                <span className="tp-btn">导入</span>
                <span className="tp-btn tp-btn-primary">发布主题</span>
              </div>
            </div>

            <div className="tp-stats">
              <div className="tp-stat">
                <span className="tp-stat-label">组件覆盖率</span>
                <span className="tp-stat-value">92%</span>
                <span className="tp-stat-trend is-up">+4.2%</span>
              </div>
              <div className="tp-stat">
                <span className="tp-stat-label">颜色变量</span>
                <span className="tp-stat-value">18</span>
                <span className="tp-stat-trend is-up">+2</span>
              </div>
              <div className="tp-stat">
                <span className="tp-stat-label">对比度达标</span>
                <span className="tp-stat-value">16/18</span>
                <span className="tp-stat-trend is-flat">待修订</span>
              </div>
              <div className="tp-stat is-accent">
                <span className="tp-stat-label">待处理评审</span>
                <span className="tp-stat-value">3</span>
                <span className="tp-stat-trend">今天</span>
              </div>
            </div>

            <div className="tp-columns">
              <div className="tp-card">
                <div className="tp-card-head">
                  <span className="tp-card-title">最近的主题变更</span>
                  <span className="tp-chip">全部</span>
                </div>
                <div className="tp-table-head">
                  <span>名称</span>
                  <span>状态</span>
                  <span>更新时间</span>
                </div>
                <div className="tp-table-row">
                  <span className="tp-row-name">
                    <span className="tp-row-dot" style={{ background: 'var(--pv-primary)' }} /> 主色 Token
                  </span>
                  <span className="tp-tag is-success">已发布</span>
                  <span className="tp-muted">2 分钟前</span>
                </div>
                <div className="tp-table-row">
                  <span className="tp-row-name">
                    <span className="tp-row-dot" style={{ background: 'var(--pv-accent)' }} /> 强调色
                  </span>
                  <span className="tp-tag is-warning">审核中</span>
                  <span className="tp-muted">26 分钟前</span>
                </div>
                <div className="tp-table-row">
                  <span className="tp-row-name">
                    <span className="tp-row-dot" style={{ background: 'var(--pv-error)' }} /> 错误状态
                  </span>
                  <span className="tp-tag is-error">待修复</span>
                  <span className="tp-muted">1 小时前</span>
                </div>
                <div className="tp-table-row">
                  <span className="tp-row-name">
                    <span
                      className="tp-row-dot"
                      style={{
                        background: 'var(--pv-surface)',
                        boxShadow: 'inset 0 0 0 1px var(--pv-border-strong)',
                      }}
                    />
                    表面与边框
                  </span>
                  <span className="tp-tag is-info">已同步</span>
                  <span className="tp-muted">昨天</span>
                </div>
              </div>

              <div className="tp-card tp-form">
                <div className="tp-card-head">
                  <span className="tp-card-title">颜色配置</span>
                  <span className="tp-tag is-accent">编辑中</span>
                </div>
                <div className="tp-field">
                  <span className="tp-field-label">主色</span>
                  <span className="tp-color-input">
                    <span className="tp-color-dot" style={{ background: 'var(--pv-primary)' }} />
                    <span className="mono">{colors.primary}</span>
                  </span>
                </div>
                <div className="tp-field">
                  <span className="tp-field-label">背景模式</span>
                  <span className="tp-pseudo-select">
                    {mode === 'dark' ? '深色' : '浅色'} <Icon name="chevron-down" size={10} />
                  </span>
                </div>
                <div className="tp-field">
                  <span className="tp-field-label">自动对比度校验</span>
                  <span className="tp-switch" />
                </div>
                <div className="tp-tags">
                  <span className="tp-tag">圆角 8px</span>
                  <span className="tp-tag">间距 4pt</span>
                  <span className="tp-tag is-accent">WCAG AA</span>
                </div>
                <span className="tp-btn tp-btn-primary tp-btn-block">保存配置</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 悬浮提示，展示成功态颜色 */}
      <div className="tp-toast">
        <Icon name="success" size={13} />
        <span>主题已同步 · 24 个组件</span>
      </div>
    </div>
  )
}

/** 手机版预览（状态栏 + 手机屏幕 + 底部标签栏） */
function MobilePreview({ colors, mode }: { colors: PreviewColors; mode: 'light' | 'dark' }) {
  return (
    <div className="tp-phone">
      <div className="tp-phone-screen" style={previewStyleOf(colors)}>
        <div className="tp-phone-status">
          <span>9:41</span>
          <span className="tp-phone-status-icons">
            <i />
            <i />
            <i />
            <Icon name="success" size={10} />
          </span>
        </div>

        <div className="tp-phone-nav">
          <span className="tp-phone-brand">
            <span className="tp-brand-mark">
              <Icon name="palette" size={11} />
            </span>
            Acme 设计
          </span>
          <span className="tp-phone-icon">
            <Icon name="search" size={13} />
          </span>
        </div>

        <div className="tp-phone-content">
          <div className="tp-m-heading">晚上好，设计师</div>
          <div className="tp-m-subheading">设计系统 · 18 个颜色变量已同步</div>

          <div className="tp-m-actions">
            <span className="tp-btn tp-btn-primary">发布主题</span>
            <span className="tp-btn">导入</span>
          </div>

          <div className="tp-m-search">
            <Icon name="search" size={12} /> 搜索颜色或组件
          </div>

          <div className="tp-m-stats">
            <div className="tp-stat">
              <span className="tp-stat-label">组件覆盖率</span>
              <span className="tp-stat-value">92%</span>
              <span className="tp-stat-trend is-up">+4.2%</span>
            </div>
            <div className="tp-stat is-accent">
              <span className="tp-stat-label">待处理评审</span>
              <span className="tp-stat-value">3</span>
              <span className="tp-stat-trend">今天</span>
            </div>
          </div>

          <div className="tp-card">
            <div className="tp-card-head">
              <span className="tp-card-title">最近的主题变更</span>
              <span className="tp-chip">全部</span>
            </div>
            <div className="tp-m-row">
              <span className="tp-row-dot" style={{ background: 'var(--pv-primary)' }} />
              <span className="tp-m-row-name">主色 Token</span>
              <span className="tp-tag is-success">已发布</span>
            </div>
            <div className="tp-m-row">
              <span className="tp-row-dot" style={{ background: 'var(--pv-accent)' }} />
              <span className="tp-m-row-name">强调色</span>
              <span className="tp-tag is-warning">审核中</span>
            </div>
            <div className="tp-m-row">
              <span className="tp-row-dot" style={{ background: 'var(--pv-error)' }} />
              <span className="tp-m-row-name">错误状态</span>
              <span className="tp-tag is-error">待修复</span>
            </div>
          </div>

          <div className="tp-card tp-form">
            <div className="tp-card-head">
              <span className="tp-card-title">颜色配置</span>
              <span className="tp-tag is-accent">编辑中</span>
            </div>
            <div className="tp-field">
              <span className="tp-field-label">主色</span>
              <span className="tp-color-input">
                <span className="tp-color-dot" style={{ background: 'var(--pv-primary)' }} />
                <span className="mono">{colors.primary}</span>
              </span>
            </div>
            <div className="tp-field">
              <span className="tp-field-label">背景模式</span>
              <span className="tp-pseudo-select">
                {mode === 'dark' ? '深色' : '浅色'} <Icon name="chevron-down" size={10} />
              </span>
            </div>
            <span className="tp-btn tp-btn-primary tp-btn-block">保存配置</span>
          </div>
        </div>

        <div className="tp-phone-tabbar">
          <span className="tp-phone-tab is-active">
            <Icon name="grid" size={14} /> 概览
          </span>
          <span className="tp-phone-tab">
            <Icon name="palette" size={14} /> 配色
          </span>
          <span className="tp-phone-tab">
            <Icon name="layers" size={14} /> 组件
          </span>
          <span className="tp-phone-tab">
            <Icon name="settings" size={14} /> 我的
          </span>
        </div>
      </div>
    </div>
  )
}

/** 主题界面预览：根据 device 渲染桌面网页版或手机版 */
export function ThemePreview({
  project,
  mode,
  device,
}: {
  project: Project
  mode: 'light' | 'dark'
  device: PreviewDevice
}) {
  const colors = useMemo(() => getPreviewColors(project.theme, mode), [project.theme, mode])
  return (
    <div className={cx('theme-preview-root', `is-${device}`)} data-device={device}>
      {device === 'mobile' ? (
        <MobilePreview colors={colors} mode={mode} />
      ) : (
        <DesktopPreview colors={colors} mode={mode} />
      )}
    </div>
  )
}

/** 颜色图例（复用同一份 token 颜色） */
export function PreviewLegend({ project, mode }: { project: Project; mode: 'light' | 'dark' }) {
  const colors = useMemo(() => getPreviewColors(project.theme, mode), [project.theme, mode])
  const byKey: Record<string, string> = {
    primary: colors.primary,
    surface: colors.surface,
    border: colors.border,
    'text-primary': colors.text,
    accent: colors.accent,
    success: colors.success,
  }
  return (
    <div className="theme-preview-legend">
      {PREVIEW_LEGEND.map((item) => (
        <span key={item.key} className="theme-preview-legend-item">
          <ColorDot hex={byKey[item.key] ?? colors.text} size={10} radius={3} border />
          <span>{item.label}</span>
          <span className="mono">{byKey[item.key] ?? colors.text}</span>
        </span>
      ))}
    </div>
  )
}
