import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";
import type {
  ApiError,
  Category,
  StateView,
  Sticker,
  StickerGroup,
  SystemInfo,
} from "./types";
import type { LibraryFilter, SortKey, View } from "./lib/nav";
import { truncate } from "./lib/format";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { StickerGrid } from "./components/StickerGrid";
import { BatchBar } from "./components/BatchBar";
import { DetailDrawer } from "./components/DetailDrawer";
import { Lightbox } from "./components/Lightbox";
import { InboxView } from "./components/InboxView";
import { AlbumsView } from "./components/AlbumsView";
import { HistoryView } from "./components/HistoryView";
import { BackupView } from "./components/BackupView";
import { SettingsView } from "./components/SettingsView";
import {
  ConfirmDialog,
  EmptyState,
  Icon,
  Modal,
  PromptDialog,
  Spinner,
  ToastStack,
  type ToastItem,
} from "./components/ui";

const IMAGE_FILTERS = [
  {
    name: "表情包图片",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"],
  },
];

type DropTarget = { kind: "category" | "group" | "inbox"; id: string };

type PromptState =
  | { kind: "category"; mode: "create"; itemId?: string }
  | { kind: "category"; mode: "edit"; category: Category }
  | { kind: "group"; mode: "create"; itemId?: string }
  | { kind: "group"; mode: "edit"; group: StickerGroup };

interface ConfirmState {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  action: () => Promise<void>;
}

