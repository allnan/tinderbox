import type { Category, StickerGroup } from "../types";
import { classNames } from "../lib/format";
import type { LibraryFilter, View } from "../lib/nav";
import { Icon } from "./ui";

interface SidebarProps {
  view: View;
  filter: LibraryFilter;
  categories: Category[];
  groups: StickerGroup[];
  counts: { all: number; inbox: number; favorite: number; byCategory: Record<string, number>; byGroup: Record<string, number> };
  onView: (view: View) => void;
  onFilter: (filter: LibraryFilter) => void;
  onAddCategory: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onAddGroup: () => void;
  onEditGroup: (group: StickerGroup) => void;
  onDeleteGroup: (group: StickerGroup) => void;
}

function BrandMark() {
  return (
    <svg viewBox="0 0 48 48" className="brand-mark" aria-hidden="true">
      <defs>
        <linearGradient id="brandGradient" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#ffd45c" />
          <stop offset="1" stopColor="#f29a3d" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="42" height="42" rx="11" fill="url(#brandGradient)" />
      <circle cx="17.5" cy="19" r="3.2" fill="#4a3317" />
      <circle cx="30.5" cy="19" r="3.2" fill="#4a3317" />
      <path d="M15 27.5c1.8 5 5.4 7.5 9 7.5s7.2-2.5 9-7.5" fill="none" stroke="#4a3317" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

export function Sidebar(props: SidebarProps) {
  const { view, filter, categories, groups, counts } = props;
  const active = (next: LibraryFilter) => {
    if (view !== "library" || filter.type !== next.type) return false;
    const currentId = "id" in filter ? filter.id : "";
    const nextId = "id" in next ? next.id : "";
    return currentId === nextId;
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <BrandMark />
        <div>
          <strong>表情包仓库</strong>
          <span>Meme Vault</span>
        </div>
      </div>

      <nav className="sidebar-nav" aria-label="素材视图">
        <button
          className={classNames("nav-row", view === "albums" && "active")}
          onClick={() => props.onView("albums")}
        >
          <Icon name="image" size={17} />
          <span>相册</span>
          <em>{counts.all}</em>
        </button>
        <button
          className={classNames("nav-row", active({ type: "all" }) && "active")}
          onClick={() => props.onFilter({ type: "all" })}
        >
          <Icon name="grid" size={17} />
          <span>全部素材</span>
          <em>{counts.all}</em>
        </button>
        <button
          className={classNames("nav-row", (active({ type: "inbox" }) || view === "inbox") && "active")}
          onClick={() => props.onView("inbox")}
          data-drop-target="inbox"
        >
          <Icon name="inbox" size={17} />
          <span>待整理</span>
          {counts.inbox > 0 ? <b className="nav-badge">{counts.inbox}</b> : <em>0</em>}
        </button>
        <button
          className={classNames("nav-row", active({ type: "favorite" }) && "active")}
          onClick={() => props.onFilter({ type: "favorite" })}
        >
          <Icon name="heart" size={17} />
          <span>收藏</span>
          <em>{counts.favorite}</em>
        </button>
      </nav>

      <div className="sidebar-section">
        <div className="section-head">
          <span>分类</span>
          <button className="mini-button" onClick={props.onAddCategory} aria-label="新增分类">
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="section-list">
          {categories.map((category) => (
            <div
              key={category.id}
              className={classNames("nav-row category-row", active({ type: "category", id: category.id }) && "active")}
              data-drop-target={`category:${category.id}`}
              role="button"
              tabIndex={0}
              onClick={() => props.onFilter({ type: "category", id: category.id })}
              onKeyDown={(event) => event.key === "Enter" && props.onFilter({ type: "category", id: category.id })}
            >
              <span className="color-dot" style={{ background: category.color }} />
              <span className="ellipsis">{category.name}</span>
              <em>{counts.byCategory[category.id] ?? 0}</em>
              <span className="row-actions">
                <button
                  className="mini-button"
                  aria-label={`重命名分类 ${category.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onEditCategory(category);
                  }}
                >
                  <Icon name="sparkles" size={12} />
                </button>
                <button
                  className="mini-button"
                  aria-label={`删除分类 ${category.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDeleteCategory(category);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-section grow">
        <div className="section-head">
          <span>分组</span>
          <button className="mini-button" onClick={props.onAddGroup} aria-label="新增分组">
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="section-list">
          {groups.length === 0 && <p className="section-hint">还没有分组，点上方 + 新建</p>}
          {groups.map((group) => (
            <div
              key={group.id}
              className={classNames("nav-row category-row", active({ type: "group", id: group.id }) && "active")}
              data-drop-target={`group:${group.id}`}
              role="button"
              tabIndex={0}
              onClick={() => props.onFilter({ type: "group", id: group.id })}
              onKeyDown={(event) => event.key === "Enter" && props.onFilter({ type: "group", id: group.id })}
            >
              <span className="group-badge" style={{ borderColor: group.color }}>
                <span style={{ background: group.color }} />
              </span>
              <span className="ellipsis">{group.name}</span>
              <em>{counts.byGroup[group.id] ?? 0}</em>
              <span className="row-actions">
                <button
                  className="mini-button"
                  aria-label={`编辑分组 ${group.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onEditGroup(group);
                  }}
                >
                  <Icon name="sparkles" size={12} />
                </button>
                <button
                  className="mini-button"
                  aria-label={`删除分组 ${group.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDeleteGroup(group);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-footer">
        <button className={classNames("nav-row", view === "history" && "active")} onClick={() => props.onView("history")}>
          <Icon name="history" size={17} />
          <span>整理记录</span>
        </button>
        <button className={classNames("nav-row", view === "backup" && "active")} onClick={() => props.onView("backup")}>
          <Icon name="database" size={17} />
          <span>备份与恢复</span>
        </button>
        <button className={classNames("nav-row", view === "settings" && "active")} onClick={() => props.onView("settings")}>
          <Icon name="settings" size={17} />
          <span>设置</span>
        </button>
        <div className="sidebar-tip">
          <Icon name="keyboard" size={14} />
          <span>按 <kbd>?</kbd> 查看快捷键</span>
        </div>
      </div>
    </aside>
  );
}
