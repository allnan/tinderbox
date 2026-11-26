import { useEffect, useState } from "react";
import { api } from "../api";
import type { SettingsView as SettingsData, StateView, SystemInfo } from "../types";
import { Icon, Switch } from "./ui";

interface SettingsViewProps {
  state: StateView;
  system: SystemInfo | null;
  notify: (message: string, options?: { kind?: "success" | "error" | "info" }) => void;
  refreshState: () => Promise<void>;
}

export function SettingsView(props: SettingsViewProps) {
  const { state, system } = props;
  const [copyMode, setCopyMode] = useState<SettingsData["copyMode"]>(state.settings.copyMode);
  const [autoBackup, setAutoBackup] = useState(state.settings.autoBackup);

  useEffect(() => {
    setCopyMode(state.settings.copyMode);
    setAutoBackup(state.settings.autoBackup);
  }, [state.settings]);

  const saveImmediate = async (patch: Record<string, unknown>) => {
    try {
      await api.saveSettings(patch);
      await props.refreshState();
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    }
  };

  return (
    <div className="settings-view">
      <header className="page-head">
        <div>
          <h2>设置</h2>
          <p>复制方式、备份与数据位置。所有配置只保存在本机。</p>
        </div>
        <span className="version-chip">v{system?.version ?? "0.1.0"}</span>
      </header>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h3>快速复制</h3>
            <p>“再复制一次”、批量复制和回车复制使用的默认方式；卡片上仍可单独选择图片或文件。</p>
          </div>
        </header>
        <div className="option-cards">
          <button
            className={"option-card" + (copyMode === "image" ? " active" : "")}
            onClick={() => {
              setCopyMode("image");
              void saveImmediate({ copyMode: "image" });
            }}
          >
            <Icon name="image" size={20} />
            <strong>复制图片</strong>
            <span>写入位图，可直接粘贴到聊天窗口；GIF 会变成静态首帧。</span>
          </button>
          <button
            className={"option-card" + (copyMode === "file" ? " active" : "")}
            onClick={() => {
              setCopyMode("file");
              void saveImmediate({ copyMode: "file" });
            }}
          >
            <Icon name="file" size={20} />
            <strong>复制文件</strong>
            <span>以文件形式写入剪贴板，保留 GIF / WebP 动画，适合微信、QQ。</span>
          </button>
        </div>
      </section>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h3>备份</h3>
            <p>每天首次启动时自动导出一份快照，最多保留 10 份。</p>
          </div>
          <Switch
            checked={autoBackup}
            onChange={(value) => {
              setAutoBackup(value);
              void saveImmediate({ autoBackup: value });
            }}
            label="自动备份"
          />
        </header>
        <div className="settings-row two">
          <label className="field compact">
            <span>上次备份</span>
            <input className="input" readOnly value={state.meta.lastBackupAt ? new Date(state.meta.lastBackupAt).toLocaleString("zh-CN") : "尚未备份"} />
          </label>
          <label className="field compact">
            <span>数据目录</span>
            <div className="input-with-action">
              <input className="input" readOnly value={system?.dataDir ?? ""} />
              <button className="icon-button" onClick={() => void api.openDataDir()} aria-label="打开数据目录">
                <Icon name="external" size={15} />
              </button>
            </div>
          </label>
        </div>
      </section>

      <section className="settings-card about-card">
        <div>
          <h3>表情包仓库</h3>
          <p>本地优先的表情包管理工具。数据保存在本机，不上传云端。</p>
        </div>
        <div className="about-meta">
          <span>{system?.platform === "windows" ? "Windows 客户端" : system?.platform ?? "桌面客户端"}</span>
          <span>版本 {system?.version ?? "0.1.0"}</span>
        </div>
      </section>
    </div>
  );
}
