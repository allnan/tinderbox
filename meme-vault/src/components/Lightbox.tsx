import { useEffect } from "react";
import { mediaUrl } from "../api";
import { formatBytes } from "../lib/format";
import type { Sticker } from "../types";
import { Icon } from "./ui";

interface LightboxProps {
  items: Sticker[];
  index: number;
  onClose: () => void;
  onIndex: (index: number) => void;
  onCopy: (id: string, mode: "image" | "file") => void;
  onToggleFavorite: (id: string) => void;
}

export function Lightbox(props: LightboxProps) {
  const item = props.items[props.index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
      if (event.key === "ArrowLeft" && props.index > 0) props.onIndex(props.index - 1);
      if (event.key === "ArrowRight" && props.index < props.items.length - 1) props.onIndex(props.index + 1);
      if (event.key === "Enter" && item) props.onCopy(item.id, "image");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, item]);

  if (!item) return null;

  return (
    <div className="lightbox" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <button className="lightbox-close" onClick={props.onClose} aria-label="关闭预览">
        <Icon name="close" size={20} />
      </button>
      {props.index > 0 && (
        <button className="lightbox-nav prev" onClick={() => props.onIndex(props.index - 1)} aria-label="上一张">
          <Icon name="chevron" size={24} />
        </button>
      )}
      {props.index < props.items.length - 1 && (
        <button className="lightbox-nav next" onClick={() => props.onIndex(props.index + 1)} aria-label="下一张">
          <Icon name="chevron" size={24} />
        </button>
      )}
      <figure className="lightbox-figure">
        <img src={mediaUrl("image", item.sha256)} alt={item.name} draggable={false} />
        <figcaption>
          <div className="lightbox-title">
            <strong>{item.name}</strong>
            <span>{item.width}×{item.height} · {item.ext.toUpperCase()} · {formatBytes(item.bytes)}</span>
          </div>
          <div className="lightbox-actions">
            <button
              className="button ghost"
              onClick={() => props.onToggleFavorite(item.id)}
              aria-label={item.favorite ? "取消收藏" : "收藏"}
            >
              <Icon name={item.favorite ? "heart-filled" : "heart"} size={16} />
              {item.favorite ? "已收藏" : "收藏"}
            </button>
            <button className="button primary" onClick={() => props.onCopy(item.id, "image")}>
              <Icon name="image" size={16} />
              复制图片
            </button>
            <button className="button ghost" onClick={() => props.onCopy(item.id, "file")}>
              <Icon name="file" size={16} />
              复制文件
            </button>
          </div>
        </figcaption>
      </figure>
      <span className="lightbox-counter">{props.index + 1} / {props.items.length}</span>
    </div>
  );
}
