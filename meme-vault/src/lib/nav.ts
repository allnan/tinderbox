export type View = "albums" | "library" | "inbox" | "history" | "backup" | "settings";

export type LibraryFilter =
  | { type: "all" }
  | { type: "inbox" }
  | { type: "favorite" }
  | { type: "category"; id: string }
  | { type: "group"; id: string };

export type SortKey = "newest" | "name" | "usage" | "size";

export const SORT_LABELS: Record<SortKey, string> = {
  newest: "最新导入",
  name: "名称",
  usage: "使用次数",
  size: "文件大小",
};
