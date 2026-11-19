import { useEffect, useState } from "react";
import { mediaUrl } from "../api";
import { formatBytes, formatDateTime } from "../lib/format";
import type { Category, Sticker, StickerGroup } from "../types";
import { Icon } from "./ui";

interface DetailDrawerProps {
  item: Sticker;
  categories: Category[];
  groups: StickerGroup[];
  onClose: () => void;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onCopy: (id: string, mode: "image" | "file") => void;
  onDelete: (item: Sticker) => void;
  onNewCategory: (item: Sticker) => void;
  onNewGroup: (item: Sticker) => void;
}

export function DetailDrawer(props: DetailDrawerProps) {
  const { item } = props;
  const [name, setName] = useState(item.name);
  const [note, setNote] = useState(item.note);
  const [tagsText, setTagsText] = useState(item.tags.join("，"));
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setName(item.name);
    setNote(item.note);
    setTagsText(item.tags.join("，"));
    setPreviewFailed(false);
  }, [item.id, item.name, item.note, item.tags.join("\u0000")]);

  const commitName = () => {
    const value = name.trim();
    if (!value || value === item.name) {
      setName(item.name);
      return;
    }
    void props.onPatch({ name: value });
  };

  const commitNote = () => {
    if (note === item.note) return;
    void props.onPatch({ note });
  };

  const commitTags = () => {
    const tags = tagsText
      .split(/[,，;；\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 24);
    if (tags.join("|") === item.tags.join("|")) return;
    void props.onPatch({ tags });
  };

  const toggleGroup = (groupId: string) => {
    const next = item.groupIds.includes(groupId)
      ? item.groupIds.filter((id) => id !== groupId)
      : [...item.groupIds, groupId];
    void props.onPatch({ groupIds: next });
  };

  return (
    <aside className="detail-drawer" aria-label="素材详情">
      <header className="drawer-header">
        <span className="drawer-eyebrow">素材详情</span>
        <button className="icon-button" onClick={props.onClose} aria-label="关闭详情">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="drawer-preview">
        {previewFailed ? (
          <div className="preview-missing">原图无法预览</div>
        ) : (
          <img
            src={mediaUrl("image", item.sha256)}
            alt={item.name}
            onError={() => setPreviewFailed(true)}
            draggable={false}
          />
        )}
      </div>

      <div className="drawer-copy-row">
        <button className="button primary grow" onClick={() => props.onCopy(item.id, "image")}>
          <Icon name="image" size={15} />复制图片
        </button>
        <button className="button ghost grow" onClick={() => props.onCopy(item.id, "file")}>
          <Icon name="file" size={15} />复制文件
        </button>
      </div>
      <p className="drawer-hint">
        {item.ext === "gif" || item.ext === "webp"
          ? "动图建议用“复制文件”，粘贴到聊天软件后仍保留动画。"
          : "“复制图片”可直接粘贴到聊天窗口；“复制文件”保留原始格式。"}
      </p>

      <div className="drawer-form">
        <label className="field">
          <span>名称</span>
          <input
            className="input"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setName(item.name);
                event.currentTarget.blur();
              }
            }}
          />
        </label>

        <label className="field">
          <span>分类</span>
          <select
            className="input"
            value={item.categoryId ?? ""}
            onChange={(event) => props.onPatch({ categoryId: event.target.value || null })}
          >
            <option value="">未归类</option>
            {props.categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>分组</span>
          <div className="chip-list">
            {props.groups.map((group) => {
              const checked = item.groupIds.includes(group.id);
              return (
                <button
                  key={group.id}
                  className={"chip" + (checked ? " active" : "")}
                  style={checked ? { borderColor: group.color, color: group.color } : undefined}
                  onClick={() => toggleGroup(group.id)}
                >
                  {checked && <Icon name="check" size={12} />}
                  {group.name}
                </button>
              );
            })}
            <button className="chip dashed" onClick={() => props.onNewGroup(item)}>
              <Icon name="plus" size={12} />新建分组
            </button>
          </div>
        </div>

        <label className="field">
          <span>标签</span>
          <input
            className="input"
            value={tagsText}
            placeholder="用逗号分隔，例如：猫，无语，动图"
            onChange={(event) => setTagsText(event.target.value)}
            onBlur={commitTags}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>

        <div className="field">
          <span>标签快捷添加</span>
          <div className="chip-list">
            {["开心", "无语", "疑惑", "嘲讽", "可爱", "日常", "工作", "动图", "猫", "狗"].map((tag) => {
              const has = item.tags.includes(tag);
              return (
                <button
                  key={tag}
                  className={"chip small" + (has ? " active" : "")}
                  onClick={() =>
                    props.onPatch({
                      tags: has ? item.tags.filter((value) => value !== tag) : [...item.tags, tag],
                    })
                  }
                >
                  {has ? "− " : "+ "}
                  {tag}
                </button>
              );
            })}
          </div>
        </div>

        <label className="field">
          <span>备注</span>
          <textarea
            className="input textarea"
            rows={3}
            maxLength={200}
            value={note}
            placeholder="记下它的用法，或者来源"
            onChange={(event) => setNote(event.target.value)}
            onBlur={commitNote}
          />
        </label>
      </div>

      {item.aiNote && (
        <div className="ai-note">
          <Icon name="sparkles" size={14} />
          <span>{item.aiNote}</span>
        </div>
      )}

      <dl className="meta-grid">
        <div><dt>尺寸</dt><dd>{item.width && item.height ? `${item.width} × ${item.height}` : "未知"}</dd></div>
        <div><dt>格式</dt><dd>{item.ext.toUpperCase()}</dd></div>
        <div><dt>大小</dt><dd>{formatBytes(item.bytes)}</dd></div>
        <div><dt>使用</dt><dd>{item.usageCount} 次</dd></div>
        <div><dt>导入</dt><dd>{formatDateTime(item.importedAt)}</dd></div>
        <div><dt>状态</dt><dd>{item.status === "inbox" ? "待整理" : "已归类"}</dd></div>
      </dl>

      <div className="drawer-footer">
        <button
          className="button ghost grow"
          onClick={() => props.onPatch({ favorite: !item.favorite })}
        >
          <Icon name={item.favorite ? "heart-filled" : "heart"} size={15} />
          {item.favorite ? "取消收藏" : "收藏"}
        </button>
        <button className="button ghost grow danger-text" onClick={() => props.onDelete(item)}>
          <Icon name="trash" size={15} />
          删除
        </button>
      </div>
    </aside>
  );
}
