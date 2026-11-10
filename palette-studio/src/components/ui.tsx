import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

// ---------------------------------------------------------------------------
// 图标
// ---------------------------------------------------------------------------

export type IconName =
  | 'plus'
  | 'search'
  | 'settings'
  | 'palette'
  | 'moon'
  | 'sun'
  | 'copy'
  | 'trash'
  | 'edit'
  | 'lock'
  | 'unlock'
  | 'download'
  | 'upload'
  | 'import'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'check'
  | 'x'
  | 'refresh'
  | 'sparkles'
  | 'layers'
  | 'contrast'
  | 'history'
  | 'export'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'more'
  | 'grid'
  | 'list'
  | 'eye'
  | 'code'
  | 'file'
  | 'info'
  | 'warning'
  | 'error'
  | 'success'
  | 'folder'
  | 'external'
  | 'shuffle'
  | 'pipette'
  | 'pin'
  | 'filter'
  | 'arrow-left'
  | 'arrow-right'
  | 'target'
  | 'keyboard'
  | 'star'
  | 'clock'
  | 'save'
  | 'swap'
  | 'text'
  | 'monitor'
  | 'smartphone'
  | 'sliders'
  | 'wheel'

const ICONS: Record<IconName, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  palette: (
    <>
      <path d="M12 21a9 9 0 1 1 9-9c0 2.1-1.6 3.2-3.4 3.2H15a2 2 0 0 0-1.4 3.4c.3.3.4.7.4 1.1 0 1.3-.9 1.3-2 1.3z" />
      <circle cx="7.5" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="7.3" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.2" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </>
  ),
  edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </>
  ),
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  upload: <path d="M12 21V9M7 14l5-5 5 5M5 3h14" />,
  import: <path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M12 3v12M7 10l5 5 5-5" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  check: <path d="M4 12l5 5L20 6" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  refresh: <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 4.4L18 9.3l-4.1 1.9L12 15.6l-1.9-4.4L6 9.3l4.1-1.9z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 12l9 5 9-5M3 16l9 5 9-5" />
    </>
  ),
  contrast: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </>
  ),
  history: <path d="M3 12a9 9 0 1 0 3-6.7M3 3v6h6M12 7v5l3 2" />,
  export: <path d="M14 3h7v7M21 3l-9 9M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1.5" />,
  restore: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  code: <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />,
  file: <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  warning: <path d="M12 3l10 18H2zM12 9v5M12 17h.01" />,
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  external: <path d="M14 3h7v7M21 3l-9 9M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />,
  shuffle: <path d="M3 6h4l10 12h4M17 3l4 3-4 3M3 18h4l3-4M14 10l3-4h4M17 21l4-3-4-3" />,
  pipette: <path d="M4 20l2.5-.5L19 7a2.8 2.8 0 0 0-4-4L2.5 15.5zM14 5l5 5" />,
  pin: <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  'arrow-left': <path d="M19 12H5M11 18l-6-6 6-6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </>
  ),
  star: <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </>
  ),
  swap: <path d="M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4" />,
  text: <path d="M4 6h16M4 12h10M4 18h14" />,
  monitor: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  smartphone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-6M4 11V3M12 21v-9M12 8V3M20 21v-4M20 13V3" />
      <path d="M1 15h6M9 8h6M17 17h6" />
    </>
  ),
  wheel: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M21 12h-6M12 21v-6M3 12h6" />
    </>
  ),
}

export interface IconProps {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: React.CSSProperties
}

export function Icon({ name, size = 18, strokeWidth = 1.8, className, style }: IconProps) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger'
type ButtonSize = 'xs' | 'sm' | 'md'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  iconRight?: IconName
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', `btn-${variant}`, `btn-${size}`, className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'xs' ? 14 : size === 'sm' ? 15 : 16} /> : null}
      {children ? <span className="btn-label">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={size === 'xs' ? 14 : size === 'sm' ? 15 : 16} /> : null}
    </button>
  )
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  label: string
  size?: number
  active?: boolean
  variant?: 'ghost' | 'subtle' | 'danger'
}

