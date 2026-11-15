# 真实推文解析 Rust 原型（poc/tweet-fetch）

> **状态：POC，已验证可访问真实公开 X 推文。** 本目录是 [X 媒体工坊（Tauri 预览版）](../../) 的推文解析后端原型，
> 独立 Cargo 工程，移植自 Electron 版 `x-gif-studio/electron/lib/tweet.cjs`；**不修改 x-gif-studio 的任何源码**。

## 用途

- 解析 x.com / twitter.com 推文链接；
- 按 **fxtwitter v2 → fxtwitter v1 → syndication → vxtwitter** 顺序请求公开接口，归一化为与
  `x-gif-studio/src/shared/types.ts` 中 `TweetInfo` / `TweetMedia` 一致的 JSON；
- 支持系统代理 / 自定义代理（http、https、socks5）/ 直连三种模式，以及代理 Basic 认证与 bypass 列表；
- 提供可直接复用的库（`src/`）与命令行工具（`tweet-fetch`），供主 Tauri 后端集成。

接口契约、移植细节与集成步骤见 [docs/PORT-tweet.md](../../docs/PORT-tweet.md)。

## 依赖与构建

- Rust 1.85+（实测 rustc / cargo 1.94.0）；Cargo 会自动下载 crates.io 依赖
  （reqwest 0.13、serde、serde_json、regex、time）；
- 需要能访问 `api.fxtwitter.com`、`cdn.syndication.twimg.com`、`api.vxtwitter.com`；
- 如果本机访问 crates.io 需要代理，请在运行 cargo 前设置环境变量（不要把个人代理配置写进仓库）：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY = "http://127.0.0.1:7890"
cargo build
```

## 快速开始

在本目录执行（下面的真实链接与证据文件均为公开推文数据）：

```powershell
# 构建
cargo build

# 抓取真实推文（默认 system 代理模式），stdout 输出 TweetInfo JSON
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005

# 把 JSON 同时写入文件，并在 stderr 打印接口回退过程
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --verbose --output out/tweet.json

# 自定义代理（http / https / socks5，支持裸 host:port）
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --proxy http://127.0.0.1:7890
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --proxy socks5://127.0.0.1:1080

# 指定只走某个接口，便于排障
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --only syndication --verbose
```

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--proxy <url>` | 自定义代理：`http://host:port`、`https://host:port`、`socks5://host:port` 或裸 `host:port`（按 http） |
| `--proxy-mode <mode>` | `system`（默认）/ `custom` / `direct`；给出 `--proxy` 且未指定模式时按 `custom` |
| `--proxy-user` / `--proxy-pass` | 代理 Basic 认证用户名 / 密码 |
| `--proxy-bypass <list>` | 不走代理的主机，分号/逗号/空格分隔（默认 `localhost;127.0.0.1;<local>`） |
| `--timeout-ms <n>` | 单个接口超时毫秒数（默认 15000，与 Electron 版一致） |
| `--only <labels>` | 只尝试指定接口，逗号分隔：`fxtwitter,fxtwitter-v1,syndication,vxtwitter` |
| `--output <path>` | 同时把 JSON 写入文件（UTF-8、无 BOM） |
| `--compact` | 输出紧凑 JSON（默认缩进） |
| `-v` / `--verbose` | 在 stderr 输出回退尝试过程与最终数据来源 |
| `-h` / `--help` | 帮助 |

## 输出与退出码

- 成功：stdout 为 `TweetInfo` JSON（字段与 TypeScript 契约一致，camelCase），退出码 **0**；
- 失败：stdout 为 `{"ok":false,"error":{"code":"...","message":"..."}}`，stderr 输出中文错误，退出码 **2**；
- 参数错误退出码 **1**，写输出文件失败退出码 **3**。

## 真实请求证据

`evidence/` 保存了本机对公开推文
`https://x.com/lapislazulidm/status/2119254989323588005` 的真实请求结果（2026-11-15）：

| 文件 | 请求方式 | 结果 |
| --- | --- | --- |
| `real-fetch-fxtwitter-2119254989323588005.json` | 默认回退链 | `source: fxtwitter`，作者 L.L.（@lapislazulidm），正文「#初星学園ぬいぬい部 GIF2」，4 个 GIF（mp4 地址） |
| `real-fetch-syndication-2119254989323588005.json` | `--only syndication` | `source: syndication`，同一作者/正文/4 个媒体，头像规范为 `_400x400` |
| `real-fetch-via-dev-proxy-2119254989323588005.json` | `--proxy http://127.0.0.1:18990`（本机 dev-proxy） | 代理日志出现 `CONNECT api.fxtwitter.com:443`，数据与默认链一致 |
| `real-fetch-via-dev-proxy-auth-2119254989323588005.json` | 同上 + `--proxy-user demo --proxy-pass secret`（dev-proxy 开启认证） | Basic 认证通过并取到真实数据 |

完整验证记录见 [docs/PORT-tweet.md](../../docs/PORT-tweet.md) 第 10 节。

## 测试

```powershell
# 离线单元测试（链接解析、归一化、token 算法、代理解析、缓存等，共 31 项）
cargo test

# 真实网络回归测试（默认 ignored，需要可上网环境）
cargo test --test real_network -- --ignored
```

## 已知限制

- 这是 POC：只做「解析 + 归一化」，**不下载媒体、不做 GIF/WebP 转换、未接入 Tauri 命令**；
- 第 4 回退 vxtwitter 在当前验证网络被 Cloudflare 拦截（HTTP 403），会按 Electron 版语义归类为
  `TWEET_PROTECTED`；主链路 fxtwitter 与 syndication 均正常；
- 默认 `system` 代理模式依赖 reqwest 0.13 的系统代理实现，与 Electron/Chromium 的 WinINET 行为
  不一定完全一致（本机验证可用）；主 Tauri 后端建议优先使用设置页的 `custom` 代理；
- 依赖较新：reqwest 0.13 要求 Rust 1.85+（项目文档原先记录 1.77.2+，集成时需同步升级说明）。
