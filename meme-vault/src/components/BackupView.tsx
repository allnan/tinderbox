import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { formatBytes, formatDateTime, formatRelative } from "../lib/format";
import type { BackupInfo, ImportBackupReport, StateView, SystemInfo } from "../types";
import { ConfirmDialog, EmptyState, Icon, Spinner } from "./ui";

interface BackupViewProps {
  state: StateView;
  system: SystemInfo | null;
  notify: (message: string, options?: { kind?: "success" | "error" | "info" }) => void;
  refreshState: () => Promise<void>;
}

export function BackupView(props: BackupViewProps) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<ImportBackupReport | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "import"; path: string; name: string }
    | { kind: "restore"; fileName: string }
    | { kind: "delete"; fileName: string }
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBackups(await api.listBackups());
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [props.notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportBackup = async () => {
    setBusy("export");
    try {
      const info = await api.exportBackup();
      await load();
      await props.refreshState();
      props.notify(`备份已生成：${info.fileName}（${formatBytes(info.bytes)}）`, { kind: "success" });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const pickBackup = async () => {
    const selected = await open({
      multiple: false,
      title: "选择表情包仓库备份包",
      filters: [{ name: "表情包仓库备份", extensions: ["zip"] }],
    });
    if (typeof selected !== "string") return;
    const name = selected.split(/[\\/]/).pop() ?? selected;
    setConfirm({ kind: "import", path: selected, name });
  };

  const doImport = async (path: string) => {
    setBusy("import");
    setConfirm(null);
    try {
      const result = await api.importBackup(path);
      setReport(result);
      await props.refreshState();
      await load();
      props.notify(
        result.added > 0 ? `已从备份恢复 ${result.added} 张表情包` : "备份中的素材都已存在，没有新增",
        { kind: "success" },
      );
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async (fileName: string) => {
    setBusy(fileName);
    setConfirm(null);
    try {
      const result = await api.restoreBackup(fileName);
      setReport(result);
      await props.refreshState();
      await load();
      props.notify(result.added > 0 ? `已从备份恢复 ${result.added} 张` : "没有需要恢复的新素材", {
        kind: "success",
      });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async (fileName: string) => {
    setConfirm(null);
    try {
      await api.deleteBackup(fileName);
      await load();
      props.notify("备份已删除", { kind: "info" });
    } catch (error) {
      props.notify((error as { message: string }).message, { kind: "error" });
    }
  };

  return (
    <div className="backup-view">
      <header className="page-head">
        <div>
          <h2>备份与恢复</h2>
          <p>备份是普通的 zip 文件，包含原图、缩略图、分类分组和整理记录，可以复制到其他电脑恢复。</p>
        </div>
        <button className="button ghost icon-text" onClick={() => void api.openDataDir()}>
          <Icon name="external" size={15} />打开数据目录
        </button>
      </header>

      <div className="backup-cards">
        <section className="backup-card">
          <div className="backup-icon"><Icon name="database" size={22} /></div>
          <h3>立即备份</h3>
          <p>
            导出当前所有素材和元数据。上次备份：
            <strong>{props.state.meta.lastBackupAt ? formatRelative(props.state.meta.lastBackupAt) : "还没有备份过"}</strong>
          </p>
          <ul className="backup-points">
            <li>包含原图与缩略图，恢复后可直接使用</li>
            <li>只包含本机素材库数据，不含账号或密钥</li>
            <li>默认每天自动备份一次，最多保留 10 份</li>
          </ul>
          <button className="button primary wide" onClick={exportBackup} disabled={busy !== null}>
            {busy === "export" ? <Spinner /> : <Icon name="download" size={16} />}
            导出备份
          </button>
        </section>

        <section className="backup-card">
          <div className="backup-icon"><Icon name="upload" size={22} /></div>
          <h3>从备份恢复</h3>
          <p>选择本工具导出的 zip 备份包，按内容去重后合并进当前素材库。</p>
          <ul className="backup-points">
            <li>相同图片（按内容哈希）自动跳过，不会重复</li>
            <li>分类和分组按名称合并，缺失的会自动创建</li>
            <li>恢复动作会写入整理记录，可整批撤回</li>
          </ul>
          <button className="button soft wide" onClick={pickBackup} disabled={busy !== null}>
            {busy === "import" ? <Spinner /> : <Icon name="folder" size={16} />}
            选择备份包
          </button>
        </section>
      </div>

      {report && (
        <section className="restore-report">
          <header>
            <Icon name="check" size={16} />
            <strong>恢复结果</strong>
            <button className="icon-button" onClick={() => setReport(null)} aria-label="关闭结果">
              <Icon name="close" size={14} />
            </button>
          </header>
          <div className="report-grid">
            <span><strong>{report.added}</strong>新增</span>
            <span><strong>{report.duplicates}</strong>已存在</span>
            <span><strong>{report.missingFiles}</strong>缺失文件</span>
            <span><strong>{report.categoriesAdded}</strong>新分类</span>
            <span><strong>{report.groupsAdded}</strong>新分组</span>
          </div>
          {report.historyArchived && (
            <p className="report-note">备份中的整理记录已存档为 {report.historyArchived}</p>
          )}
        </section>
      )}

      <section className="backup-list-section">
        <header className="section-header">
          <h3>本机备份</h3>
          <span className="muted">{backups.length} 份</span>
        </header>
        {loading ? (
          <div className="loading-block"><Spinner /> 正在读取备份目录…</div>
        ) : backups.length === 0 ? (
          <EmptyState
            icon="database"
            title="还没有备份"
            description="点击“导出备份”，备份包会保存在数据目录的 backups 文件夹中。"
            action={<button className="button primary" onClick={exportBackup}>导出第一份备份</button>}
          />
        ) : (
          <div className="backup-table">
            <div className="backup-table-head">
              <span>文件名</span>
              <span>大小</span>
              <span>创建时间</span>
              <span>操作</span>
            </div>
            {backups.map((item) => (
              <div key={item.fileName} className="backup-row">
                <span className="backup-name" title={item.fileName}>
                  <Icon name="database" size={15} />
                  {item.fileName}
                </span>
                <span>{formatBytes(item.bytes)}</span>
                <span title={formatDateTime(item.createdAt)}>{formatRelative(item.createdAt)}</span>
                <span className="backup-actions">
                  <button
                    className="link-button"
                    disabled={busy !== null}
                    onClick={() => setConfirm({ kind: "restore", fileName: item.fileName })}
                  >
                    恢复
                  </button>
                  <button
                    className="link-button danger-text"
                    disabled={busy !== null}
                    onClick={() => setConfirm({ kind: "delete", fileName: item.fileName })}
                  >
                    删除
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="data-dir-card">
        <Icon name="folder" size={16} />
        <div>
          <strong>数据目录</strong>
          <code>{props.system?.dataDir ?? "—"}</code>
        </div>
        <button className="button ghost small" onClick={() => void api.openDataDir()}>打开</button>
      </div>

      {confirm?.kind === "import" && (
        <ConfirmDialog
          title="合并恢复备份"
          message={
            <>
              <p>即将从 <strong>{confirm.name}</strong> 恢复素材。</p>
              <p>已存在的图片会跳过；分类和分组按名称合并。恢复完成后可在“整理记录”中整批撤回。</p>
            </>
          }
          confirmLabel="开始恢复"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doImport(confirm.path)}
        />
      )}
      {confirm?.kind === "restore" && (
        <ConfirmDialog
          title="恢复这份备份？"
          message={<p>把 <strong>{confirm.fileName}</strong> 中的素材合并回当前素材库。已存在的图片会自动跳过。</p>}
          confirmLabel="恢复"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doRestore(confirm.fileName)}
        />
      )}
      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title="删除备份文件"
          message={<p>确认删除 <strong>{confirm.fileName}</strong>？删除后无法从程序内恢复这个备份包。</p>}
          confirmLabel="删除"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doDelete(confirm.fileName)}
        />
      )}
    </div>
  );
}
