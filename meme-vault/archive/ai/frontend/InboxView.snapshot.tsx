import { useMemo, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api";
import { classNames, formatRelative } from "../lib/format";
import type { Proposal, ProposalEntry, StateView } from "../types";
import { EmptyState, Icon, Spinner } from "./ui";
import { StickerGrid } from "./StickerGrid";
import { Select } from "./Select";

interface InboxViewProps {
  state: StateView;
  selection: Set<string>;
  onPointerDown: (event: ReactPointerEvent, id: string) => void;
  onClick: (event: ReactMouseEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onCopy: (id: string, mode: "image" | "file") => void;
  onToggleFavorite: (id: string) => void;
  onOpenItem: (id: string) => void;
  onImportFiles: () => void;
  onClearSelection: () => void;
  refresh: () => Promise<void>;
  notify: (message: string, options?: { kind?: "success" | "error" | "info"; actionLabel?: string; onAction?: () => void }) => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  applied: "已应用",
  dismissed: "已忽略",
  reverted: "已撤回",
  superseded: "已被新提案取代",
};

export function InboxView(props: InboxViewProps) {
  const { state } = props;
  const inboxItems = useMemo(
    () => state.items.filter((item) => !item.deleted && item.status === "inbox"),
    [state.items],
  );
  const pendingProposals = state.proposals.filter((proposal) => proposal.status === "pending");
  const [tab, setTab] = useState<"items" | "proposals">("items");
  const [busy, setBusy] = useState<"rules" | "ai" | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  const selectedIds = props.selection.size ? [...props.selection] : undefined;
  const scopeLabel = selectedIds ? `（选中 ${selectedIds.length}）` : "";

  const runRules = async () => {
    if (busy) return;
    setBusy("rules");
    try {
      await api.proposeRules(selectedIds);
      await props.refresh();
      setTab("proposals");
      props.notify("已生成整理建议，确认后才会改动素材", { kind: "success" });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const runAi = async () => {
    if (busy) return;
    if (!state.settings.ai.enabled) {
      props.notify("AI 整理还没有开启，请先到设置中配置模型", { kind: "info" });
      return;
    }
    setBusy("ai");
    try {
      const result = await api.proposeAi(selectedIds);
      setRemaining(result.remaining);
      await props.refresh();
      setTab("proposals");
      props.notify(
        result.remaining > 0
          ? `AI 已整理 ${result.requested} 张，另有 ${result.remaining} 张可继续整理`
          : `AI 已整理 ${result.requested} 张，确认建议后生效`,
        { kind: "success" },
      );
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const applyProposal = async (proposal: Proposal, entryIds?: string[]) => {
    if (applying) return;
    setApplying(proposal.id);
    try {
      const result = await api.applyProposal(proposal.id, entryIds);
      await props.refresh();
      props.onClearSelection();
      setTab("items");
      props.notify(`已应用 ${result.applied} 张整理结果`, {
        kind: "success",
        actionLabel: "撤回",
        onAction: async () => {
          try {
            await api.revertProposal(proposal.id);
            await props.refresh();
            props.notify("已撤回这次整理", { kind: "info" });
          } catch (error) {
            props.notify((error as { message: string }).message, { kind: "error" });
          }
        },
      });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setApplying(null);
    }
  };

  const dismissProposal = async (proposal: Proposal) => {
    try {
      await api.dismissProposal(proposal.id);
      await props.refresh();
      props.notify("已忽略这条整理建议", { kind: "info" });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    }
  };

  return (
    <div className="inbox-view">
      <div className="inbox-hero">
        <div>
          <h2>待整理区</h2>
          <p>
            新导入的素材会先停在这里。整理建议只做预览，确认应用后才生效，并且随时可以撤回。
          </p>
        </div>
        <div className="inbox-stats">
          <div><strong>{inboxItems.length}</strong><span>待归类</span></div>
          <div><strong>{pendingProposals.length}</strong><span>待确认建议</span></div>
        </div>
      </div>

      <div className="inbox-actions">
        <button className="button soft icon-text" disabled={busy !== null || inboxItems.length === 0} onClick={runRules}>
          {busy === "rules" ? <Spinner /> : <Icon name="wand" size={16} />}
          本地规则整理{scopeLabel}
        </button>
        <button className="button ai icon-text" disabled={busy !== null || inboxItems.length === 0} onClick={runAi}>
          {busy === "ai" ? <Spinner /> : <Icon name="sparkles" size={16} />}
          AI 整理{scopeLabel}
        </button>
        {!state.settings.ai.enabled && (
          <span className="hint-inline">AI 未开启，可先使用本地规则，或在设置中接入模型</span>
        )}
        {remaining > 0 && <span className="hint-inline">还有 {remaining} 张未送入 AI，可再次点击继续</span>}
      </div>

      <div className="tabs">
        <button className={classNames("tab", tab === "items" && "active")} onClick={() => setTab("items")}>
          待归类素材 <em>{inboxItems.length}</em>
        </button>
        <button className={classNames("tab", tab === "proposals" && "active")} onClick={() => setTab("proposals")}>
          整理建议 <em>{pendingProposals.length}</em>
        </button>
      </div>

      {tab === "items" ? (
        inboxItems.length === 0 ? (
          <EmptyState
            icon="check"
            title="待整理区已清空"
            description="所有素材都已经有了分类或分组。新导入的表情包会自动出现在这里。"
            action={<button className="button primary" onClick={props.onImportFiles}>导入表情包</button>}
          />
        ) : (
          <StickerGrid
            items={inboxItems}
            categories={state.categories}
            selection={props.selection}
            selecting={props.selection.size > 0}
            cardSize={state.settings.cardSize}
            onPointerDown={props.onPointerDown}
            onClick={props.onClick}
            onDoubleClick={props.onDoubleClick}
            onCopy={props.onCopy}
            onToggleFavorite={props.onToggleFavorite}
            onOpen={props.onOpenItem}
          />
        )
      ) : pendingProposals.length === 0 ? (
        <EmptyState
          icon="sparkles"
          title="还没有待确认的整理建议"
          description="点击“本地规则整理”按文件名和画面特征归类，或配置 AI 后让它读懂画面。建议生成后不会直接改动素材。"
          action={
            <div className="empty-actions">
              <button className="button soft" onClick={runRules} disabled={busy !== null || inboxItems.length === 0}>
                <Icon name="wand" size={15} />本地规则整理
              </button>
              <button className="button ai" onClick={runAi} disabled={busy !== null || inboxItems.length === 0}>
                <Icon name="sparkles" size={15} />AI 整理
              </button>
            </div>
          }
        />
      ) : (
        <div className="proposal-list">
          {pendingProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              state={state}
              applying={applying === proposal.id}
              onApply={(entryIds) => applyProposal(proposal, entryIds)}
              onDismiss={() => dismissProposal(proposal)}
              notify={props.notify}
              refresh={props.refresh}
            />
          ))}
          {state.proposals.some((proposal) => proposal.status !== "pending") && (
            <details className="proposal-archive">
              <summary>已处理的建议（{state.proposals.filter((proposal) => proposal.status !== "pending").length}）</summary>
              {state.proposals
                .filter((proposal) => proposal.status !== "pending")
                .slice(0, 10)
                .map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    state={state}
                    applying={false}
                    onApply={() => undefined}
                    onDismiss={() => undefined}
                    notify={props.notify}
                    refresh={props.refresh}
                    readonly
                  />
                ))}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  proposal,
  state,
  applying,
  onApply,
  onDismiss,
  notify,
  refresh,
  readonly,
}: {
  proposal: Proposal;
  state: StateView;
  applying: boolean;
  onApply: (entryIds?: string[]) => void;
  onDismiss: () => void;
  notify: InboxViewProps["notify"];
  refresh: () => Promise<void>;
  readonly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState(false);
  const itemMap = new Map(state.items.map((item) => [item.id, item]));
  const categoryMap = new Map(state.categories.map((category) => [category.id, category]));
  const groupMap = new Map(state.groups.map((group) => [group.id, group]));
  const active = proposal.entries.filter((entry) => !entry.skipped && !entry.applied);
  const visibleEntries = expandedEntries ? proposal.entries : proposal.entries.slice(0, 6);

  const updateEntry = async (entry: ProposalEntry, patch: Record<string, unknown>) => {
    try {
      await api.updateProposal(proposal.id, [{ id: entry.id, ...patch }]);
      await refresh();
    } catch (error) {
      notify((error as { message: string }).message, { kind: "error" });
    }
  };

  const updateAll = async (skipped: boolean) => {
    try {
      await api.updateProposal(proposal.id, proposal.entries.map((entry) => ({ id: entry.id, skipped })));
      await refresh();
    } catch (error) {
      notify((error as { message: string }).message, { kind: "error" });
    }
  };

  const revert = async () => {
    try {
      await api.revertProposal(proposal.id);
      await refresh();
      notify("已撤回这次整理", { kind: "info" });
    } catch (error) {
      notify((error as { message: string }).message, { kind: "error" });
    }
  };

  return (
    <section className={classNames("proposal-card", readonly && "readonly")}>
      <header className="proposal-head">
        <div className="proposal-title">
          <span className={classNames("source-badge", proposal.kind)}>
            <Icon name={proposal.kind === "ai" ? "sparkles" : "wand"} size={13} />
            {proposal.kind === "ai" ? "AI 建议" : "规则建议"}
          </span>
          <strong>{proposal.summary}</strong>
          <span className="proposal-time">{formatRelative(proposal.createdAt)}</span>
        </div>
        <div className="proposal-right">
          <span className={classNames("status-pill", proposal.status)}>{STATUS_LABEL[proposal.status] ?? proposal.status}</span>
          {proposal.kind === "ai" && typeof proposal.meta?.model === "string" && (
            <span className="model-name">{String(proposal.meta.model)}</span>
          )}
        </div>
      </header>

      <div className="proposal-entries">
        {visibleEntries.map((entry) => {
          const item = itemMap.get(entry.itemId);
          if (!item) return null;
          const category = entry.action.categoryId ? categoryMap.get(entry.action.categoryId) : null;
          return (
            <div key={entry.id} className={classNames("proposal-entry", entry.skipped && "skipped", entry.applied && "applied")}>
              <img
                className="proposal-thumb"
                src={`http://meme.localhost/thumb/${item.sha256}`}
                alt={item.name}
                onError={(event) => {
                  event.currentTarget.src = `http://meme.localhost/image/${item.sha256}`;
                }}
              />
              <div className="proposal-entry-main">
                <div className="entry-name">
                  <strong>{item.name}</strong>
                  {entry.action.name && <span className="rename">→ {entry.action.name}</span>}
                </div>
                <div className="entry-chips">
                  {category && (
                    <span className="chip tiny active" style={{ borderColor: category.color, color: category.color }}>{category.name}</span>
                  )}
                  {entry.action.newCategoryName && (
                    <span className="chip tiny new">新分类 · {entry.action.newCategoryName}</span>
                  )}
                  {entry.action.addGroupIds.map((id) => {
                    const group = groupMap.get(id);
                    return group ? (
                      <span key={id} className="chip tiny" style={{ borderColor: group.color, color: group.color }}>
                        {group.name}
                      </span>
                    ) : null;
                  })}
                  {entry.action.newGroupNames.map((name) => (
                    <span key={name} className="chip tiny new">新分组 · {name}</span>
                  ))}
                  {entry.action.addTags.map((tag) => (
                    <span key={tag} className="chip tiny tag">#{tag}</span>
                  ))}
                </div>
                {!readonly && proposal.status === "pending" && (
                  <Select
                    className="entry-select"
                    ariaLabel="修改建议分类"
                    value={entry.action.categoryId ?? (entry.action.newCategoryName ? "__new__" : "__keep__")}
                    options={[
                      { value: "__keep__", label: "不改变分类" },
                      ...(entry.action.newCategoryName
                        ? [{ value: "__new__", label: `新分类 · ${entry.action.newCategoryName}`, disabled: true }]
                        : []),
                      ...state.categories.map((category) => ({ value: category.id, label: category.name })),
                    ]}
                    onChange={(value) => {
                      if (value === "__new__") return;
                      void updateEntry(entry, { action: { categoryId: value === "__keep__" ? "" : value } });
                    }}
                  />
                )}
                {entry.reason && <p className="entry-reason">{entry.reason}</p>}
              </div>
              <div className="entry-side">
                <span
                  className={classNames("confidence", entry.confidence >= 0.75 ? "high" : entry.confidence >= 0.55 ? "mid" : "low")}
                  title="建议置信度"
                >
                  {Math.round(entry.confidence * 100)}%
                </span>
                {!readonly && proposal.status === "pending" && (
                  <button
                    className={classNames("toggle-entry", entry.skipped ? "resume" : "skip")}
                    onClick={() => updateEntry(entry, { skipped: !entry.skipped })}
                  >
                    {entry.skipped ? "恢复采纳" : "跳过"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {proposal.entries.length > 6 && !expandedEntries && (
          <button className="expand-entries" onClick={() => setExpandedEntries(true)}>
            展开其余 {proposal.entries.length - 6} 条建议
          </button>
        )}
      </div>

      <footer className="proposal-foot">
        <div className="proposal-counts">
          <span><strong>{active.length}</strong> 条将应用</span>
          <span className="muted">共 {proposal.entries.length} 条</span>
          {!readonly && proposal.status === "pending" && (
            <span className="bulk-actions">
              <button className="link-button" onClick={() => updateAll(false)}>全部采纳</button>
              <button className="link-button" onClick={() => updateAll(true)}>全部跳过</button>
            </span>
          )}
        </div>
        <div className="proposal-actions">
          {proposal.status === "pending" && (
            <>
              <button className="button ghost" onClick={onDismiss}>忽略提案</button>
              <button
                className="button primary"
                disabled={applying || active.length === 0}
                onClick={() => onApply(active.map((entry) => entry.id))}
              >
                {applying ? <Spinner /> : <Icon name="check" size={15} />}
                应用 {active.length} 条
              </button>
            </>
          )}
          {proposal.status === "applied" && (
            <button className="button ghost" onClick={revert}>
              <Icon name="undo" size={15} />撤回这次整理
            </button>
          )}
          {proposal.status !== "pending" && proposal.status !== "applied" && (
            <button className="button subtle" onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : "查看详情"}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
