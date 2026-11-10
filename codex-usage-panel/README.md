# Codex 用量预测

一个 Codex 桌面侧边栏插件，显示账号的 5 小时与周额度、重置时间、历史用量曲线、线性用量预测和完整 5 小时窗口的合理消耗区间。预测超过额度时显示超额百分比。当前源码版本为 **0.1.30**。

## 主要功能

- 同时显示 5 小时与周额度、用量条和重置倒计时。
- 从已有本机额度快照绘制历史曲线，并按当前窗口均速估算用量。
- 结合历史活跃时段与剩余周额度，估算完整 5 小时窗口的预算区间。
- 历史数据仅在本机读取和计算。

## 环境要求

- Node.js、Codex CLI 与 Codex 桌面端。
- 可通过本机 Codex 读取额度的已登录账号。

## 快速开始

在项目根目录执行以下命令，注册本地市场并安装插件：

```powershell
codex plugin marketplace add .
codex plugin add codex-usage-panel@codex-local-tools --json
```

安装后从 Codex 侧边栏打开“Codex 用量预测”。详细图表含义、更新方式和排障步骤见使用说明。

## 文档

- [使用说明](./docs/使用说明.md)：安装、额度图表、刷新和常见状态。
- [开发说明](./docs/开发说明.md)：设计约束、源码入口、验证与更新要求。
- [额度预算算法](./docs/额度预算算法.md)：数据、公式、参数、来源和验证范围。

预算区间尚未完成真实用户覆盖率验证，区间宽度与校准效果仍待评估。

插件源码位于 [plugins/codex-usage-panel](./plugins/codex-usage-panel/)，本地市场清单位于 [.agents/plugins/marketplace.json](./.agents/plugins/marketplace.json)。仓库协作与文档规则统一见 [AGENTS.md](../AGENTS.md)。
