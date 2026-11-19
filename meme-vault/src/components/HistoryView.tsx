import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { classNames, formatBytes, formatDateTime, formatRelative } from "../lib/format";
import type { ApiError, HistoryChange, HistoryItemView, HistoryPage, StateView } from "../types";
import { Icon, Spinner, type IconName } from "./ui";
import { ConfirmDialog } from "./ui";

interface HistoryViewProps {
  state: StateView;
  notify: (message: string, options?: { kind?: "success" | "error" | "info" }) => void;
  refreshState: () => Promise<void>;
}

const FILTERS: Array<{ id: string; label: string; types: string[] }> = [
  { id: "all", label: "全部", types: [] },
  { id: "organize", label: "整理", types: ["organize.apply"] },
  { id: "import", label: "导入", types: ["items.import"] },
  { id: "edit", label: "编辑", types: ["items.update", "items.batch"] },
  { id: "delete", label: "删除", types: ["items.delete", "items.restore"] },
  { id: "catalog", label: "分类分组", types: ["catalog.createCategory", "catalog.updateCategory", "catalog.deleteCategory", "catalog.createGroup", "catalog.updateGroup", "catalog.deleteGroup"] },
  { id: "backup", label: "备份", types: ["backup.export", "backup.import", "backup.delete"] },
  { id: "ai", label: "建议与设置", types: ["proposal.create", "settings.update"] },
];

const TYPE_ICON: Record<string, IconName> = {
  "items.import": "download",
  "items.update": "sparkles",
  "items.batch": "check",
  "items.delete": "trash",
  "items.restore": "undo",
  "organize.apply": "sparkles",
  "proposal.create": "wand",
  "backup.export": "database",
  "backup.import": "upload",
  "backup.delete": "trash",
  "settings.update": "settings",
  "catalog.createCategory": "folder",
  "catalog.createGroup": "folder",
  "catalog.updateCategory": "folder",
  "catalog.updateGroup": "folder",
  "catalog.deleteCategory": "folder",
  "catalog.deleteGroup": "folder",
};

const ACTOR_LABEL: Record<string, string> = {
  user: "我",
  ai: "AI",
  rules: "规则",
  system: "系统",
};