export default function App() {
  const [state, setState] = useState<StateView | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<View>("albums");
  const [filter, setFilter] = useState<LibraryFilter>({ type: "all" });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<SortKey>("newest");
  const [cardSize, setCardSize] = useState(150);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [renderLimit, setRenderLimit] = useState(300);
  const [selecting, setSelecting] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ ids: string[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; count: number; target: string | null } | null>(null);

  const toastSeq = useRef(0);
  const anchorRef = useRef<string | null>(null);
  const dragCandidate = useRef<{ ids: string[]; x: number; y: number; active: boolean } | null>(null);
  const dragEndAt = useRef(0);
  const dropHandlerRef = useRef<(target: DropTarget, ids: string[]) => void>(() => undefined);
  const cardSizeTimer = useRef<number | undefined>(undefined);
  const clickTimer = useRef<number | undefined>(undefined);
  const importBusyRef = useRef(false);

  const notify = useCallback(
    (message: string, options: { kind?: ToastItem["kind"]; actionLabel?: string; onAction?: () => void } = {}) => {
      const id = ++toastSeq.current;
      const item: ToastItem = { id, message, ...options };
      setToasts((current) => [...current.slice(-2), item]);
      const timeout = options.actionLabel ? 9000 : 3800;
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, timeout);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const next = await api.getState();
    setState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nextState, nextSystem] = await Promise.all([api.getState(), api.getSystem()]);
        if (cancelled) return;
        setState(nextState);
        setSystem(nextSystem);
        setCardSize(nextState.settings.cardSize);
      } catch (error) {
        if (!cancelled) setFatal((error as ApiError).message ?? "无法读取素材库");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(() => (state ? state.items.filter((item) => !item.deleted) : []), [state]);
  const categoriesById = useMemo(
    () => new Map((state?.categories ?? []).map((category) => [category.id, category])),
    [state],
  );
  const groupsById = useMemo(
    () => new Map((state?.groups ?? []).map((group) => [group.id, group])),
    [state],
  );

  const inboxItems = useMemo(() => items.filter((item) => item.status === "inbox"), [items]);

  const counts = useMemo(() => {
    const byCategory: Record<string, number> = {};
    const byGroup: Record<string, number> = {};
    let favorite = 0;
    for (const item of items) {
      if (item.categoryId) byCategory[item.categoryId] = (byCategory[item.categoryId] ?? 0) + 1;
      for (const groupId of item.groupIds) byGroup[groupId] = (byGroup[groupId] ?? 0) + 1;
      if (item.favorite) favorite += 1;
    }
    return { all: items.length, inbox: inboxItems.length, favorite, byCategory, byGroup };
  }, [items, inboxItems.length]);

  const visibleItems = useMemo(() => {
    let rows = items;
    if (filter.type === "inbox") rows = rows.filter((item) => item.status === "inbox");
    if (filter.type === "favorite") rows = rows.filter((item) => item.favorite);
    if (filter.type === "category") rows = rows.filter((item) => item.categoryId === filter.id);
    if (filter.type === "group") rows = rows.filter((item) => item.groupIds.includes(filter.id ?? ""));
    const needle = deferredQuery.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((item) => {
        const categoryName = item.categoryId ? categoriesById.get(item.categoryId)?.name ?? "" : "";
        const groupNames = item.groupIds.map((id) => groupsById.get(id)?.name ?? "").join(" ");
        return [item.name, item.note, item.tags.join(" "), item.organizeNote, categoryName, groupNames]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
    }
    const sorted = [...rows];
    sorted.sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name, "zh-CN");
      if (sort === "usage") return right.usageCount - left.usageCount || right.importedAt - left.importedAt;
      if (sort === "size") return right.bytes - left.bytes;
      return right.importedAt - left.importedAt;
    });
    return sorted;
  }, [items, filter, deferredQuery, sort, categoriesById, groupsById]);

  const displayedItems = useMemo(() => visibleItems.slice(0, renderLimit), [visibleItems, renderLimit]);
  const remainingItems = visibleItems.length - displayedItems.length;

  useEffect(() => {
    setRenderLimit(300);
  }, [filter, deferredQuery, sort]);

  const detailItem = detailId ? items.find((item) => item.id === detailId) ?? null : null;

  const lightboxItems = useMemo(() => {
    if (!lightbox) return [];
    return lightbox.ids
      .map((id) => items.find((item) => item.id === id))
      .filter((item): item is Sticker => Boolean(item));
  }, [lightbox, items]);

  const recentItems = useMemo(
    () =>
      [...items]
        .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0) || right.importedAt - left.importedAt)
        .slice(0, 12),
    [items],
  );

  const quickCopyItem = useMemo(() => {
    const used = [...items].filter((item) => item.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
    return used[0] ?? null;
  }, [items]);

  const title = useMemo(() => {
    if (filter.type === "category") return categoriesById.get(filter.id ?? "")?.name ?? "分类";
    if (filter.type === "group") return groupsById.get(filter.id ?? "")?.name ?? "分组";
    if (filter.type === "favorite") return "收藏";
    if (filter.type === "inbox") return "待整理";
    return "全部素材";
  }, [filter, categoriesById, groupsById]);

  const subtitle = useMemo(() => {
    if (filter.type === "favorite") return "常用的表情包会集中在这里";
    if (filter.type === "category") return `该分类下共有 ${counts.byCategory[filter.id ?? ""] ?? 0} 张表情包`;
    if (filter.type === "group") return `该分组下共有 ${counts.byGroup[filter.id ?? ""] ?? 0} 张表情包`;
    return "点击即复制，双击预览；拖到相册即可整理";
  }, [filter, counts]);

  const changeView = (next: View) => {
    setView(next);
    setSelecting(false);
    setSelection(new Set());
    setDetailId(null);
    setLightbox(null);
    if (next === "albums") {
      setFilter({ type: "all" });
      setQuery("");
    }
  };

  const searchAll = (value: string) => {
    setQuery(value);
    setFilter({ type: "all" });
    setView("library");
    setSelection(new Set());
    setDetailId(null);
    setLightbox(null);
  };

  const openQuick = useCallback(async () => {
    try {
      await api.showQuick();
    } catch (error) {
      notify((error as ApiError).message ?? "无法打开快速窗口", { kind: "error" });
    }
  }, [notify]);

  const changeFilter = (next: LibraryFilter) => {
    setView("library");
    setFilter(next);
    setSelecting(false);
    setSelection(new Set());
    setDetailId(null);
    setLightbox(null);
  };

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length || importBusyRef.current) return;
      importBusyRef.current = true;
      setImporting(`正在导入 ${paths.length} 个文件…`);
      try {
        const report = await api.importPaths(paths);
        await refresh();
        const parts = [`新增 ${report.added} 张`];
        if (report.duplicates) parts.push(`重复跳过 ${report.duplicates} 张`);
        if (report.failed.length) parts.push(`失败 ${report.failed.length} 张`);
        notify("导入完成：" + parts.join("，"), {
          kind: report.added > 0 ? "success" : "info",
          actionLabel: report.added > 0 ? "去待整理" : undefined,
          onAction: () => changeView("inbox"),
        });
        if (report.failed.length) console.warn("导入失败：", report.failed);
      } catch (error) {
        notify((error as ApiError).message, { kind: "error" });
      } finally {
        importBusyRef.current = false;
        setImporting(null);
      }
    },
    [notify, refresh],
  );

  const importFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "选择表情包文件夹" });
    if (typeof selected !== "string" || importBusyRef.current) return;
    importBusyRef.current = true;
    setImporting("正在扫描文件夹…");
    try {
      const report = await api.importFolder(selected);
      await refresh();
      notify(
        `导入完成：新增 ${report.added} 张${report.duplicates ? `，重复跳过 ${report.duplicates} 张` : ""}`,
        { kind: report.added > 0 ? "success" : "info", actionLabel: "去待整理", onAction: () => changeView("inbox") },
      );
    } catch (error) {
      notify((error as ApiError).message, { kind: "error" });
    } finally {
      importBusyRef.current = false;
      setImporting(null);
    }
  }, [notify, refresh]);

  const pickFiles = useCallback(async () => {
    const selected = await open({ multiple: true, title: "导入表情包", filters: IMAGE_FILTERS });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await importPaths(paths);
  }, [importPaths]);

  const copyItem = useCallback(
    async (id: string, mode: "image" | "file") => {
      try {
        await api.copyItem(id, mode);
        await refresh();
        notify(mode === "file" ? "已复制文件，可直接粘贴到聊天窗口" : "图片已复制到剪贴板", { kind: "success" });
      } catch (error) {
        notify((error as ApiError).message, { kind: "error" });
      }
    },
    [notify, refresh],
  );

  const patchItem = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      try {
        await api.updateItem(id, patch);
        await refresh();
      } catch (error) {
        notify((error as ApiError).message, { kind: "error" });
      }
    },
    [notify, refresh],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      const item = items.find((row) => row.id === id);
      if (item) void patchItem(id, { favorite: !item.favorite });
    },
    [items, patchItem],
  );

  const applyBatch = useCallback(
    async (patch: Record<string, unknown>, ids = [...selection]) => {
      if (!ids.length) return;
      try {
        const result = await api.batchUpdate(ids, patch);
        await refresh();
        setSelection(new Set());
        setDetailId(null);
        notify(`已更新 ${result.updated} 张素材`, { kind: "success" });
      } catch (error) {
        notify((error as ApiError).message, { kind: "error" });
      }
    },
    [notify, refresh, selection],
  );

  const requestDelete = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      setConfirm({
        title: `删除 ${ids.length} 张表情包？`,
        message: "删除会立即从素材库隐藏，但可以在“整理记录”里撤回，原图仍保留在本机。",
        confirmLabel: "删除",
        danger: true,
        action: async () => {
          await api.deleteItems(ids);
          setSelection(new Set());
          setDetailId(null);
          await refresh();
          notify(`已删除 ${ids.length} 张`, { kind: "info", actionLabel: "查看记录", onAction: () => changeView("history") });
        },
      });
    },
    [notify, refresh],
  );

  const handleCardClick = (event: ReactMouseEvent, id: string) => {
    if (Date.now() - dragEndAt.current < 250) return;
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
      setDetailId(next.size === 1 ? [...next][0] : null);
      anchorRef.current = id;
      return;
    }
    if (event.shiftKey && anchorRef.current) {
      const ids = (view === "inbox" ? inboxItems : visibleItems).map((item) => item.id);
      const from = ids.indexOf(anchorRef.current);
      const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelection(new Set(ids.slice(start, end + 1)));
        return;
      }
    }
    anchorRef.current = id;
    if (selecting) {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(next);
      return;
    }
    if (!state) return;
    setSelection(new Set());
    setDetailId(null);
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      void copyItem(id, state.settings.copyMode);
    }, 160);
  };

  const openCardDetail = (id: string) => {
    window.clearTimeout(clickTimer.current);
    setSelection(new Set([id]));
    setDetailId(id);
  };

  const openLightbox = (id: string) => {
    window.clearTimeout(clickTimer.current);
    const list = view === "inbox" ? inboxItems : visibleItems;
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) return;
    setLightbox({ ids: list.map((item) => item.id), index });
  };

  const handleCardPointerDown = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0) return;
    const ids = selection.has(id) ? [...selection] : [id];
    dragCandidate.current = { ids, x: event.clientX, y: event.clientY, active: false };
  };

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const candidate = dragCandidate.current;
      if (!candidate) return;
      if (!candidate.active) {
        if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) < 7) return;
        candidate.active = true;
        document.body.classList.add("dragging-stickers");
      }
      const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const targetElement = element?.closest<HTMLElement>("[data-drop-target]") ?? null;
      const label = targetElement?.textContent?.trim() ?? null;
      setDragGhost({
        x: event.clientX,
        y: event.clientY,
        count: candidate.ids.length,
        target: label,
      });
    };
    const up = (event: PointerEvent) => {
      const candidate = dragCandidate.current;
      dragCandidate.current = null;
      if (!candidate?.active) {
        setDragGhost(null);
        return;
      }
      document.body.classList.remove("dragging-stickers");
      setDragGhost(null);
      dragEndAt.current = Date.now();
      const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const raw = element?.closest<HTMLElement>("[data-drop-target]")?.dataset.dropTarget;
      if (!raw) return;
      if (raw === "inbox") {
        dropHandlerRef.current({ kind: "inbox", id: "" }, candidate.ids);
        return;
      }
      const [kind, id] = raw.split(":");
      if ((kind === "category" || kind === "group") && id) {
        dropHandlerRef.current({ kind, id }, candidate.ids);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  dropHandlerRef.current = (target, ids) => {
    if (target.kind === "category") void applyBatch({ categoryId: target.id }, ids);
    else if (target.kind === "group") void applyBatch({ addGroupIds: [target.id] }, ids);
    else void applyBatch({ status: "inbox" }, ids);
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths ?? [];
        if (!paths.length) return;
        const zip = paths.find((path) => path.toLowerCase().endsWith(".zip"));
        if (zip) {
          setConfirm({
            title: "从备份包恢复？",
            message: `检测到备份文件 ${zip.split(/[\\\\/]/).pop()}。恢复会按内容去重合并进当前素材库。`,
            confirmLabel: "恢复",
            action: async () => {
              const report = await api.importBackup(zip);
              await refresh();
              notify(`恢复完成：新增 ${report.added} 张`, { kind: "success" });
            },
          });
          return;
        }
        void importPaths(paths);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths, notify, refresh]);

  useEffect(() => {
    const onPaste = async (rawEvent: Event) => {
      const event = rawEvent as ClipboardEvent;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const imageItem = Array.from(clipboard.items).find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file || importBusyRef.current) return;
      event.preventDefault();
      importBusyRef.current = true;
      setImporting("正在从剪贴板导入…");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const name = `剪贴板-${formatStamp(new Date())}.${extension}`;
        const report = await api.importBytes(name, bytesToBase64(bytes));
        await refresh();
        notify(report.added ? "已从剪贴板导入 1 张" : "这张图片已经在素材库里了", {
          kind: report.added ? "success" : "info",
          actionLabel: report.added ? "去待整理" : undefined,
          onAction: () => changeView("inbox"),
        });
      } catch (error) {
        notify((error as ApiError).message, { kind: "error" });
      } finally {
        importBusyRef.current = false;
        setImporting(null);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [notify, refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);
      if (event.key === "Escape") {
        if (lightbox) setLightbox(null);
        else if (confirm) setConfirm(null);
        else if (prompt) setPrompt(null);
        else if (helpOpen) setHelpOpen(false);
        else if (detailId) setDetailId(null);
        else if (selection.size) setSelection(new Set());
        return;
      }
      if (typing || prompt || confirm) return;
      if (!state) return;
      if (event.key === "?") {
        setHelpOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !lightbox) {
        event.preventDefault();
        setSelection(new Set((view === "inbox" ? inboxItems : visibleItems).map((item) => item.id)));
        return;
      }
      if (!selection.size || lightbox) return;
      const ids = [...selection];
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        requestDelete(ids);
        return;
      }
      if (event.key.toLowerCase() === "f") {
        const first = items.find((item) => item.id === ids[0]);
        if (first) void applyBatch({ favorite: !first.favorite }, ids);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void copyItem(ids[0], state.settings.copyMode);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const category = state.categories[Number(event.key) - 1];
        if (category) void applyBatch({ categoryId: category.id }, ids);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    applyBatch,
    confirm,
    copyItem,
    detailId,
    helpOpen,
    inboxItems,
    items,
    lightbox,
    prompt,
    requestDelete,
    selection,
    state,
    view,
    visibleItems,
  ]);

  const submitPrompt = async (name: string, color: string) => {
    if (!prompt) return;
    try {
      if (prompt.kind === "category") {
        if (prompt.mode === "create") {
          const category = await api.createCategory(name, color);
          if (prompt.itemId) await api.updateItem(prompt.itemId, { categoryId: category.id });
        } else {
          await api.updateCategory(prompt.category.id, name, color);
        }
      } else if (prompt.mode === "create") {
        const group = await api.createGroup(name, color);
        if (prompt.itemId) await api.updateItem(prompt.itemId, { addGroupIds: [group.id] });
      } else {
        await api.updateGroup(prompt.group.id, name, color);
      }
      await refresh();
      setPrompt(null);
      notify("已保存", { kind: "success" });
    } catch (error) {
      notify((error as ApiError).message, { kind: "error" });
    }
  };

  const changeCardSize = (value: number) => {
    setCardSize(value);
    window.clearTimeout(cardSizeTimer.current);
    cardSizeTimer.current = window.setTimeout(() => {
      void api.saveSettings({ cardSize: value }).catch(() => undefined);
    }, 500);
  };

  if (fatal) {
    return (
      <div className="fatal-screen">
        <Icon name="warning" size={30} />
        <h1>无法打开素材库</h1>
        <p>{fatal}</p>
        <button className="button primary" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="fatal-screen">
        <Spinner size={26} />
        <p>正在打开素材库…</p>
      </div>
    );
  }

  const selectedCount = selection.size;
  const allFavorite = selection.size > 0 && [...selection].every((id) => items.find((item) => item.id === id)?.favorite);

  return (
    <div className={"app" + (detailItem ? " drawer-open" : "")}>
      <Sidebar
        view={view}
        filter={filter}
        categories={state.categories}
        groups={state.groups}
        counts={counts}
        onView={changeView}
        onFilter={changeFilter}
        onAddCategory={() => setPrompt({ kind: "category", mode: "create" })}
        onEditCategory={(category) => setPrompt({ kind: "category", mode: "edit", category })}
        onDeleteCategory={(category) =>
          setConfirm({
            title: `删除分类“${category.name}”？`,
            message: `分类下的 ${counts.byCategory[category.id] ?? 0} 张素材会回到未归类，可在整理记录中撤回。`,
            confirmLabel: "删除分类",
            danger: true,
            action: async () => {
              await api.deleteCategory(category.id);
              await refresh();
              notify("分类已删除", { kind: "info" });
            },
          })
        }
        onAddGroup={() => setPrompt({ kind: "group", mode: "create" })}
        onEditGroup={(group) => setPrompt({ kind: "group", mode: "edit", group })}
        onDeleteGroup={(group) =>
          setConfirm({
            title: `删除分组“${group.name}”？`,
            message: `分组会从 ${counts.byGroup[group.id] ?? 0} 张素材上移除，素材本身不会被删除。`,
            confirmLabel: "删除分组",
            danger: true,
            action: async () => {
              await api.deleteGroup(group.id);
              await refresh();
              notify("分组已删除", { kind: "info" });
            },
          })
        }
      />

      <main className="workspace">
        {view === "albums" && (
          <section className="content">
            <AlbumsView
              state={state}
              counts={counts}
              recent={recentItems}
              onOpen={changeFilter}
              onQuick={openQuick}
              onImport={() => void pickFiles()}
              onNewAlbum={() => setPrompt({ kind: "category", mode: "create" })}
              onSearch={searchAll}
              onPointerDown={handleCardPointerDown}
              onClick={handleCardClick}
              onDoubleClick={openLightbox}
              onCopy={copyItem}
              onToggleFavorite={toggleFavorite}
              onOpenItem={openCardDetail}
            />
          </section>
        )}

        {view === "library" && (
          <>
            <Toolbar
              title={title}
              subtitle={subtitle}
              total={visibleItems.length}
              query={query}
              sort={sort}
              cardSize={cardSize}
              selecting={selecting}
              selectedCount={selectedCount}
              onQuery={setQuery}
              onSort={setSort}
              onCardSize={changeCardSize}
              onSelectAll={() => setSelection(new Set(visibleItems.map((item) => item.id)))}
              onSelecting={(value) => {
                setSelecting(value);
                if (!value) setSelection(new Set());
              }}
              onImportFiles={() => void pickFiles()}
              onImportFolder={() => void importFolder()}
              onHelp={() => setHelpOpen(true)}
              onBack={() => changeView("albums")}
              onQuickCopy={() => quickCopyItem && void copyItem(quickCopyItem.id, state.settings.copyMode)}
              quickCopyItem={quickCopyItem}
            />
            <section className="content">
              {visibleItems.length === 0 ? (
                items.length === 0 ? (
                  <EmptyState
                    icon="image"
                    title="仓库还是空的"
                    description="导入图片、选择文件夹，或把图片直接拖进窗口。也可以按 Ctrl+V 从剪贴板添加。"
                    action={
                      <div className="empty-actions">
                        <button className="button primary" onClick={() => void pickFiles()}>
                          <Icon name="plus" size={16} />导入表情包
                        </button>
                        <button className="button ghost" onClick={() => void importFolder()}>
                          <Icon name="folder" size={16} />导入文件夹
                        </button>
                      </div>
                    }
                  />
                ) : (
                  <EmptyState
                    icon="search"
                    title="没有符合条件的素材"
                    description="换个关键词，或清除当前筛选条件。"
                    action={
                      <button
                        className="button ghost"
                        onClick={() => {
                          setQuery("");
                          setFilter({ type: "all" });
                        }}
                      >
                        清除筛选
                      </button>
                    }
                  />
                )
              ) : (
                <StickerGrid
                  items={displayedItems}
                  categories={state.categories}
                  selection={selection}
                  selecting={selecting}
                  cardSize={cardSize}
                  onPointerDown={handleCardPointerDown}
                  onClick={handleCardClick}
                  onDoubleClick={openLightbox}
                  onCopy={copyItem}
                  onToggleFavorite={toggleFavorite}
                  onOpen={openCardDetail}
                />
              )}
              {remainingItems > 0 && (
                <div className="load-more">
                  <button className="button ghost" onClick={() => setRenderLimit((value) => value + 300)}>
                    加载更多（还有 {remainingItems} 张）
                  </button>
                </div>
              )}
            </section>
          </>
        )}

        {view === "inbox" && (
          <section className="content" data-drop-target="inbox">
            <InboxView
              state={state}
              selection={selection}
              onPointerDown={handleCardPointerDown}
              onClick={handleCardClick}
              onDoubleClick={openLightbox}
              onCopy={copyItem}
              onToggleFavorite={toggleFavorite}
              onOpenItem={openCardDetail}
              onImportFiles={() => void pickFiles()}
              onClearSelection={() => setSelection(new Set())}
              refresh={refresh}
              notify={notify}
            />
          </section>
        )}

        {view === "history" && (
          <section className="content">
            <HistoryView state={state} notify={notify} refreshState={refresh} />
          </section>
        )}

        {view === "backup" && (
          <section className="content">
            <BackupView state={state} system={system} notify={notify} refreshState={refresh} />
          </section>
        )}

        {view === "settings" && (
          <section className="content">
            <SettingsView state={state} system={system} notify={notify} refreshState={refresh} />
          </section>
        )}
      </main>

      {detailItem && (
        <DetailDrawer
          item={detailItem}
          categories={state.categories}
          groups={state.groups}
          onClose={() => setDetailId(null)}
          onPatch={(patch) => patchItem(detailItem.id, patch)}
          onCopy={copyItem}
          onDelete={(item) => requestDelete([item.id])}
          onNewCategory={(item) => setPrompt({ kind: "category", mode: "create", itemId: item.id })}
          onNewGroup={(item) => setPrompt({ kind: "group", mode: "create", itemId: item.id })}
        />
      )}

      {selectedCount > 0 && (view === "library" || view === "inbox") && (
        <BatchBar
          count={selectedCount}
          categories={state.categories}
          groups={state.groups}
          onCategory={(categoryId) => void applyBatch({ categoryId })}
          onAddGroup={(groupId) => void applyBatch({ addGroupIds: [groupId] })}
          onFavorite={() => void applyBatch({ favorite: !allFavorite })}
          onCopy={() => void copyItem([...selection][0], state.settings.copyMode)}
          onInbox={() => void applyBatch({ status: "inbox" })}
          onDelete={() => requestDelete([...selection])}
          onClear={() => setSelection(new Set())}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />

      {importing && (
        <div className="import-progress">
          <Spinner />
          <span>{importing}</span>
        </div>
      )}

      {dragGhost && (
        <div className="drag-ghost" style={{ left: dragGhost.x + 14, top: dragGhost.y + 14 }}>
          <Icon name="image" size={15} />
          <span>{dragGhost.count} 张</span>
          {dragGhost.target && <em>放到「{truncate(dragGhost.target, 10)}」</em>}
        </div>
      )}

      {lightbox && (
        <Lightbox
          items={lightboxItems}
          index={Math.min(lightbox.index, Math.max(0, lightboxItems.length - 1))}
          onClose={() => setLightbox(null)}
          onIndex={(index) => setLightbox((current) => (current ? { ...current, index } : null))}
          onCopy={copyItem}
          onToggleFavorite={toggleFavorite}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const action = confirm.action;
            void (async () => {
              try {
                await action();
                setConfirm(null);
              } catch (error) {
                notify((error as ApiError).message, { kind: "error" });
                setConfirm(null);
              }
            })();
          }}
        />
      )}

      {prompt && (
        <PromptDialog
          title={
            prompt.mode === "create"
              ? prompt.kind === "category" ? "新建分类" : "新建分组"
              : prompt.kind === "category" ? "编辑分类" : "编辑分组"
          }
          label={prompt.kind === "category" ? "分类名称" : "分组名称"}
          initialName={prompt.mode === "create" ? "" : prompt.kind === "category" ? prompt.category.name : prompt.group.name}
          initialColor={prompt.mode === "edit" ? (prompt.kind === "category" ? prompt.category.color : prompt.group.color) : undefined}
          withColor
          placeholder={prompt.kind === "category" ? "例如：日常、工作、猫猫" : "例如：斗图必备、群聊专用"}
          submitLabel={prompt.mode === "create" ? "创建" : "保存"}
          onSubmit={submitPrompt}
          onCancel={() => setPrompt(null)}
        />
      )}

      {helpOpen && (
        <Modal title="键盘快捷键" onClose={() => setHelpOpen(false)} width={520}>
          <div className="shortcut-grid">
            {[
              ["Ctrl + Shift + Space", "随时呼出快速使用窗口"],
              ["点击卡片", "复制图片 / 文件到剪贴板"],
              ["/", "聚焦搜索框"],
              ["Ctrl / Cmd + A", "全选当前列表"],
              ["Enter", "复制选中的第一张（图片）"],
              ["Esc（快速窗口）", "收起快速使用窗口"],
              ["F", "收藏 / 取消收藏选中项"],
              ["1 – 9", "把选中项归入第 N 个分类"],
              ["Delete", "删除选中项（可撤回）"],
              ["Esc", "关闭预览 / 取消选择"],
              ["双击卡片", "打开大图预览"],
              ["拖拽卡片到侧栏", "快速归类或加入分组"],
              ["Ctrl + V", "从剪贴板导入图片"],
            ].map(([keys, description]) => (
              <div key={keys} className="shortcut-row">
                <kbd>{keys}</kbd>
                <span>{description}</span>
              </div>
            ))}
          </div>
          <p className="shortcut-note">整理建议不会直接生效：先在待整理区确认，再应用；应用后可在提示或整理记录中撤回。</p>
        </Modal>
      )}
    </div>
  );
}

function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}