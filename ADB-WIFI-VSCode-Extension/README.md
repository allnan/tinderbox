# ADB WIFI 无线调试（VS Code 扩展）

在 VS Code 中完成 Android 无线调试：二维码 / 配对码配对、设备发现、无线连接、断开与解除配对，以及 ADB 诊断。

用户安装后即可使用，无需命令行操作；详细操作见[使用说明](./docs/使用说明.md)。

## 功能

- 二维码配对 / 配对码配对
- 自动发现同一局域网内开启无线调试的手机
- 连接、断开、解除配对，复制 ADB 地址
- 记住上次设备，VS Code 重启后可重连
- 显示 ADB、mDNS 与配对记录状态，并提供诊断

## 开发

环境：Windows 10 / 11、Node.js 22+、VS Code 1.100+；手机端 Android 11+，并确保本机可用的 ADB 在 PATH 中或被配置指定。

```powershell
npm install
npm run compile                 # 编译到 out/
node --test out/test/parse.test.js
```

在 VS Code 中按 F5 启动 Extension Development Host 调试。完整说明见[开发说明](./docs/开发说明.md)。

## 打包

```powershell
npm run package                 # 输出 dist/adb-wifi-wireless-0.1.0.vsix
```

打包使用 `--readme-path README.extension.md`：VSIX 里的扩展介绍页来自 `README.extension.md`，仓库首页继续使用本文件。VSIX 输出到 `dist/`，不提交。

## 目录结构

```text
src/          扩展源码（激活、面板、侧边栏、服务、ADB）
media/        Webview 前端资源
docs/         使用与开发文档
out/          编译产物（不提交）
dist/         VSIX 构建产物（不提交）
```

## 文档

- [使用说明](./docs/使用说明.md)
- [开发说明](./docs/开发说明.md)
- [移植说明](./docs/移植说明.md)
- [调研：VS Code 扩展开发](./docs/调研-VSCode扩展开发.md)

## 反馈

问题与建议请提交到 [GitHub Issues](https://github.com/allnan/tinderbox/issues)。

MIT License
