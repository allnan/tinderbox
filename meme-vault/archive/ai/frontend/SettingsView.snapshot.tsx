import { useEffect, useState } from "react";
import { api } from "../api";
import type { AiSettings, SettingsView as SettingsData, StateView, SystemInfo } from "../types";
import { Icon, Switch } from "./ui";
import { Select } from "./Select";

interface SettingsViewProps {
  state: StateView;
  system: SystemInfo | null;
  notify: (message: string, options?: { kind?: "success" | "error" | "info" }) => void;
  refreshState: () => Promise<void>;
}

export function SettingsView(props: SettingsViewProps) {
  const { state, system } = props;
  const [ai, setAi] = useState<AiSettings>(state.settings.ai);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [preset, setPreset] = useState("custom");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [copyMode, setCopyMode] = useState<SettingsData["copyMode"]>(state.settings.copyMode);
  const [autoBackup, setAutoBackup] = useState(state.settings.autoBackup);

  useEffect(() => {
    setAi(state.settings.ai);
    setCopyMode(state.settings.copyMode);
    setAutoBackup(state.settings.autoBackup);
  }, [state.settings]);

  const updateAi = <K extends keyof AiSettings,>(key: K, value: AiSettings[K]) => {
    setAi((current) => ({ ...current, [key]: value }));
    if (key === "baseUrl" || key === "model" || key === "vision") setPreset("custom");
  };

  const applyPreset = (id: string) => {
    setPreset(id);
    const found = system?.aiPresets.find((item) => item.id === id);
    if (!found || id === "custom") return;
    setAi((current) => ({ ...current, baseUrl: found.baseUrl, model: found.model, vision: found.vision }));
  };

  const saveAi = async (extra?: Record<string, unknown>) => {
    setSaving(true);
    setTestResult(null);
    try {
      await api.saveSettings({
        ai: {
          enabled: ai.enabled,
          baseUrl: ai.baseUrl,
          model: ai.model,
          vision: ai.vision,
          batchSize: ai.batchSize,
          timeoutMs: ai.timeoutMs,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(extra ?? {}),
        },
      });
      setApiKey("");
      await props.refreshState();
      props.notify("AI 设置已保存", { kind: "success" });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    try {
      await api.saveSettings({ ai: { apiKey: "__CLEAR__" } });
      await props.refreshState();
      props.notify("已清除保存的 API Key", { kind: "info" });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const message = await api.testAi({
        baseUrl: ai.baseUrl,
        model: ai.model,
        vision: ai.vision,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setTestResult({ ok: true, message });
    } catch (error) {
      setTestResult({ ok: false, message: (error as { message: string }).message });
    } finally {
      setTesting(false);
    }
  };

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
          <p>AI 整理、复制方式与数据位置。所有配置只保存在本机。</p>
        </div>
        <span className="version-chip">v{system?.version ?? "0.1.0"}</span>
      </header>

      <section className="settings-card">
        <header className="settings-head">
          <div>
            <h3>AI 整理</h3>
            <p>接入 OpenAI 兼容的视觉模型，让 AI 读懂画面并给出整理建议。建议只会进入待确认区。</p>
          </div>
          <Switch checked={ai.enabled} onChange={(value) => updateAi("enabled", value)} label="开启 AI 整理" />
        </header>

        <div className="settings-form">
          <div className="field">
            <span>服务预设</span>
            <Select
              className="input"
              ariaLabel="服务预设"
              value={preset}
              options={(system?.aiPresets ?? []).map((item) => ({ value: item.id, label: item.label }))}
              onChange={applyPreset}
            />
          </div>
          <label className="field">
            <span>服务地址</span>
            <input
              className="input"
              value={ai.baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => updateAi("baseUrl", event.target.value)}
            />
          </label>
          <label className="field">
            <span>模型</span>
            <input
              className="input"
              value={ai.model}
              placeholder="gpt-4o-mini / qwen-vl-max / glm-4v-flash"
              onChange={(event) => updateAi("model", event.target.value)}
            />
          </label>
          <label className="field">
            <span>API Key</span>
            <div className="input-with-action">
              <input
                className="input"
                type={showKey ? "text" : "password"}
                value={apiKey}
                placeholder={ai.hasApiKey ? "已保存，输入新 Key 可替换" : "粘贴 API Key"}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
              />
              <button className="icon-button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? "隐藏 Key" : "显示 Key"}>
                <Icon name="eye" size={15} />
              </button>
            </div>
            <span className="field-hint">
              Key 以明文保存在本机数据目录的 settings.json 中，请勿分享该文件。
              {ai.hasApiKey && (
                <button className="link-button" onClick={clearKey}>清除已保存的 Key</button>
              )}
            </span>
          </label>

          <div className="settings-row">
            <label className="inline-switch">
              <Switch checked={ai.vision} onChange={(value) => updateAi("vision", value)} label="发送缩略图" />
              <span>
                发送缩略图给模型
                <em>关闭后只根据文件名与尺寸判断，适合纯文本模型</em>
              </span>
            </label>
          </div>

          <div className="settings-row two">
            <label className="field compact">
              <span>每次送入 AI 的数量</span>
              <input
                className="input"
                type="number"
                min={1}
                max={24}
                value={ai.batchSize}
                onChange={(event) => updateAi("batchSize", Math.max(1, Math.min(24, Number(event.target.value) || 12)))}
              />
            </label>
            <label className="field compact">
              <span>超时（秒）</span>
              <input
                className="input"
                type="number"
                min={10}
                max={300}
                value={Math.round(ai.timeoutMs / 1000)}
                onChange={(event) => updateAi("timeoutMs", Math.max(10, Math.min(300, Number(event.target.value) || 120)) * 1000)}
              />
            </label>
          </div>

          {testResult && (
            <div className={"test-result " + (testResult.ok ? "ok" : "fail")}>
              <Icon name={testResult.ok ? "check" : "warning"} size={15} />
              {testResult.message}
            </div>
          )}

          <div className="settings-actions">
            <button className="button ghost" onClick={testConnection} disabled={testing || saving}>
              {testing ? "连接中…" : "测试连接"}
            </button>
            <button className="button primary" onClick={() => void saveAi()} disabled={saving || testing}>
              {saving ? "保存中…" : "保存 AI 设置"}
            </button>
          </div>
        </div>
      </section>

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
