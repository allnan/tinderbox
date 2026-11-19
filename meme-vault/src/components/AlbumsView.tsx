import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { mediaUrl } from "../api";
import type { LibraryFilter } from "../lib/nav";
import type { Category, StateView, Sticker, StickerGroup } from "../types";
import { classNames } from "../lib/format";
import { Icon } from "./ui";
import { StickerGrid } from "./StickerGrid";

interface Counts {
  all: number;
  inbox: number;
  favorite: number;
  byCategory: Record<string, number>;
  byGroup: Record<string, number>;
}

interface AlbumsViewProps {
  state: StateView;
  counts: Counts;
  recent: Sticker[];
  onOpen: (filter: LibraryFilter) => void;
  onQuick: () => void;
  onImport: () => void;
  onNewAlbum: () => void;
  onSearch: (query: string) => void;
  onPointerDown: (event: ReactPointerEvent, id: string) => void;
  onClick: (event: ReactMouseEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onCopy: (id: string, mode: "image" | "file") => void;
  onToggleFavorite: (id: string) => void;
  onOpenItem: (id: string) => void;
}

interface Album {
  key: string;
  name: string;
  kind: string;
  count: number;
  color: string;
  covers: Sticker[];
  filter: LibraryFilter;
  drop?: string;
}

function pickCovers(rows: Sticker[]) {
  return rows.slice(0, 4);
}

function AlbumCard({ album, onOpen }: { album: Album; onOpen: (filter: LibraryFilter) => void }) {
  return (
    <button
      type="button"
      className={classNames(
        "album-card",
        album.count === 0 && "is-empty",
        album.covers.length === 1 && "has-single-cover",
      )}
      data-drop-target={album.drop}
      onClick={() => onOpen(album.filter)}
      title={album.drop ? "点击打开；把表情拖到这里即可归入" : "点击打开相册"}
    >
      <div className={classNames("album-cover", album.covers.length === 0 && "empty", album.covers.length === 1 && "single")}>
        {album.covers.length === 0 ? (
          <span className="album-empty-mark" style={{ color: album.color }}>
            <Icon name={album.filter.type === "inbox" ? "inbox" : album.filter.type === "favorite" ? "heart" : "image"} size={28} />
          </span>
        ) : (
          album.covers.map((item) => (
            <span className="album-cover-cell" key={item.id}>
              <img
                src={mediaUrl("thumb", item.sha256)}
                alt=""
                loading="lazy"
                draggable={false}
              />
            </span>
          ))
        )}
        <span className="album-count">{album.count}</span>
      </div>
      <span className="album-info">
        <span className="album-name">
          <span className="color-dot" style={{ background: album.color }} />
          {album.name}
        </span>
        <span className="album-meta">
          {album.kind} · {album.count} 张
        </span>
      </span>
    </button>
  );
}

export function AlbumsView(props: AlbumsViewProps) {
  const { state, counts } = props;
  const items = state.items.filter((item) => !item.deleted);
  const favorites = items.filter((item) => item.favorite);
  const inbox = items.filter((item) => item.status === "inbox");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const text = query.trim();
    if (!text) return;
    const timer = window.setTimeout(() => props.onSearch(text), 380);
    return () => window.clearTimeout(timer);
  }, [query]);

  const albums: Album[] = [
    {
      key: "all",
      name: "全部表情",
      kind: "相册",
      count: counts.all,
      color: "#f7b23b",
      covers: pickCovers([...items].sort((a, b) => b.importedAt - a.importedAt)),
      filter: { type: "all" },
    },
    {
      key: "inbox",
      name: "待整理",
      kind: "收件箱",
      count: counts.inbox,
      color: "#ef9f51",
      covers: pickCovers([...inbox].sort((a, b) => b.importedAt - a.importedAt)),
      filter: { type: "inbox" },
      drop: "inbox",
    },
    {
      key: "favorite",
      name: "收藏",
      kind: "常用",
      count: counts.favorite,
      color: "#ef6f51",
      covers: pickCovers([...favorites].sort((a, b) => b.importedAt - a.importedAt)),
      filter: { type: "favorite" },
    },
    ...state.categories.map((category: Category) => {
      const rows = items.filter((item) => item.categoryId === category.id);
      return {
        key: "category:" + category.id,
        name: category.name,
        kind: "分类",
        count: counts.byCategory[category.id] ?? 0,
        color: category.color,
        covers: pickCovers([...rows].sort((a, b) => b.importedAt - a.importedAt)),
        filter: { type: "category", id: category.id } as LibraryFilter,
        drop: "category:" + category.id,
      } satisfies Album;
    }),
    ...state.groups.map((group: StickerGroup) => {
      const rows = items.filter((item) => item.groupIds.includes(group.id));
      return {
        key: "group:" + group.id,
        name: group.name,
        kind: "分组",
        count: counts.byGroup[group.id] ?? 0,
        color: group.color,
        covers: pickCovers([...rows].sort((a, b) => b.importedAt - a.importedAt)),
        filter: { type: "group", id: group.id } as LibraryFilter,
        drop: "group:" + group.id,
      } satisfies Album;
    }),
  ];

  const primary = albums.filter(
    (album) => album.key === "all" || album.key === "inbox" || album.key === "favorite" || album.count > 0,
  );
  const empty = albums.filter(
    (album) => album.key !== "all" && album.key !== "inbox" && album.key !== "favorite" && album.count === 0,
  );

  return (
    <div className="albums-view">
      <header className="albums-hero">
        <div className="albums-hero-text">
          <span className="eyebrow">表情相册</span>
          <h1>选一张，直接用</h1>
          <p>按相册浏览，拖一张到相册就能整理；量再大也不用翻菜单。</p>
        </div>
        <div className="albums-actions">
          <button className="button primary quick-call" onClick={props.onQuick}>
            <Icon name="sparkles" size={17} />
            快速使用
            <kbd>Ctrl+Shift+Space</kbd>
          </button>
          <button className="button ghost icon-text" onClick={props.onImport}>
            <Icon name="plus" size={16} />
            导入
          </button>
        </div>
      </header>

      <div className="albums-toolrow">
        <label className="albums-search">
          <Icon name="search" size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim()) props.onSearch(query.trim());
            }}
            placeholder="搜索全部表情、标签、备注…"
          />
          <kbd>Enter</kbd>
        </label>
        <span className="albums-stats">
          {counts.all} 张 · 待整理 {counts.inbox} · 收藏 {counts.favorite}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="albums-empty">
          <Icon name="image" size={40} />
          <h2>相册还是空的</h2>
          <p>把表情包图片或文件夹拖进窗口，或者点右上角导入。之后可以按相册慢慢整理。</p>
          <button className="button primary" onClick={props.onImport}>
            <Icon name="plus" size={16} />
            导入第一批
          </button>
        </div>
      ) : (
        <>
          <div className="album-grid">
            {primary.map((album) => (
              <AlbumCard key={album.key} album={album} onOpen={props.onOpen} />
            ))}
            {empty.length === 0 && (
              <button type="button" className="album-card new-album" onClick={props.onNewAlbum}>
                <span className="new-album-mark"><Icon name="plus" size={22} /></span>
                <span>
                  <strong>新建相册</strong>
                  <em>分类相册，可拖动整理</em>
                </span>
              </button>
            )}
          </div>

          {props.recent.length > 0 && (
            <section className="albums-recent">
              <div className="albums-section-head">
                <div>
                  <h2>最近</h2>
                  <p>点一下复制；按住拖到上面的相册即可归类。</p>
                </div>
                <button className="button ghost tiny" onClick={() => props.onOpen({ type: "all" })}>
                  查看全部
                </button>
              </div>
              <StickerGrid
                items={props.recent}
                categories={state.categories}
                selection={new Set()}
                selecting={false}
                cardSize={128}
                onPointerDown={props.onPointerDown}
                onClick={props.onClick}
                onDoubleClick={props.onDoubleClick}
                onCopy={props.onCopy}
                onToggleFavorite={props.onToggleFavorite}
                onOpen={props.onOpenItem}
              />
            </section>
          )}

          {empty.length > 0 && (
            <>
              <div className="albums-section-head empty-head">
                <div>
                  <h2>空白相册</h2>
                  <p>把表情拖到相册上即可归入；平时不占地方。</p>
                </div>
              </div>
              <div className="album-grid compact">
                {empty.map((album) => (
                  <AlbumCard key={album.key} album={album} onOpen={props.onOpen} />
                ))}
                <button type="button" className="album-card new-album compact" onClick={props.onNewAlbum}>
                  <span className="new-album-mark"><Icon name="plus" size={18} /></span>
                  <span>
                    <strong>新建相册</strong>
                    <em>分类相册</em>
                  </span>
                </button>
              </div>
            </>
          )}

        </>
      )}
    </div>
  );
}