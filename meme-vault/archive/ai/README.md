# AI 整理归档

本目录保存已从 meme-vault 移出的 AI 整理代码、界面快照、模拟服务与恢复补丁，**不参与当前构建、运行或测试**。

完整的移除原因、目录说明、恢复步骤和数据兼容说明见项目文档：[AI 功能归档](../../docs/AI功能归档.md)（`docs/AI功能归档.md`）。

快速入口：

- `rust/ai.rs`：原 AI 模块完整代码。
- `rust/removed-changes.patch`：移除前后的代码差异，可在项目根目录用 `git apply -R` 反向恢复。
- `frontend/SettingsView.snapshot.tsx`、`frontend/InboxView.snapshot.tsx`：移除前界面快照。
- `scripts/mock-ai.mjs`：原本地模拟服务。

恢复前请先阅读文档，并确认当前需求是否真的需要重新引入 AI；默认不要把本目录加入构建。
