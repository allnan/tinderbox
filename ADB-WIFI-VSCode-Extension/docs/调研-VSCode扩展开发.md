# 调研：VS Code 扩展开发

调研时间：2026-11-22。VS Code 侧事实以 code.visualstudio.com/api 官方文档为准，版本信息另核对官方发布清单、npm registry 与 microsoft 官方示例。调研时的开发机基线：VS Code 1.147.0、Node.js 22、npm 11。

## 1. 结论速览

- **版本基线**：`engines.vscode` 与 `@types/vscode` 必须一致（官方示例为 `^1.100.0`）；TypeScript 编译为 CommonJS 到 `out/`；扩展宿主 Node 版本由 VS Code 决定，与系统 Node 无关。
- **激活事件**：VS Code 1.74 起，命令 / 视图 / 配置等贡献点会自动生成激活事件，`activationEvents` 可留空；本扩展保留 `onStartupFinished` 以便启动后即显示状态栏。
- **Webview**：运行在独立 iframe，**没有 Node / require / vscode 模块**，也不能直接读本地文件；资源必须 `asWebviewUri` + `localResourceRoots`，禁止 `file://`；CSP 使用 `cspSource` + nonce；数据只能通过 `postMessage`。
- **子进程**：Windows 调 adb 用 `spawn(绝对路径, 参数数组, { windowsHide: true })`；不要拼 shell 字符串；超时后 kill；长驻 mDNS 监听保存 ChildProcess 并在 `deactivate` / 面板关闭时清理。
- **调试**：F5（extensionHost + `--extensionDevelopmentPath`）启动 Extension Development Host；改代码后「开发人员: 重新加载窗口」。
- **打包**：`@vscode/vsce package` 生成 VSIX（`vscode:prepublish` 会先编译），`code --install-extension xxx.vsix --force` 本地安装。

## 2. 最小项目结构

```text
扩展项目/
├─ .vscode/launch.json      # F5：type=extensionHost，args 传 --extensionDevelopmentPath
├─ .vscode/tasks.json       # tsc -watch 后台任务（$tsc-watch problemMatcher）
├─ .vscodeignore            # 打包排除 src/docs/tsconfig/map 等
├─ package.json             # 扩展清单：唯一 ID = publisher.name
├─ tsconfig.json
├─ src/extension.ts         # main 指向编译产物 out/extension.js
├─ media/                   # Webview 前端资源
└─ out/                     # tsc 输出
```

`package.json` 关键字段：`name`（小写）、`publisher`、`version`（SemVer）、`engines.vscode`（必填）、`main`（JS 入口）、`contributes.commands / configuration / viewsContainers / views / menus / viewsWelcome`、`scripts.vscode:prepublish`。本地打包也必须填写 `publisher`。

## 3. 扩展清单贡献点

- `contributes.commands`：命令标题、分类、图标（`$(refresh)` 等 codicon）；命令在命令面板出现，视图内联菜单用 `menus.view/item/context` 配 `group: inline@N`。
- `contributes.configuration`：配置项 `type/default/minimum/description`，代码里用 `workspace.getConfiguration` 读取。
- `contributes.viewsContainers.activitybar`：活动栏容器（`id/title/icon`）；`contributes.views`：树视图或 WebviewView；`viewsWelcome`：空视图引导按钮（`[标题](command:xxx)`）。
- 树视图实现 `TreeDataProvider<T>`（`getTreeItem/getChildren/onDidChangeTreeData`），`window.registerTreeDataProvider` 注册；本扩展最初使用树视图，现侧边栏设备 / 配对视图已改为 WebviewView，以支持富卡片与文字按钮。

## 4. Webview 要点（官方文档明确要求）

- `enableScripts` 默认 **false**，必须显式开启；`webview.html` 必须是完整 HTML 文档。
- 本地资源：`webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'main.js'))`；`localResourceRoots` 收紧到 `media` 目录。
- CSP 最小可用：`default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';`；外链脚本写 `<script nonce>`，nonce 每次随机生成。
- 扩展 → 页面：`webview.postMessage(json)`；页面 → 扩展：`acquireVsCodeApi().postMessage(json)` + `webview.onDidReceiveMessage`。消息必须是 JSON 可序列化数据。
- 面板关闭后内容销毁；需要保留状态时用 `vscode.getState()/setState()`，`retainContextWhenHidden` 内存开销较大。本扩展使用 `retainContextWhenHidden: true` 换取状态简单保留。
- 持有面板引用，`onDidDispose` 清理订阅 / 定时器 / 子进程；对已销毁 Webview 发送消息会抛异常。

