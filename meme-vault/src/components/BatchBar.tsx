import type { Category, StickerGroup } from "../types";
import { Icon } from "./ui";
import { Select } from "./Select";

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
  return (
    <div className="batch-bar" role="toolbar" aria-label="批量整理">
      <div className="batch-count">
        <span className="batch-badge">{props.count}</span>
        <span>张已选</span>
      </div>
      <div className="batch-divider" />
      <Select
        className="batch-select"
        icon="grid"
        iconSize={14}
        ariaLabel="批量设置分类"
        title="批量设置分类"
        placeholder="设置分类…"
        value=""
        options={[
          { value: "__none__", label: "移出分类" },
          ...props.categories.map((item) => ({ value: item.id, label: item.name })),
        ]}
        onChange={(value) => props.onCategory(value === "__none__" ? null : value)}
      />
      <Select
        className="batch-select"
        icon="folder"
        iconSize={14}
        ariaLabel="批量加入分组"
        title="批量加入分组"
        placeholder="加入分组…"
        emptyLabel="还没有分组"
        value=""
        options={props.groups.map((item) => ({ value: item.id, label: item.name }))}
        onChange={(value) => props.onAddGroup(value)}
      />
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