export function HistoryView(props: HistoryViewProps) {
  const { state } = props;
  const [page, setPage] = useState<HistoryPage>({ total: 0, items: [] });
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ entryId: string; conflicts: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getHistory({ limit: 200 });
      setPage(data);
    } catch (error) {
      props.notify((error as ApiError).message, { kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [props.notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = useMemo(() => new Map(state.categories.map((category) => [category.id, category.name])), [state.categories]);
  const groups = useMemo(() => new Map(state.groups.map((group) => [group.id, group.name])), [state.groups]);
  const items = useMemo(() => new Map(state.items.map((item) => [item.id, item])), [state.items]);

  const rows = useMemo(() => {
    const spec = FILTERS.find((entry) => entry.id === filter);
    if (!spec || spec.types.length === 0) return page.items;
    return page.items.filter((entry) => spec.types.includes(entry.type));
  }, [page.items, filter]);

  const undo = async (entry: HistoryItemView, force = false) => {
    setUndoing(entry.id);
    try {
      const result = await api.undoHistory(entry.id, force);
      setConflict(null);
      await load();
      await props.refreshState();
      props.notify(
        result.restoredCatalogs.length
          ? `已撤回，并恢复 ${result.restoredCatalogs.join("、")}`
          : `已撤回 ${result.changes} 处改动`,
        { kind: "success" },
      );
    } catch (error) {
      const apiError = error as ApiError;
      if (!force && apiError.conflicts?.length) {
        setConflict({ entryId: entry.id, conflicts: apiError.conflicts });
      } else {
        props.notify(apiError.message, { kind: "error" });
      }
    } finally {
      setUndoing(null);
    }
  };

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="history-view">
      <header className="page-head">
        <div>
          <h2>整理记录</h2>
          <p>每次导入、整理、删除和备份都会留痕。支持撤回的批次会显示“撤回”按钮。</p>
        </div>
        <div className="page-head-actions">
          <button className="button ghost icon-text" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={15} />刷新
          </button>
        </div>
      </header>

      <div className="filter-chips">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            className={classNames("filter-chip", filter === entry.id && "active")}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-block"><Spinner /> 正在读取整理记录…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon name="history" size={30} /></div>
          <h3>还没有相关记录</h3>
          <p>导入或整理素材后，这里会按时间列出每一步操作。</p>
        </div>
      ) : (
        <ol className="timeline">
          {rows.map((entry) => {
            const isOpen = expanded.has(entry.id);
            const canUndo = entry.canUndo && !entry.undoneAt;
            const names = entry.changes
              .map((change) => items.get(change.itemId)?.name)
              .filter(Boolean)
              .slice(0, 3);
            return (
              <li key={entry.id} className={classNames("timeline-row", Boolean(entry.undoneAt) && "undone")}>
                <div className="timeline-rail">
                  <span className={classNames("timeline-icon", entry.actor)}>
                    <Icon name={TYPE_ICON[entry.type] ?? "history"} size={15} />
                  </span>
                </div>
                <div className="timeline-body">
                  <div className="timeline-head">
                    <div className="timeline-title">
                      <strong>{entry.summary}</strong>
                      {entry.undoneAt && <span className="pill">已撤回</span>}
                      {!entry.undoable && <span className="pill muted">仅记录</span>}
                    </div>
                    <div className="timeline-meta">
                      <span className={classNames("actor-badge", entry.actor)}>{ACTOR_LABEL[entry.actor] ?? entry.actor}</span>
                      <span title={formatDateTime(entry.at)}>{formatRelative(entry.at)}</span>
                      {entry.changes.length > 0 && <span>{entry.changes.length} 张素材</span>}
                    </div>
                  </div>

                  {names.length > 0 && (
                    <p className="timeline-sub">{names.join("、")}{entry.changes.length > 3 ? ` 等 ${entry.changes.length} 张` : ""}</p>
                  )}

                  {isOpen && (
                    <div className="timeline-detail">
                      {entry.changes.map((change) => (
                        <ChangeRow key={change.itemId} change={change} state={state} categories={categories} groups={groups} />
                      ))}
                      {entry.changes.length === 0 && (
                        <div className="catalog-detail">
                          {renderMeta(entry)}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="timeline-actions">
                    {(entry.changes.length > 0 || Object.keys(entry.meta ?? {}).length > 0) && (
                      <button className="link-button" onClick={() => toggle(entry.id)}>
                        {isOpen ? "收起详情" : "查看详情"}
                      </button>
                    )}
                    {canUndo && (
                      <button
                        className="button ghost small"
                        disabled={undoing === entry.id}
                        onClick={() => void undo(entry)}
                      >
                        {undoing === entry.id ? <Spinner /> : <Icon name="undo" size={14} />}
                        撤回
                      </button>
                    )}
                    {entry.undoneAt && <span className="timeline-undone">已于 {formatDateTime(entry.undoneAt)} 撤回</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {conflict && (
        <ConfirmDialog
          title="撤回会产生冲突"
          message={
            <>
              <p>下面这些素材在整理之后又被修改过，直接撤回会覆盖后续改动：</p>
              <ul className="conflict-list">
                {conflict.conflicts.slice(0, 8).map((id) => (
                  <li key={id}>{items.get(id)?.name ?? id}</li>
                ))}
                {conflict.conflicts.length > 8 && <li>等 {conflict.conflicts.length} 张</li>}
              </ul>
              <p>仍要强制撤回吗？</p>
            </>
          }
          confirmLabel="强制撤回"
          danger
          onCancel={() => setConflict(null)}
          onConfirm={() => {
            const entry = page.items.find((row) => row.id === conflict.entryId);
            if (entry) void undo(entry, true);
          }}
        />
      )}
    </div>
  );
}

function ChangeRow({
  change,
  state,
  categories,
  groups,
}: {
  change: HistoryChange;
  state: StateView;
  categories: Map<string, string>;
  groups: Map<string, string>;
}) {
  const item = state.items.find((row) => row.id === change.itemId);
  const lines = describeChange(change, categories, groups);
  return (
    <div className="change-row">
      {item ? (
        <img
          className="change-thumb"
          src={`http://meme.localhost/thumb/${item.sha256}`}
          alt={item.name}
          onError={(event) => {
            event.currentTarget.src = `http://meme.localhost/image/${item.sha256}`;
          }}
        />
      ) : (
        <span className="change-thumb missing" />
      )}
      <div className="change-lines">
        <strong>{item?.name ?? change.before?.name ?? "素材已删除"}</strong>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
}

function describeChange(change: HistoryChange, categories: Map<string, string>, groups: Map<string, string>): string[] {
  const before = change.before;
  const after = change.after;
  const lines: string[] = [];
  const label = (value: string | null | undefined) => (value ? categories.get(value) ?? value : "未归类");
  if (!before && after) return ["新增素材"];
  if (before && after?.deleted && !before.deleted) return ["移入删除（可撤回）"];
  if (!before || !after) return [];
  if (before.name !== after.name) lines.push(`名称：${before.name} → ${after.name}`);
  if (before.categoryId !== after.categoryId) lines.push(`分类：${label(before.categoryId)} → ${label(after.categoryId)}`);
  const addedGroups = after.groupIds.filter((id) => !before.groupIds.includes(id));
  const removedGroups = before.groupIds.filter((id) => !after.groupIds.includes(id));
  if (addedGroups.length) lines.push("加入分组：" + addedGroups.map((id) => groups.get(id) ?? id).join("、"));
  if (removedGroups.length) lines.push("移出分组：" + removedGroups.map((id) => groups.get(id) ?? id).join("、"));
  const addedTags = after.tags.filter((tag) => !before.tags.includes(tag));
  const removedTags = before.tags.filter((tag) => !after.tags.includes(tag));
  if (addedTags.length) lines.push("新增标签：" + addedTags.map((tag) => "#" + tag).join(" "));
  if (removedTags.length) lines.push("移除标签：" + removedTags.map((tag) => "#" + tag).join(" "));
  if (before.favorite !== after.favorite) lines.push(after.favorite ? "设为收藏" : "取消收藏");
  if (before.status !== after.status) lines.push(after.status === "inbox" ? "移回待整理" : "标记为已归类");
  if (before.note !== after.note) lines.push("修改了备注");
  if (lines.length === 0) lines.push("无字段变化");
  return lines;
}

function renderMeta(entry: HistoryItemView) {
  const meta = entry.meta ?? {};
  const record = meta.record as { name?: string } | undefined;
  if (record?.name) return <span>目录：{record.name}</span>;
  if (entry.type === "backup.export" && typeof meta.bytes === "number") {
    return <span>备份大小：{formatBytes(meta.bytes)}</span>;
  }
  if (entry.type === "proposal.create" && typeof meta.entries === "number") {
    return <span>建议条数：{meta.entries}{typeof meta.model === "string" && meta.model ? ` · ${meta.model}` : ""}</span>;
  }
  return <span>该操作没有逐项素材变更</span>;
}
