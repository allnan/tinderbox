import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { mediaUrl } from "../api";
import { classNames } from "../lib/format";
import type { Category, Sticker } from "../types";
import { Icon } from "./ui";

interface StickerCardProps {
  item: Sticker;
  category?: Category;
  selected: boolean;
  selecting: boolean;
  onPointerDown: (event: ReactPointerEvent, id: string) => void;
  onClick: (event: ReactMouseEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onCopy: (id: string, mode: "image" | "file") => void;
  onToggleFavorite: (id: string) => void;
  onOpen?: (id: string) => void;
}

export function StickerCard(props: StickerCardProps) {
  const { item, category } = props;
  const animated = item.ext === "gif" || item.ext === "webp";
  const src = item.thumbMime ? mediaUrl("thumb", item.sha256) : mediaUrl("image", item.sha256);

  return (
    <article
      className={classNames(
        "sticker-card",
        props.selected && "selected",
        item.status === "inbox" && "in-inbox",
      )}
      onPointerDown={(event) => props.onPointerDown(event, item.id)}
      onClick={(event) => props.onClick(event, item.id)}
      onDoubleClick={() => props.onDoubleClick(item.id)}
      title={`${item.name}\n${item.width}×${item.height} · ${item.ext.toUpperCase()}\n单击复制 · 双击预览`}
    >
      <div className="card-thumb">
        <img
          src={src}
          alt={item.name}
          loading="lazy"
          draggable={false}
          onError={(event) => {
            const fallback = mediaUrl("image", item.sha256);
            if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
          }}
        />
        <div className="card-top">
          <span className="card-flags">
            {item.status === "inbox" && <span className="pill warm">待整理</span>}
            {animated && <span className="pill">{item.ext.toUpperCase()}</span>}
          </span>
          <span className="card-actions">
            {props.onOpen && (
              <button
                className="card-icon"
                aria-label="查看详情"
                title="查看详情"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpen?.(item.id);
                }}
              >
                <Icon name="eye" size={15} />
              </button>
            )}
            <button
              className={classNames("card-icon", item.favorite && "is-fav")}
              aria-label={item.favorite ? "取消收藏" : "收藏"}
              title={item.favorite ? "取消收藏" : "收藏"}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFavorite(item.id);
              }}
            >
              <Icon name={item.favorite ? "heart-filled" : "heart"} size={15} />
            </button>
          </span>
        </div>
        <div className="card-hover-actions">
          <button
            className="card-action"
            title="复制图片到剪贴板"
            onClick={(event) => {
              event.stopPropagation();
              props.onCopy(item.id, "image");
            }}
          >
            <Icon name="image" size={14} />
            <span>图片</span>
          </button>
          <button
            className="card-action"
            title="复制文件（保留 GIF 动图）"
            onClick={(event) => {
              event.stopPropagation();
              props.onCopy(item.id, "file");
            }}
          >
            <Icon name="file" size={14} />
            <span>文件</span>
          </button>
        </div>
        {props.selected && (
          <span className="select-check">
            <Icon name="check" size={13} />
          </span>
        )}
      </div>
      <div className="card-meta">
        <span className="card-name">{item.name}</span>
        <span className="card-sub">
          <span className="color-dot" style={{ background: category?.color ?? "#5b5148" }} />
          <span className="ellipsis">{category?.name ?? "未归类"}</span>
          {item.usageCount > 0 && <em>用过 {item.usageCount}</em>}
        </span>
      </div>
    </article>
  );
}