export function IconButton({
  icon,
  label,
  size = 17,
  active,
  variant = 'ghost',
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      title={label}
      aria-label={label}
      className={cx('icon-btn', `icon-btn-${variant}`, active && 'is-active', className)}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
  invalid?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, invalid, className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx('input', mono && 'mono', invalid && 'is-invalid', className)} {...rest} />
})

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx('textarea', mono && 'mono', className)} {...rest} />
})

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[]
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <div className={cx('select-wrap', className)}>
      <select className="select" {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" size={14} className="select-caret" />
    </div>
  )
}

export interface FieldProps {
  label?: React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
}

export function Field({ label, hint, error, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cx('field', className)}>
      {label ? (
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : null}
      {children}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label className={cx('switch', disabled && 'is-disabled')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cx('switch-track', checked && 'is-checked')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
      {label ? <span className="switch-label">{label}</span> : null}
    </label>
  )
}

// ---------------------------------------------------------------------------
// 分段控件 / 标签页
// ---------------------------------------------------------------------------

export interface SegmentedOption<T extends string> {
  value: T
  label: React.ReactNode
  icon?: IconName
  title?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
}: {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div className={cx('segmented', `segmented-${size}`, className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          className={cx('segmented-item', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={size === 'sm' ? 13 : 15} /> : null}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  )
}

export interface TabItem<T extends string> {
  value: T
  label: React.ReactNode
  icon?: IconName
  badge?: number
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <div className={cx('tabs', className)} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={cx('tab', item.value === value && 'is-active')}
          onClick={() => onChange(item.value)}
        >
          {item.icon ? <Icon name={item.icon} size={15} /> : null}
          <span>{item.label}</span>
          {typeof item.badge === 'number' && item.badge > 0 ? <span className="tab-badge">{item.badge}</span> : null}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 容器
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) {
  return (
    <div className={cx('card', className)} {...rest}>
      {children}
    </div>
  )
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cx('panel', className)}>
      {title || actions ? (
        <header className="panel-header">
          <div className="panel-heading">
            {title ? <h3 className="panel-title">{title}</h3> : null}
            {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="panel-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('panel-body', bodyClassName)}>{children}</div>
    </section>
  )
}

export function Badge({
  children,
  tone = 'default',
  className,
}: {
  children: React.ReactNode
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
  className?: string
}) {
  return <span className={cx('badge', `badge-${tone}`, className)}>{children}</span>
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function EmptyState({
  icon = 'palette',
  title,
  description,
  action,
}: {
  icon?: IconName
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={26} />
      </div>
      <h3 className="empty-title">{title}</h3>
      {description ? <p className="empty-desc">{description}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  subtitle?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        {title ? (
          <header className="modal-header">
            <div>
              <h2 className="modal-title">{title}</h2>
              {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
            </div>
            <IconButton icon="close" label="关闭" onClick={onClose} />
          </header>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: React.ReactNode
  message?: React.ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={440}
      footer={
        <>
          <Button onClick={onCancel}>{cancelText}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      {message ? <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 1.7 }}>{message}</p> : null}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// 下拉菜单
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: React.ReactNode
  icon?: IconName
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

export function Dropdown({
  trigger,
  items,
  align = 'end',
}: {
  trigger: React.ReactNode
  items: MenuItem[]
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="dropdown" ref={ref}>
      <div onClick={() => setOpen((value) => !value)}>{trigger}</div>
      {open ? (
        <div className={cx('dropdown-menu', align === 'end' ? 'align-end' : 'align-start')}>
          {items.map((item, index) => (
            <button
              key={index}
              type="button"
              className={cx('dropdown-item', item.danger && 'is-danger')}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick()
              }}
            >
              {item.icon ? <Icon name={item.icon} size={15} /> : null}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

type ToastTone = 'default' | 'success' | 'error' | 'warning'

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const toast = useCallback((message: string, tone: ToastTone = 'default') => {
    const id = (counter.current += 1)
    setItems((list) => [...list.slice(-3), { id, message, tone }])
    window.setTimeout(() => {
      setItems((list) => list.filter((item) => item.id !== id))
    }, 2400)
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack">
          {items.map((item) => (
            <div key={item.id} className={cx('toast', `toast-${item.tone}`)}>
              <Icon
                name={item.tone === 'success' ? 'success' : item.tone === 'error' ? 'error' : item.tone === 'warning' ? 'warning' : 'info'}
                size={16}
              />
              <span>{item.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) return { toast: (message: string) => console.log(message) }
  return context
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx('divider', className)} />
}

/** 简单的 className 拼接 */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

/** 相对时间（中文） */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 完整时间 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