## 5. 调用外部 adb（扩展宿主中）

- 使用 `child_process.spawn` / `execFile` 的参数数组形式，Windows 直接调用 `adb.exe` 绝对路径，无需 shell，避免中文路径与注入问题。
- 必须设置 `windowsHide: true`，否则 Windows 会闪黑窗。
- Node 默认按 UTF-8 解码；adb 输出通常为 UTF-8。若遇到 GBK 来源可先取 Buffer，再用 `new TextDecoder('gbk')` 解码。
- 超时：`execFile` 可用 `timeout`/`signal`；本扩展对 `spawn` 自建定时器，超时 `kill('SIGKILL')`。
- 长驻任务（mDNS 监听）保存 ChildProcess，在 `deactivate` / `dispose` 时 kill；子进程异常退出后按 8 秒重试。
- 配置中的路径视为不可信输入：校验存在性与文件类型后再使用。

## 6. 状态、隐私与错误处理

- `context.globalState / workspaceState` 存少量 JSON 状态；`context.secrets` 存敏感信息（本扩展不保存配对码）；`storageUri` 存日志文件。
- 日志脱敏：配对码、设备标识、IP 写入输出面板前应谨慎；本扩展配对码只用于当前命令，输出中的配对码会被替换为 `[REDACTED_SECRET]`。
- 用户可见错误统一落到状态行 / 通知，开发日志写 OutputChannel，避免 Promise 未捕获异常。

## 7. 调试、打包、本地安装

```powershell
npm install
npm run compile
# VS Code 内按 F5 → Extension Development Host

npm run package
code --install-extension .\dist\adb-wifi-connect-0.1.0.vsix --force
code --list-extensions | Select-String adb
```

- `@vscode/vsce` 需要 Node.js 22+；首次打包会执行 `vscode:prepublish`。本项目 devDependencies 固定 `^3.2.1`。
- 本项目打包脚本使用 `--no-dependencies` 跳过 npm 依赖探测；若打包环境仍禁止 vsce 启动子进程，需换普通终端或解除限制。
- 安装后需要重新加载窗口才生效。

## 8. 常见坑

| 坑 | 现象 | 对策 |
| --- | --- | --- |
| Webview 里 `require('vscode')` / `fs` | ReferenceError | Webview 是浏览器环境；逻辑放扩展侧，用消息通信 |
| HTML 直接写本地路径 / `file://` | 资源 404、白屏 | `asWebviewUri` + `localResourceRoots` |
| 未配 CSP 或 inline 脚本 | 脚本不执行、安全警告 | nonce + 外链 JS，CSS 放 `media/` |
| `webview.html` 只给片段 | 渲染异常 | 完整 HTML 文档 |
| 忘记 dispose | 泄漏、关面板后报错 | `context.subscriptions` / `onDidDispose` |
| 状态栏不显示 | 创建后没 `show()` | 显式 `statusBarItem.show()` |
| Windows adb 闪黑窗 | 屏幕闪烁 | `windowsHide: true` |
| 扩展宿主 Node 与系统 Node 不一致 | 新语法运行时报错 | 以扩展宿主为准，`@types/node` 对齐 |
| 把源码打进 VSIX | 包体积大 | `.vscodeignore` 排除 `src/**`、`**/*.ts`、`tsconfig.json`、`docs/**` |

## 9. 官方文档索引

- 入门与结构：<https://code.visualstudio.com/api/get-started/your-first-extension>
- 扩展解剖：<https://code.visualstudio.com/api/get-started/extension-anatomy>
- 清单参考：<https://code.visualstudio.com/api/references/extension-manifest>
- 激活事件：<https://code.visualstudio.com/api/references/activation-events>
- 贡献点：<https://code.visualstudio.com/api/references/contribution-points>
- VS Code API：<https://code.visualstudio.com/api/references/vscode-api>
- Webview：<https://code.visualstudio.com/api/extension-guides/webview>
- TreeView：<https://code.visualstudio.com/api/extension-guides/tree-view>
- 测试与调试：<https://code.visualstudio.com/api/working-with-extensions/testing-extension>
- 打包发布：<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>
- 官方示例：<https://github.com/microsoft/vscode-extension-samples>
- 脚手架：<https://github.com/microsoft/vscode-generator-code>
- Node 子进程：<https://nodejs.org/api/child_process.html>

