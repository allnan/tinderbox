import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Category, Sticker } from "../types";
import { StickerCard } from "./StickerCard";

interface StickerGridProps {
  items: Sticker[];
  categories: Category[];
  selection: Set<string>;
  selecting: boolean;
  cardSize: number;
  onPointerDown: (event: ReactPointerEvent, id: string) => void;
  onClick: (event: ReactMouseEvent, id: string) => void;
  onDoubleClick: (id: string) => void;
  onCopy: (id: string, mode: "image" | "file") => void;
  onToggleFavorite: (id: string) => void;
  onOpen?: (id: string) => void;
}

export function StickerGrid(props: StickerGridProps) {
  const categoryMap = new Map(props.categories.map((category) => [category.id, category]));
  return (
    <div className="sticker-grid" style={{ "--card-size": props.cardSize + "px" } as CSSProperties}>
      {props.items.map((item) => (
        <StickerCard
          key={item.id}
          item={item}
          category={item.categoryId ? categoryMap.get(item.categoryId) : undefined}
          selected={props.selection.has(item.id)}
          selecting={props.selecting}
          onPointerDown={props.onPointerDown}
          onClick={props.onClick}
          onDoubleClick={props.onDoubleClick}
          onCopy={props.onCopy}
          onToggleFavorite={props.onToggleFavorite}
          onOpen={props.onOpen}
        />
      ))}
    </div>
  );
}
