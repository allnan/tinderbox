import { useEffect, useRef } from "react";
import { SORT_LABELS, type SortKey } from "../lib/nav";
import type { Sticker } from "../types";
import { classNames } from "../lib/format";
import { Icon } from "./ui";
import { Select } from "./Select";

const SORT_OPTIONS = (Object.keys(SORT_LABELS) as SortKey[]).map((value) => ({
  value,
  label: SORT_LABELS[value],
}));

interface ToolbarProps {
  title: string;
  subtitle: string;
  total: number;
  query: string;
  sort: SortKey;
  cardSize: number;
  selecting: boolean;
  selectedCount: number;
  onQuery: (value: string) => void;
  onSort: (value: SortKey) => void;
  onCardSize: (value: number) => void;
  onSelectAll: () => void;
  onSelecting: (value: boolean) => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  onHelp: () => void;
  onQuickCopy: () => void;
  quickCopyItem: Sticker | null;
  onBack?: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="toolbar">
      <div className="toolbar-heading">
        <div className="toolbar-title">
          {props.onBack && (
            <button className="back-button" onClick={props.onBack} title="返回相册" aria-label="返回相册">
              <Icon name="chevron" size={17} />
            </button>
          )}
          <div>
            <h1>{props.title}</h1>
            <p>{props.subtitle}</p>
          </div>
        </div>
        <div className="toolbar-heading-actions">
          <button className="button ghost icon-text" onClick={props.onImportFolder} title="导入文件夹">
            <Icon name="folder" size={16} />
            文件夹
          </button>
          <button className="button primary icon-text" onClick={props.onImportFiles}>
            <Icon name="plus" size={16} />
            导入表情包
          </button>
        </div>
      </div>

      <div className="toolbar-controls">
        <label className="search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef}
            value={props.query}
            placeholder="搜索名称、标签、备注…"
            onChange={(event) => props.onQuery(event.target.value)}
          />
          <kbd>/</kbd>
        </label>

        <div className="control-group">
          <Select
            className="select-wrap"
            icon="sort"
            iconSize={15}
            ariaLabel="排序方式"
            title="排序方式"
            value={props.sort}
            options={SORT_OPTIONS}
            onChange={(value) => props.onSort(value as SortKey)}
          />

          <label className="size-control" title="卡片大小">
            <Icon name="grid" size={15} />
            <input
              type="range"
              min={110}
              max={240}
              step={6}
              value={props.cardSize}
              onChange={(event) => props.onCardSize(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="toolbar-count">
          <strong>{props.total}</strong>
          <span>张</span>
        </div>

        <div className="toolbar-actions">
          {props.quickCopyItem && (
            <button className="button subtle icon-text" onClick={props.onQuickCopy} title="复制最近使用的素材">
              <Icon name="copy" size={15} />
              再复制一次
            </button>
          )}
          <button
            className={classNames("button subtle icon-text", props.selecting && "is-on")}
            onClick={() => props.onSelecting(!props.selecting)}
          >
            <Icon name="check" size={15} />
            {props.selecting ? `已选 ${props.selectedCount}` : "多选"}
          </button>
          {props.selecting && (
            <button className="button subtle" onClick={props.onSelectAll}>全选</button>
          )}
          <button className="icon-button" onClick={props.onHelp} aria-label="快捷键说明">
            <Icon name="keyboard" size={17} />
          </button>
        </div>
      </div>
    </header>
  );
}
