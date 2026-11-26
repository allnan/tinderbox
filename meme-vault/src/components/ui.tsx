import { useEffect, useState, type ReactNode } from "react";
import { classNames } from "../lib/format";

export type IconName =
  | "search"
  | "plus"
  | "folder"
  | "image"
  | "file"
  | "copy"
  | "heart"
  | "heart-filled"
  | "trash"
  | "close"
  | "chevron"
  | "chevron-down"
  | "sparkles"
  | "wand"
  | "history"
  | "database"
  | "settings"
  | "check"
  | "grid"
  | "undo"
  | "warning"
  | "inbox"
  | "sort"
  | "download"
  | "upload"
  | "refresh"
  | "keyboard"
  | "external"
  | "eye"
  | "pin";

const PATHS: Record<IconName, ReactNode> = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  folder: <><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l2 2h7.8a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4.5 17 4.2-4.2 3 3 2.6-2.6 4.8 4.8" /></>,
  file: <><path d="M7 3.5h6.5L19 9v11.5H7z" /><path d="M13.5 3.5V9H19" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="12" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9" /></>,
  heart: <path d="M12 19.5s-7.5-4.6-7.5-9.6A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.9c0 5-7.5 9.6-7.5 9.6Z" />,
  "heart-filled": <path d="M12 19.5s-7.5-4.6-7.5-9.6A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.9c0 5-7.5 9.6-7.5 9.6Z" fill="currentColor" />,
  trash: <><path d="M4.5 7h15M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7" /><path d="M10 11v6M14 11v6" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  chevron: <path d="m9 6 6 6-6 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  sparkles: <><path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.8L12 18l-1.7-5.5L5 10.7 10.3 9Z" /><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z" /></>,
  wand: <><path d="m5 19 9-9M14.5 4.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1Z" /><path d="m19 12 .6 1.3 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z" /></>,
  history: <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" /><path d="M4.5 4.5V9H9" /><path d="M12 8v4.5l3 2" /></>,
  database: <><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" /><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" /></>,
  settings: <><circle cx="12" cy="12" r="3.1" /><path d="M19 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.4-2.3 1a7.8 7.8 0 0 0-2.6-1.5L13.7 2h-3.4l-.4 2.6a7.8 7.8 0 0 0-2.6 1.5l-2.3-1-2 3.4 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.4 2.3-1a7.8 7.8 0 0 0 2.6 1.5l.4 2.6h3.4l.4-2.6a7.8 7.8 0 0 0 2.6-1.5l2.3 1 2-3.4Z" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.4" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" /></>,
  undo: <><path d="M4 9h10a5 5 0 0 1 0 10h-3" /><path d="M8 5 4 9l4 4" /></>,
  warning: <><path d="M12 3.8 21 19H3Z" /><path d="M12 9v4.5M12 16.4v.2" /></>,
  inbox: <><path d="M4 12.5 6 5h12l2 7.5V19H4Z" /><path d="M4 13h5l1 2h4l1-2h5" /></>,
  sort: <><path d="M7 5v14M4 16l3 3 3-3" /><path d="M14 6h6M14 11h4M14 16h2" /></>,
  download: <><path d="M12 4v11" /><path d="m7.5 11 4.5 4.5 4.5-4.5" /><path d="M5 20h14" /></>,
  upload: <><path d="M12 16V5" /><path d="M7.5 9.5 12 5l4.5 4.5" /><path d="M5 20h14" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4.5V10h-5.5" /></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2.2" /><path d="M7 10h.1M10.5 10h.1M14 10h.1M17.5 10h.1M8 14h8" /></>,
  external: <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 14v5.5H4.5V6H10" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="3" /></>,
  pin: <><path d="M9 4h6l-1 5 4 3v2h-5v6l-1 2-1-2v-6H6v-2l4-3-1-5Z" /></>,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={classNames("icon", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export interface ToastItem {
  id: number;
  message: string;
  kind?: "success" | "error" | "info";
  actionLabel?: string;
  onAction?: () => void;
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={classNames("toast", toast.kind ?? "info")}>
          <div className="toast-body">
            <Icon name={toast.kind === "error" ? "warning" : toast.kind === "success" ? "check" : "sparkles"} size={16} />
            <span>{toast.message}</span>
          </div>
          <div className="toast-actions">
            {toast.actionLabel && (
              <button
                className="toast-action"
                onClick={() => {
                  toast.onAction?.();
                  onDismiss(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
            <button className="toast-close" aria-label="关闭提示" onClick={() => onDismiss(toast.id)}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 460,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "确认",
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="button ghost" onClick={onCancel}>取消</button>
          <button className={classNames("button", danger ? "danger" : "primary")} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="modal-text">{message}</p>
    </Modal>
  );
}

const COLORS = ["#f5b942", "#ef7a63", "#f292b8", "#b79df0", "#8f9fd9", "#6f9fd8", "#6fc2a4", "#96a0a8", "#e2a455", "#7bb0a6"];

export function PromptDialog({
  title,
  label,
  initialName = "",
  initialColor = COLORS[0],
  withColor,
  placeholder,
  submitLabel = "保存",
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initialName?: string;
  initialColor?: string;
  withColor?: boolean;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (name: string, color: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed, color);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="button ghost" onClick={onCancel}>取消</button>
          <button className="button primary" disabled={!trimmed || busy} onClick={submit}>
            {busy ? "保存中…" : submitLabel}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{label}</span>
        <input
          className="input"
          value={name}
          maxLength={24}
          autoFocus
          placeholder={placeholder}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />
      </label>
      {withColor && (
        <div className="field">
          <span>颜色</span>
          <div className="swatches">
            {COLORS.map((value) => (
              <button
                key={value}
                type="button"
                className={classNames("swatch", value === color && "active")}
                style={{ background: value }}
                aria-label={`选择颜色 ${value}`}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={classNames("switch", checked && "on")}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />;
}

export function EmptyState({
  icon = "inbox",
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} size={30} /></div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
