# 终末地资源账本

跨 Windows x64 和 Android 的《明日方舟：终末地》资源记录工具。当前源码版本为 **2.7.3+28**，可记录四项资源、换算抽数、查看历史波动并在同一局域网内同步。

## 主要功能

- 记录特许寻访凭证、衍质源石、嵌晶玉和武库配额，计算角色与武库抽数。
- 按游戏日保存余额、备注和历史记录；图表显示余额走势或区间净变化。
- Windows 与 Android 均可发起局域网同步。2.7.3 两端会报告最新记录的发送/接收方向和实际变化的图表游戏日数。
- Windows 提供便携版，不写入 AppData 或注册表；程序数据位于 EXE 同级目录。

## 环境与快速开始

- Flutter SDK 版本约束见 [`pubspec.yaml`](./pubspec.yaml)；需安装对应 Windows 或 Android 平台工具链。
- 在项目根目录执行：

  ```powershell
  flutter pub get
  flutter run -d windows
  ```

- 构建 Windows x64 便携包：

  ```powershell
  flutter build windows --release
  .\tool\package_portable.ps1
  ```

  默认生成 `release/终末地资源账本-2.7.3/` 目录和同名 `.zip`。已有输出目录或 ZIP 时，脚本会拒绝覆盖；重复打包必须用 `-OutputDirectory` 指定一个尚不存在的新目录，例如在项目根目录执行：

  ```powershell
  .\tool\package_portable.ps1 -OutputDirectory .\release\终末地资源账本-2.7.3-rebuild
  ```

  默认只打包；仅同时指定 `-InstallAfterPackage` 和 `-InstallDirectory` 时才部署。发布产物不纳入 Git。

## 文档

- [使用说明](./docs/使用说明.md)
- [开发说明](./docs/开发说明.md)
- [换算与记录规则](./docs/换算与记录规则.md)
- [验证记录](./docs/验证记录.md)

本项目为非官方玩家工具。游戏素材及相关权利归原权利人；素材来源和换算依据见[规则文档](./docs/换算与记录规则.md)。
