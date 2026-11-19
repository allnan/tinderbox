# Tinderbox

这里存放我借助 AI 开发的一些小工具、小项目和可复用组件库。每个项目使用独立文件夹，分别维护源码、依赖和使用说明。

## 项目目录

项目按用途分为两类：**小工具与应用**（可直接运行、解决具体问题的桌面端、移动端或插件）和 **组件与依赖库**（供其他项目引用的代码库）。

### 小工具与应用

| 项目 | 简介 | 开发状态 | 目录 |
| --- | --- | --- | --- |
| ADB 无线调试 | Windows 桌面工具，提供 Android 无线调试的二维码与配对码配对、设备发现、连接及历史配对管理。 | v1.3.7.0；mDNS 发现异常待复现。 | [ADB-connect-tool](./ADB-connect-tool/) |
| Clash 订阅与流量管理 | Tauri Windows 便携桌面工具，合并原始订阅、按服务商标记节点、编辑策略组并查看 Mihomo 流量历史。 | 主要功能已实现；模板导入限于已支持的常见格式。 | [clash-flow-manager](./clash-flow-manager/) |
| Codex 用量预测 | Codex 桌面侧边栏插件，显示 5 小时与周额度、重置时间、历史用量曲线和用量预测。 | v0.1.30；真实使用窗口的预测校准待评估。 | [codex-usage-panel](./codex-usage-panel/) |
| 配色工坊 | Windows 桌面工具，为前端项目生成、管理、检查并导出配色方案。 | 功能已实现；验收基线通过。 | [palette-studio](./palette-studio/) |
| 表情包仓库 | Windows 相册式表情包工具：全局热键快速呼出、点一下即复制，主界面按相册拖动整理，并提供可撤回的规则与 AI 整理。 | **已暂停（2026-11-19）**；v0.1.0；单文件便携版，构建、18 项单测、26 项 UI 运行时冒烟（主界面 + 快捷窗口）、release 无窗口自检与 12/12 端到端冒烟通过；AI 真实服务与第三方应用粘贴场景待验证。 | [meme-vault](./meme-vault/) |
| 晚安定时关机 | Windows 桌面工具，按倒计时或指定时刻安排强制关机，并提供取消与分区时间预览。 | 逻辑测试通过；界面与真实关机结果待验证。 | [goodnight-shutdown-tool](./goodnight-shutdown-tool/) |
| 终末地资源账本 | Windows x64 与 Android 资源记录工具，提供抽数换算、游戏日趋势和局域网同步。 | v2.7.3+28；真实设备间局域网同步待验证。 | [endfield-resources-tools](./endfield-resources-tools/) |
| X 媒体工坊 | Windows 桌面工具，Tauri 版：解析 X（Twitter）推文并保存原始媒体，导出 GIF/WebP；Rust 后端，exe 约 4.7 MB，工具按需下载。 | 真实功能版；自动验证 15/15 项通过。 | [x-gif-studio-tauri](./x-gif-studio-tauri/) |
| 阿咬宠物机 | 手机优先的像素风虚拟宠物，支持部位触摸、场景移动、追叶子、躲猫猫、喂食护理和日常陪伴记录。 | v1.7；新增交互与新版真机画面待验证。 | [yao-pocket-pet](./yao-pocket-pet/) |
| 拼好猫（待做） | 待做的猫主题项目，当前仅保存原始想法。 | 尚未开发；仅保存原始想法。 | [pin-hao-mao](./pin-hao-mao/) |

### 组件与依赖库

| 项目 | 简介 | 开发状态 | 目录 |
| --- | --- | --- | --- |
| 取色器（独立库） | 从配色工坊独立出来的取色器设计存档与 React 参考实现，含 OKLCH 全彩色域图、三种取色方式与演示页。 | v0.1.0；构建、12 项测试与演示冒烟通过，浏览器截图待完整桌面环境验证。 | [color-picker](./color-picker/) |

