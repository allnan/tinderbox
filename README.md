# Tinderbox

这里存放我借助 AI 开发的一些小工具和小项目。每个工具或项目使用独立文件夹，分别维护源码、依赖和使用说明。

## 项目目录

| 项目 | 简介 | 目录 |
| --- | --- | --- |
| ADB 无线调试 | Windows 桌面工具，提供 Android 无线调试的二维码与配对码配对、设备发现、连接及历史配对管理。 | [ADB-connect-tool](./ADB-connect-tool/) |
| Codex 用量预测 | Codex 桌面侧边栏插件，显示 5 小时与周额度、重置时间、历史用量曲线和用量预测。 | [codex-usage-panel](./codex-usage-panel/) |
| 配色工坊 | Windows 桌面工具，为前端项目生成、管理、检查并导出配色方案。 | [palette-studio](./palette-studio/) |
| 晚安定时关机 | Windows 桌面工具，按倒计时或指定时刻安排强制关机，并提供取消与分区时间预览。 | [goodnight-shutdown-tool](./goodnight-shutdown-tool/) |
| 终末地资源账本 | Windows x64 与 Android 资源记录工具，提供抽数换算、游戏日趋势和局域网同步。 | [endfield-resources-tools](./endfield-resources-tools/) |

新增项目后，必须在此登记项目名称、一句话简介和对应文件夹的相对链接。

## 项目文档

- ADB 无线调试：[使用说明](./ADB-connect-tool/docs/使用说明.md) · [开发说明](./ADB-connect-tool/docs/开发说明.md)。
- Codex 用量预测：[使用说明](./codex-usage-panel/docs/使用说明.md) · [开发说明](./codex-usage-panel/docs/开发说明.md) · [额度预算算法](./codex-usage-panel/docs/额度预算算法.md)。
- 配色工坊：[使用说明](./palette-studio/docs/使用说明.md) · [开发说明](./palette-studio/docs/开发说明.md) · [取色器说明](./palette-studio/docs/取色器说明.md) · [项目交接](./palette-studio/docs/项目交接.md) · [更新日志](./palette-studio/docs/更新日志.md)。
- 晚安定时关机：[使用说明](./goodnight-shutdown-tool/docs/使用说明.md) · [开发说明](./goodnight-shutdown-tool/docs/开发说明.md)。
- 终末地资源账本：[使用说明](./endfield-resources-tools/docs/使用说明.md) · [开发说明](./endfield-resources-tools/docs/开发说明.md) · [换算与记录规则](./endfield-resources-tools/docs/换算与记录规则.md) · [验证记录](./endfield-resources-tools/docs/验证记录.md)。

## 存放方式

- 每个工具或小项目必须放在仓库根目录下的独立文件夹中，目录名必须便于识别用途。
- 每个项目必须提供自己的 `README.md`，说明用途、运行或使用方法及必要依赖。
- 每个项目必须使用 `docs/` 存放详细文档：`开发说明.md` 记录技术与验证要求，`使用说明.md` 记录详细操作，算法等专题按实际内容单独编写。
- 项目的源码、依赖声明、构建配置和专属资料必须放在对应项目文件夹内。
- 新增、迁移、删除项目，或调整项目用途时，必须同步更新本页的项目目录和简介。

## 使用方式

从上方目录进入具体项目，先阅读该项目的 `README.md`，再按其中的说明安装依赖、运行或使用。

## AI 协作

AI 开发与维护必须遵守仓库根目录的 [AGENTS.md](./AGENTS.md)。项目专属技术约束统一记录在各项目的 `docs/开发说明.md`。
