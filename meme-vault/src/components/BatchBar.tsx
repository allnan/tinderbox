import { useState } from "react";
import type { Category, StickerGroup } from "../types";
import { Icon } from "./ui";

interface BatchBarProps {
  count: number;
  categories: Category[];
  groups: StickerGroup[];
  onCategory: (categoryId: string | null) => void;
  onAddGroup: (groupId: string) => void;
  onFavorite: () => void;
  onCopy: () => void;
  onInbox: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function BatchBar(props: BatchBarProps) {
  const [category, setCategory] = useState("");
  const [group, setGroup] = useState("");
  return (
    <div className="batch-bar" role="toolbar" aria-label="批量整理">
      <div className="batch-count">
        <span className="batch-badge">{props.count}</span>
        <span>张已选</span>
      </div>
      <div className="batch-divider" />
      <label className="batch-select" title="批量设置分类">
        <Icon name="grid" size={14} />
        <select
          value={category}
          onChange={(event) => {
            const value = event.target.value;
            setCategory("");
            if (value) props.onCategory(value === "__none__" ? null : value);
          }}
        >
          <option value="">设置分类…</option>
          <option value="__none__">移出分类</option>
          {props.categories.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </label>
      <label className="batch-select" title="批量加入分组">
        <Icon name="folder" size={14} />
        <select
          value={group}
          onChange={(event) => {
            const value = event.target.value;
            setGroup("");
            if (value) props.onAddGroup(value);
          }}
        >
          <option value="">加入分组…</option>
          {props.groups.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </label>
      <button className="batch-button" onClick={props.onFavorite}>
        <Icon name="heart" size={14} />收藏
      </button>
      <button className="batch-button" onClick={props.onCopy}>
        <Icon name="copy" size={14} />复制
      </button>
      <button className="batch-button" onClick={props.onInbox}>
        <Icon name="inbox" size={14} />移回待整理
      </button>
      <button className="batch-button danger" onClick={props.onDelete}>
        <Icon name="trash" size={14} />删除
      </button>
      <div className="batch-divider" />
      <button className="batch-button" onClick={props.onClear} title="取消选择">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