新增项目后，必须在此登记项目名称、一句话简介、所属分类和对应文件夹的相对链接。

## 项目文档

### 小工具与应用

- ADB 无线调试：[使用说明](./ADB-connect-tool/docs/使用说明.md) · [开发说明](./ADB-connect-tool/docs/开发说明.md)。
- Clash 订阅与流量管理：[使用说明](./clash-flow-manager/docs/使用说明.md) · [开发说明](./clash-flow-manager/docs/开发说明.md)。
- Codex 用量预测：[使用说明](./codex-usage-panel/docs/使用说明.md) · [开发说明](./codex-usage-panel/docs/开发说明.md) · [额度预算算法](./codex-usage-panel/docs/额度预算算法.md)。
- 配色工坊：[使用说明](./palette-studio/docs/使用说明.md) · [开发说明](./palette-studio/docs/开发说明.md) · [取色器说明](./palette-studio/docs/取色器说明.md) · [项目交接](./palette-studio/docs/项目交接.md) · [更新日志](./palette-studio/docs/更新日志.md)。
- 表情包仓库：[使用说明](./meme-vault/docs/使用说明.md) · [开发说明](./meme-vault/docs/开发说明.md)。
- 晚安定时关机：[使用说明](./goodnight-shutdown-tool/docs/使用说明.md) · [开发说明](./goodnight-shutdown-tool/docs/开发说明.md)。
- 终末地资源账本：[使用说明](./endfield-resources-tools/docs/使用说明.md) · [开发说明](./endfield-resources-tools/docs/开发说明.md) · [换算与记录规则](./endfield-resources-tools/docs/换算与记录规则.md) · [验证记录](./endfield-resources-tools/docs/验证记录.md)。
- X 媒体工坊：[使用说明](./x-gif-studio-tauri/docs/使用说明.md) · [开发说明](./x-gif-studio-tauri/docs/开发说明.md) · [推文解析移植说明](./x-gif-studio-tauri/docs/PORT-tweet.md) · [转换移植说明](./x-gif-studio-tauri/docs/PORT-convert.md)。
- 阿咬宠物机：[使用说明](./yao-pocket-pet/docs/使用说明.md) · [开发说明](./yao-pocket-pet/docs/开发说明.md) · [资料来源与角色设定](./yao-pocket-pet/docs/资料来源与角色设定.md) · [设计核对](./yao-pocket-pet/docs/设计核对.md)。
- 拼好猫（待做）：[想法记录](./pin-hao-mao/docs/想法记录.md) · [开发说明](./pin-hao-mao/docs/开发说明.md)。

### 组件与依赖库

- 取色器（独立库）：[设计方案](./color-picker/docs/设计方案.md) · [全彩取色算法](./color-picker/docs/全彩取色算法.md) · [使用说明](./color-picker/docs/使用说明.md) · [开发说明](./color-picker/docs/开发说明.md)。

## 存放方式

- 每个工具或小项目必须放在仓库根目录下的独立文件夹中，目录名必须便于识别用途。
- 项目目录按「小工具与应用」「组件与依赖库」两类分组维护；新增项目必须归入对应分组。
- 每个项目必须提供自己的 `README.md`，说明用途、运行或使用方法及必要依赖。
- 每个项目必须使用 `docs/` 存放详细文档：`开发说明.md` 记录技术与验证要求，`使用说明.md` 记录详细操作，算法等专题按实际内容单独编写。
- 项目的源码、依赖声明、构建配置和专属资料必须放在对应项目文件夹内。
- 新增、迁移、删除项目，或调整项目用途时，必须同步更新本页的项目目录、简介和分组。

## 使用方式

从上方目录进入具体项目，先阅读该项目的 `README.md`，再按其中的说明安装依赖、运行或使用。

## AI 协作

AI 开发与维护必须遵守仓库根目录的 [AGENTS.md](./AGENTS.md)。项目专属技术约束统一记录在各项目的 `docs/开发说明.md`。
