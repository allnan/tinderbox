# AI 整理功能归档（2026-11-24）

AI 整理已从 meme-vault 主项目隔离移除，**当前不参与编译、运行、打包或测试**。主项目只保留本地规则整理；这里的代码仅作以后恢复时的参考，不代表当前功能。

## 归档原因

按项目当前阶段的要求，AI 能力暂不加入项目：不引入 AI 配置、不发送图片或素材信息到外部服务、不显示 AI 入口。核心代码和界面快照先移到这里，避免以后重写。

## 目录内容

归档代码位于项目根目录 [`archive/ai/`](../archive/ai/)；下表路径相对项目根目录：

| 路径 | 内容 |
| --- | --- |
| [`archive/ai/rust/ai.rs`](../archive/ai/rust/ai.rs) | 原 `src-tauri/src/ai.rs` 完整文件：预设、Prompt、请求、响应解析及单元测试 |
| [`archive/ai/rust/removed-changes.patch`](../archive/ai/rust/removed-changes.patch) | 从移除前工作区到移除后的完整差异；可用 `git apply -R` 反向恢复 |
| [`archive/ai/frontend/SettingsView.snapshot.tsx`](../archive/ai/frontend/SettingsView.snapshot.tsx) | 移除前设置页完整快照，含 AI 表单、预设、保存/测试连接逻辑 |
| [`archive/ai/frontend/InboxView.snapshot.tsx`](../archive/ai/frontend/InboxView.snapshot.tsx) | 移除前待整理页完整快照，含 AI 按钮、`runAi` 与剩余数量提示 |
| [`archive/ai/scripts/mock-ai.mjs`](../archive/ai/scripts/mock-ai.mjs) | 原本地模拟 OpenAI 兼容服务，用于 AI 端到端冒烟 |

快照文件是历史参考，**不在 `tsconfig.json` 的 `src` 范围内，也不参与构建**；其中引用的类型可能已从主项目删除。

## 恢复时需要的依赖

`src-tauri/Cargo.toml` 需要重新加入：

```toml
reqwest = { version = "0.13.5", features = ["json"] }

[dev-dependencies]
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

`base64` 仍被剪贴板导入使用，无需恢复。

## 恢复步骤

1. 把 `rust/ai.rs` 放回 `src-tauri/src/ai.rs`，在 `lib.rs` 恢复 `mod ai;`。
2. 按 `rust/removed-changes.patch` 反向恢复 Rust 侧集成：`AiConfig` / `AiView` / `AiPreset`、`Settings.ai`、`SettingsView.ai`、`SystemInfo.aiPresets`、`Settings::normalize` 的 AI 段、`propose_ai` / `test_ai` / `AiProposeResult`、`apply_settings_patch` 的 AI 分支、`lib.rs` 的命令注册，以及 `backup.rs` 导出设置中的 AI 段。
3. 按同一补丁恢复前端：`types.ts` 的 `AiSettings` / `AiPreset` / `AiProposeResult`、`api.ts` 的 `proposeAi` / `testAi`、设置页 AI 卡片、待整理页 AI 按钮与 `runAi`。
4. 若需要端到端冒烟，把 `scripts/mock-ai.mjs` 放回 `scripts/`，并恢复 `smoke.mjs` 中 `MOCK_AI_BASE` 分支。
5. 恢复后重新生成图标无需特殊处理；AI 不影响图标。

反向应用示例（在项目根目录执行）：

```powershell
git apply -R archive/ai/rust/removed-changes.patch
```

如果补丁因后续代码变动无法直接应用，以 `rust/ai.rs`、两个前端快照和 Git 历史为准手工合并。

## 数据兼容

- 旧 `settings.json` 里的 `ai` 配置会在新版本首次启动时被忽略，并在保存设置时从文件中清除；旧 API Key 不会继续明文保留。
- 旧的 `aiNote` 字段通过 `serde` 别名继续读取，新版本保存为 `organizeNote`（界面显示“整理备注”），不会丢失旧整理说明。
- 旧的 AI 建议仍作为“历史建议”展示，可继续忽略、应用或撤回，但新版本不会生成新的 AI 建议。
- 备份不再写入 AI 配置；旧备份中的 `settings.json` AI 段在恢复时会被忽略。

## 当前状态

主项目 `meme-vault` 的构建、测试、文档和界面均不包含 AI 功能；`npm run test` 中的 AI 解析/HTTP 测试已移除。恢复前不要从主项目引用本目录，以免重新把 AI 带入构建。
