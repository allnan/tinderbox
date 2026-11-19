import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, mediaUrl } from "../api";
import type { StateView, Sticker } from "../types";
import { classNames } from "../lib/format";
import { Icon, Spinner } from "./ui";

type QuickTab = "recent" | "favorite" | "all" | string;

const MAX_ITEMS = 180;

export function QuickPicker() {
  const [state, setState] = useState<StateView | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<QuickTab>("recent");
  const [active, setActive] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    api
      .getState()
      .then((next) => {
        setState(next);
        setPinned(Boolean(next.settings.quickAlwaysOnTop));
      })
      .catch((reason: { message?: string }) => setError(reason?.message ?? "无法读取素材库"));
  }, []);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      // 主窗口可能刚导入或整理过，回到前台时刷新一次，避免快捷窗口显示旧数据。
      api
        .getState()
        .then((next) => {
          setState(next);
          setPinned(Boolean(next.settings.quickAlwaysOnTop));
        })
        .catch((reason: { message?: string }) => setError(reason?.message ?? "无法读取素材库"));
    };
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  const categories = state?.categories ?? [];
  const items = useMemo(() => {
    if (!state) return [];
    let rows = state.items.filter((item) => !item.deleted);
    if (tab === "favorite") rows = rows.filter((item) => item.favorite);
    else if (tab !== "recent" && tab !== "all") rows = rows.filter((item) => item.categoryId === tab);
    const needle = deferredQuery.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((item) => [item.name, item.note, item.tags.join(" ")].join(" ").toLowerCase().includes(needle));
    }
    rows = [...rows].sort((left, right) => {
      if (tab === "recent") {
        return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || right.importedAt - left.importedAt;
      }
      if (tab === "favorite") {
        return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || right.importedAt - left.importedAt;
      }
      return (right.usageCount ?? 0) - (left.usageCount ?? 0) || right.importedAt - left.importedAt;
    });
    return rows.slice(0, MAX_ITEMS);
  }, [state, tab, deferredQuery]);

  useEffect(() => {
    setActive(0);
  }, [tab, deferredQuery]);

  useEffect(() => {
    const node = gridRef.current?.querySelectorAll<HTMLElement>(".quick-item")[active];
    node?.scrollIntoView({ block: "nearest" });
  }, [active, items.length]);

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    try {
      await api.setQuickAlwaysOnTop(next);
    } catch (reason) {
      setPinned(!next);
      setError((reason as { message?: string })?.message ?? "无法设置窗口置顶");
    }
  };

  const copy = async (item: Sticker) => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.copyItem(item.id, state.settings.copyMode);
      setCopiedId(item.id);
      window.setTimeout(() => {
        void getCurrentWindow().hide().catch(() => undefined);
      }, 90);
    } catch (reason) {
      setError((reason as { message?: string })?.message ?? "复制失败");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void getCurrentWindow().hide().catch(() => undefined);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (!items.length) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 6 : event.key === "ArrowUp" ? -6 : event.key === "ArrowRight" ? 1 : -1;
        setActive((current) => Math.min(items.length - 1, Math.max(0, current + step)));
        return;
      }
      if (event.key === "Enter" && items[active] && !event.isComposing) {
        event.preventDefault();
        void copy(items[active]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, active, state, busy]);

  const tabs: Array<{ id: QuickTab; label: string }> = [
    { id: "recent", label: "最近使用" },
    { id: "favorite", label: "收藏" },
    { id: "all", label: "全部" },
    ...categories.map((category) => ({ id: category.id, label: category.name })),
  ];

  return (
    <div className="quick-shell">
      <header className="quick-header" data-tauri-drag-region>
        <div className="quick-title">
          <span className="quick-mark"><Icon name="image" size={19} /></span>
          <div>
            <strong>快速使用</strong>
            <span>点一下，复制走</span>
          </div>
        </div>
        <label className="quick-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名字、标签…"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button className="quick-clear" onClick={() => setQuery("")} aria-label="清空搜索">
              <Icon name="close" size={13} />
            </button>
          )}
        </label>
        <button
          type="button"
          className={classNames("quick-pin", pinned && "active")}
          onClick={() => void togglePin()}
          title={pinned ? "取消置顶（跟随其他窗口）" : "置顶窗口"}
          aria-label={pinned ? "取消置顶" : "置顶窗口"}
          aria-pressed={pinned}
        >
          <Icon name="pin" size={16} />
        </button>
      </header>

      <div className="quick-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            className={classNames("quick-tab", tab === entry.id && "active")}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error && <div className="quick-error">{error}</div>}

      <div className="quick-grid" ref={gridRef}>
        {!state && (
          <div className="quick-empty">
            <Spinner />
            <span>正在打开素材库…</span>
          </div>
        )}
        {state && items.length === 0 && (
          <div className="quick-empty">
            <Icon name="image" size={34} />
            <strong>{state.items.length ? "没有匹配的表情" : "还没有表情"}</strong>
            <span>{state.items.length ? "换个关键词，或切换相册" : "打开主窗口导入图片后，就能在这里一键复制"}</span>
          </div>
        )}
        {items.map((item, index) => (
          <button
            key={item.id}
            className={classNames("quick-item", index === active && "active", copiedId === item.id && "copied")}
            onClick={() => void copy(item)}
            onMouseEnter={() => setActive(index)}
            title={item.name}
          >
            <img src={mediaUrl("thumb", item.sha256)} alt={item.name} loading="lazy" draggable={false} />
            {item.favorite && <span className="quick-favorite"><Icon name="heart-filled" size={12} /></span>}
            <span className="quick-name">{item.name}</span>
            {copiedId === item.id && (
              <span className="quick-copied">
                <Icon name="check" size={20} />
                已复制
              </span>
            )}
          </button>
        ))}
      </div>

      <footer className="quick-footer">
        <span>点击即复制 · 方向键选择 · Enter 复制 · Esc 关闭</span>
        <span className="quick-hint">Ctrl + Shift + Space 随时呼出</span>
      </footer>
    </div>
  );
}