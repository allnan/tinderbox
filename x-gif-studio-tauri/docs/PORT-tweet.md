# 真实推文解析移植说明（tweet.cjs → Rust）

> 状态：**POC 已完成真实请求验证**。本文档供主 Tauri 后端（`x-gif-studio-tauri/src-tauri`）集成推文解析能力。
>
> - 移植来源：[x-gif-studio/electron/lib/tweet.cjs](../../x-gif-studio/electron/lib/tweet.cjs)（只读，不修改 x-gif-studio）
> - 类型契约：[x-gif-studio/src/shared/types.ts](../../x-gif-studio/src/shared/types.ts) 中的 `TweetInfo` / `TweetMedia`
> - Rust POC：[x-gif-studio-tauri/poc/tweet-fetch](../poc/tweet-fetch/)
> - 真实请求证据：[evidence/](../poc/tweet-fetch/evidence/)（2026-11-15 实测）

## 1. 目的与范围

目标：在不依赖 Electron / Chromium 网络栈的前提下，为 Tauri 版主后端提供与 Electron 版行为一致的
「推文链接解析 + 公开接口抓取 + 媒体信息归一化」能力，供后续媒体下载与 GIF/WebP 转换复用。

本次 POC 已实现：

- 解析 x.com / twitter.com / mobile.twitter.com 链接（含 `/photo/1`、查询参数、粘贴包裹字符）；
- 按 **fxtwitter v2 → fxtwitter v1 → syndication → vxtwitter** 顺序请求并回退；
- 归一化 `TweetInfo` / `TweetMedia`（字段与 TypeScript 契约一致，JSON 为 camelCase）；
- 代理参数：`system` / `custom` / `direct` 三种模式，http/https/socks5 代理、Basic 认证、bypass 列表；
- 最近解析结果缓存（20 条，等价 Electron 版 `getCached`）；
- 独立 CLI（`tweet-fetch`）用于真实请求验证与排障；库代码可直接被 Tauri 后端引用。

本次 POC **未实现**（后续工作，见第 13 节）：媒体文件下载、GIF/WebP 转换、Tauri 命令接线、
设置页代理密码加密存储、取消/重试策略、渲染进程缩略图代理。

## 2. 代码位置与模块职责

工程根目录：`x-gif-studio-tauri/poc/tweet-fetch/`（独立 Cargo 工程，package `xgif-tweet-fetch-poc`，lib `xgif_tweet_fetch`）。

| 文件 | 职责 | 复用方式 |
| --- | --- | --- |
| `src/model.rs` | `TweetAuthor` / `MediaVariant` / `TweetMedia` / `TweetInfo` / `MediaKind` / `TweetSource`（serde camelCase） | 直接复用，作为前后端 JSON 契约 |
| `src/error.rs` | `TweetError` / `TweetErrorCode`（与 Electron 版错误码/中文消息一致） | 直接复用；Tauri 命令映射为 `OperationResult` |
| `src/parse.rs` | `parse_tweet_url`：推文链接解析 | 直接复用 |
| `src/token.rs` | syndication 接口 token；逐位复刻 V8 `Number.prototype.toString(36)` | 直接复用（已对照 Node 输出验证） |
| `src/timeutil.rs` | ISO 8601 / RFC 2822 / ctime 风格时间 → 毫秒精度 ISO 字符串 | 直接复用 |
| `src/normalize.rs` | `normalize_fx_tweet` / `normalize_syndication` / `normalize_vx_tweet` 及媒体辅助函数 | 直接复用 |
| `src/proxy.rs` | `ProxyMode` / `ProxySettings` / `parse_proxy_url` / `build_bypass_rules` / `build_client` | 直接复用；也可只取地址解析规则 |
| `src/cache.rs` | 进程级 `TweetCache`（20 条）+ `remember_tweet` / `get_cached` / `clear_cache` | 直接复用 |
| `src/fetch.rs` | `fetch_tweet` / `fetch_tweet_with_report`：四级回退主流程 | 直接复用 |
| `src/main.rs` | CLI 参数解析与 JSON 输出 | 仅用于验证/排障，不集成 |
| `tests/real_network.rs` | 真实网络回归测试（默认 ignored） | 集成测试参考 |
| `evidence/` | 真实公开推文请求结果 | 验证证据 |

依赖（`Cargo.toml`）：`reqwest 0.13`（blocking / json / socks / native-tls / system-proxy）、`serde`、
`serde_json`、`regex`、`time`。**MSRV 1.85**（reqwest 0.13 要求；项目文档原先记录 Rust 1.77.2+，集成时需同步升级）。

## 3. 与 Electron 实现的对应关系

| Electron（`electron/lib/tweet.cjs`） | Rust（`poc/tweet-fetch`） | 一致性说明 |
| --- | --- | --- |
| `parseTweetUrl(url)` | `parse::parse_tweet_url` | 相同的去包裹字符、去 scheme/www/mobile 前缀、相同正则与 canonicalUrl 生成 |
| `syndicationToken(id)` | `token::syndication_token` | 相同公式；36 进制格式化按 V8 源码算法复刻（见 6.2） |
| `fetchTweet(url)` | `fetch::fetch_tweet` / `fetch_tweet_with_report` | 相同四级回退顺序、相同错误归类与中文消息 |
| `normalizeFxTweet` | `normalize::normalize_fx_tweet` | v2/v1 共用；作者、媒体、变体、时长、原图规则一致 |
| `normalizeSyndication` | `normalize::normalize_syndication` | Tombstone 过滤、头像 `_400x400`、媒体 id 派生规则一致 |
| `normalizeVxTweet` | `normalize::normalize_vx_tweet` | 字段与回退规则一致 |
| `getCached/rememberTweet/clearCache` | `cache::get_cached/remember_tweet/clear_cache` | 容量 20，重复 id 置前，等价最近使用语义 |
| `network.cjs`（Chromium net.fetch + session 代理） | `proxy::build_client` + reqwest `Proxy` | 代理模式语义对齐，底层实现不同（见第 8 节） |
| 全局 `fetch` 静态守卫（禁止绕过 network.cjs） | 库内所有请求统一走 `build_client` 创建的 `Client` | 调用方无需/不应自行发请求 |

未移植（Electron 版也不在 `tweet.cjs` 内）：媒体下载、缩略图生成、GIF 转换、历史记录，
由后续 `media.cjs` / `gif.cjs` 的移植工作负责。

## 4. 数据契约（Rust ↔ TypeScript）

Rust 侧与 `x-gif-studio/src/shared/types.ts` 字段一一对应，serde 使用 `camelCase`：

```rust
pub enum MediaKind { Gif, Video, Photo }          // 序列化为 "gif" / "video" / "photo"
pub enum TweetSource { FxTwitter, Syndication, VxTwitter } // "fxtwitter" / "syndication" / "vxtwitter"

pub struct TweetAuthor {
    pub name: String,
    pub screen_name: String,     // JSON: screenName
    pub avatar_url: Option<String>, // null 允许
    pub verified: bool,
}

pub struct MediaVariant {
    pub url: String,
    pub bitrate: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub struct TweetMedia {
    pub id: String,              // 媒体 id；缺失时 "media-<序号>"
    pub kind: MediaKind,
    pub source_url: String,      // gif/video 为 mp4，photo 为原图
    pub thumbnail_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_sec: Option<f64>,
    pub variants: Vec<MediaVariant>,
}

pub struct TweetInfo {
    pub id: String,
    pub url: String,
    pub author: TweetAuthor,
    pub text: String,
    pub created_at: Option<String>, // ISO 毫秒字符串或 null
    pub media: Vec<TweetMedia>,
    pub source: TweetSource,
    pub fetched_at: String,
}
```

字段约定：

- `Option::None` 序列化为 JSON `null`（与 Electron 版一致；TS 契约里也是 `null`）；
- `kind`：X 的 animated_gif/animatedgif/gif 统一为 `gif`，image/photo 统一为 `photo`；
- `source` 是数据来源，仅用于排障；fxtwitter v2 与 v1 都是 `fxtwitter`；
- `createdAt` / `fetchedAt` 统一 UTC、毫秒精度、以 `Z` 结尾（与 JS `toISOString()` 输出一致）；
- `variants` 保留接口返回的全部变体（含 m3u8），但 `sourceUrl` 只会选择 mp4。

真实请求输出的精简示例（完整文件见 `evidence/real-fetch-fxtwitter-2119254989323588005.json`）：

```json
{
  "id": "2119254989323588005",
  "url": "https://x.com/lapislazulidm/status/2119254989323588005",
  "author": {
    "name": "L.L.",
    "screenName": "lapislazulidm",
    "avatarUrl": "https://pbs.twimg.com/profile_images/2103486782180573184/U7mKFfyx_200x200.jpg",
    "verified": false
  },
  "text": "#初星学園ぬいぬい部 GIF2",
  "createdAt": "2026-11-08T02:25:37.000Z",
  "media": [
    {
      "id": "2119254785778151424",
      "kind": "gif",
      "sourceUrl": "https://video.twimg.com/tweet_video/HWka_9bacAAnUxi.mp4",
      "thumbnailUrl": "https://pbs.twimg.com/tweet_video_thumb/HWka_9bacAAnUxi.jpg",
      "width": 478,
      "height": 450,
      "durationSec": null,
      "variants": [
        { "url": "https://video.twimg.com/tweet_video/HWka_9bacAAnUxi.mp4", "bitrate": 0, "width": null, "height": null }
      ]
    }
  ],
  "source": "fxtwitter",
  "fetchedAt": "2026-11-15T15:30:51.971Z"
}
```

## 5. 公开 API

库根导出（`src/lib.rs`）：

```rust
// 链接解析
pub fn parse_tweet_url(input: &str) -> Option<ParsedTweetUrl>;
pub struct ParsedTweetUrl {
    pub tweet_id: String,
    pub canonical_url: String,   // https://x.com/<user>/status/<id> 或 https://x.com/i/status/<id>
    pub screen_name: Option<String>,
}

// 抓取（阻塞式；同步 API）
pub fn fetch_tweet(input_url: &str, options: &FetchOptions) -> Result<TweetInfo, TweetError>;
pub fn fetch_tweet_with_report(input_url: &str, options: &FetchOptions) -> Result<FetchReport, TweetError>;
pub struct FetchReport {
    pub info: TweetInfo,
    pub endpoint: Endpoint,          // 实际提供媒体数据的接口
    pub attempts: Vec<EndpointAttempt>, // 各接口尝试结果，用于日志/排障
}

// 参数
pub struct FetchOptions {
    pub proxy: ProxySettings,        // 默认 ProxyMode::System
    pub timeout: Duration,           // 默认 15s（单接口）
    pub user_agent: String,          // 默认与 Electron 版相同的 UA
    pub endpoints: Option<Vec<Endpoint>>, // None = 全部按默认顺序
}
pub enum Endpoint { FxTwitterV2, FxTwitterV1, Syndication, VxTwitter }

// 代理
pub enum ProxyMode { System, Custom, Direct }
pub struct ProxySettings { pub mode, pub url, pub bypass, pub username, pub password }
pub fn parse_proxy_url(raw: &str) -> Result<ParsedProxy, String>;
pub fn build_bypass_rules(bypass: &str) -> String;
pub fn build_client(settings: &ProxySettings, timeout: Duration, user_agent: &str) -> Result<Client, TweetError>;

// 缓存
pub fn remember_tweet(info: &TweetInfo);
pub fn get_cached(tweet_id: &str) -> Option<TweetInfo>;
pub fn clear_cache();
pub struct TweetCache { /* new / remember / get / clear / len */ }
pub const MAX_CACHE: usize = 20;

// 错误
pub struct TweetError { pub code: TweetErrorCode, pub message: String, pub network: bool, pub not_found: bool, pub protected: bool }
```

`FetchOptions` 提供链式构造方法 `with_proxy`、`with_timeout`、`with_endpoints`。

`TweetError` 的 `message` 可直接展示（中文，与 Electron 版文案一致），`Display` 即输出 message。
错误码与 Electron 版一致：

| code | 含义 | 分类字段 | 前端处理建议 |
| --- | --- | --- | --- |
| `INVALID_URL` | 链接格式不正确 | — | 提示重新输入 |
| `TWEET_NOT_FOUND` | 推文不存在/已删除 | `not_found=true` | 直接展示 |
| `TWEET_PROTECTED` | 推文受保护或账号不可用 | `protected=true` | 直接展示 |
| `TWEET_RATE_LIMIT` | 请求过于频繁（HTTP 429） | `network=true` | 建议稍后重试 |
| `NO_MEDIA` | 推文没有可转换的媒体 | — | 直接展示 |
| `NETWORK_ERROR` | 网络/接口失败（可重试） | `network=true` | 显示「检查网络后重试」 |
| `TWEET_FETCH_FAILED` | 接口返回异常/无法解析 | `network=true` | 记录日志，提示重试 |
| `PROXY_INVALID` | 代理解析失败 | — | 引导到设置页修正代理 |

错误归类顺序与 Electron 版相同：先看「接口成功但无媒体」→ `NO_MEDIA`；再按「不存在 ≥ 2 次或全部接口都
判定不存在」→ `TWEET_NOT_FOUND`；任一受保护 → `TWEET_PROTECTED`；最后用最后一个接口错误拼
`网络请求失败，请检查网络后重试：...` 作为 `NETWORK_ERROR`。

## 6. 请求回退链与接口细节

### 6.1 四个接口

| 顺序 | `Endpoint` | 请求 URL | 响应取值 | 归一化 |
| --- | --- | --- | --- | --- |
| 1 | `FxTwitterV2` | `https://api.fxtwitter.com/2/status/<id>` | `json.status` 或 `json.tweet` | `normalize_fx_tweet` |
| 2 | `FxTwitterV1` | `https://api.fxtwitter.com/<screen_name|i>/status/<id>` | `json.tweet` | `normalize_fx_tweet` |
| 3 | `Syndication` | `https://cdn.syndication.twimg.com/tweet-result?id=<id>&lang=en&token=<token>` | 顶层对象 | `normalize_syndication` |
| 4 | `VxTwitter` | `https://api.vxtwitter.com/i/status/<id>` | 顶层对象 | `normalize_vx_tweet` |

每次请求头：`user-agent`（Chrome/Windows UA，与 Electron 版一致）、`accept: application/json, text/plain, */*`、
`accept-language: en-US,en;q=0.9,zh-CN;q=0.8`；跟随重定向；单接口超时默认 15s。

回退语义（与 `tweet.cjs` 完全一致）：

- 某接口成功且媒体非空 → 记入缓存并立即返回；
- 某接口成功但媒体为空 → 记下结果，继续尝试其它接口；全部尝试完后仍无媒体 → `NO_MEDIA`；
- 某接口失败（含 404/403）→ 记录错误，继续下一个接口；
- 全部失败 → 按第 5 节优先级汇总错误。

HTTP 状态码映射：

| HTTP | 处理 |
| --- | --- |
| 200–299 | 解析 JSON，进入对应归一化 |
| 404 | `TWEET_NOT_FOUND`（not_found=true） |
| 401 / 403 | `TWEET_PROTECTED`（protected=true） |
| 429 | `TWEET_RATE_LIMIT`（network=true） |
| 其它非 2xx | `TWEET_FETCH_FAILED`（network=true），消息含 HTTP 状态码 |
| JSON 解析失败 | `TWEET_FETCH_FAILED`（network=true） |
| 连接失败 / 超时 | `NETWORK_ERROR`（network=true） |

### 6.2 syndication token 算法

Electron 版：

```js
((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
```

Rust 移植要点：

- 浮点部分与 JS 一致：`tweetId` 字符串按正确舍入转 `f64`，依次 `/ 1e15`、`* PI`；
- 36 进制格式化按 V8 `src/numbers/conversions.cc` 的 `DoubleToRadixStringView` 逐位复刻：整数部分、
  小数部分逐位生成，`delta = 0.5 * (next_double - value)`（有最小 subnormal 下限），
  末位按「就近、偶数」舍入并处理进位，最后以与 JS 正则相同的规则删掉所有 `0` 和小数点；
- 已用 Node.js（V8）实际输出对照 11 组样本（含极小值、大整数、19 位真实 id）全部一致；
  单元测试见 `src/token.rs`。

> 实测：syndication 接口当前对 token 较宽松（传 `token=0` 也能返回 200），但为保持与 Electron 版一致，
> POC 仍完整实现该算法。

## 7. 归一化规则

### 7.1 fxtwitter（v2 / v1 共用 `normalize_fx_tweet`）

- 作者：`name` / `screen_name`（缺失时回退 canonicalUrl 中的用户名）、`avatar_url` 或
  `profile_image_url_https`、`verified`（`author.verified` / `author.verification.verified` /
  `author.is_blue_verified` 任一为真）；
- 媒体来源：`tweet.media.all`，其次 `videos`，再次 `photos`；
- 每个媒体：`type` 映射 kind；变体取 `item.variants` 或 `item.formats`；
- 视频/GIF 的 `sourceUrl`：过滤 `mpegurl`，取 `content_type/container` 含 `mp4` 或 URL 以 `.mp4`
  结尾的变体，按 `bitrate` 降序取最高；无 mp4 时回退 `item.url`，再回退第一个变体 URL；
- 图片的 `sourceUrl`：`pbs.twimg.com` 域名时把查询参数 `name` 改为 `orig`（原图）；
- 宽高：优先 `item.width/height`，其次 `item.original_info`；`duration`（秒）优先，其次
  `duration_millis`；0 或缺失视为 null；
- 文本：`text`，为空时回退 `raw_text.text`；删除 `https://t.co/...` 短链并压缩空白；
- 推文 URL：接口返回的 `url` 若匹配 `x.com/.../status/` 则保留，否则用 canonicalUrl；
- 媒体 id：`item.id` 或 `item.id_str`，缺失时 `media-<序号>`。

### 7.2 syndication（`normalize_syndication`）

- `__typename` 含 `Tombstone` 或缺少 `id_str/id` → 归一化失败（继续回退）；
- 作者：`user.name` / `user.screen_name` / `user.profile_image_url_https`（`_normal` 尺寸替换为
  `_400x400`）/ `user.verified` / `user.is_blue_verified`；
- 媒体：`mediaDetails`；`animated_gif` 的 `sourceUrl` 取 `video_info.variants` 中最优 mp4，
  `media_url_https` 作为缩略图；图片取 `media_url_https`（pbs 原图规则同上）；宽高取
  `original_info`；时长取 `video_info.duration_millis`，其次顶层 `video.durationMs`；
- 媒体 id 派生顺序：URL 中 `/tweet_video|amplify_video|ext_tw_video/<数字>` → 文件名（≥6 位
  `[A-Za-z0-9_-]`，扩展名 jpg/jpeg/png/webp/mp4）→ `media-<序号>`；
- 文本删除 t.co 短链；`created_at` 为 ISO 字符串。

### 7.3 vxtwitter（`normalize_vx_tweet`）

- 身份字段（tweetURL / tweet_id / user_screen_name）全缺失 → 归一化失败；
- 作者：`user_name` / `user_screen_name` / `user_profile_image_url` / `user_verified`；
- 媒体：`media_extended`；图片 pbs 原图规则；视频/GIF 直接取 `url`；宽高取 `size.width/height`；
  时长取 `duration_millis`；`variants` 为空数组；
- 推文 id：`tweet_id`，缺失时从 `tweetURL` 中的 `status/<id>` 提取；
- 发布时间：`date`（ctime 风格）或 `date_epoch`（秒级时间戳）。

### 7.4 时间与文本辅助

- `safe_text`：删除 `https://t.co/...`，空白压缩并 trim（与 JS 正则语义一致）；
- 时间：`created_at` 支持 ISO 8601、RFC 2822、ctime 风格
  （`Sun Nov 08 02:25:37 +0000 2026`，vxtwitter/fxtwitter 实际使用）与秒/毫秒数值时间戳；
  统一输出毫秒精度 UTC ISO 字符串，等价 `new Date(...).toISOString()`。

## 8. 代理支持

### 8.1 三种模式与 reqwest 映射

| `ProxyMode` | Electron 行为 | Rust 行为 |
| --- | --- | --- |
| `system`（默认） | `session.setProxy({ mode: 'system' })`，走系统代理 | 不显式设置 `Proxy`，交给 reqwest 0.13 的 `system-proxy` 特性 |
| `custom` | `fixed_servers` + 代理规则 + bypass | `Proxy::all(url)` + 可选 `basic_auth` + `NoProxy` |
| `direct` | `session.setProxy({ mode: 'direct' })` | `ClientBuilder::no_proxy()` 强制直连 |

`ProxySettings` 字段与 TS 契约一致（`mode/url/bypass/username/password`），默认
`mode=system`、`bypass=localhost;127.0.0.1;<local>`。

### 8.2 代理地址规则（`parse_proxy_url`，移植 proxy.cjs）

- 支持 `http://`、`https://`、`socks5://`；裸 `host:port` 按 `http` 处理；
- 缺省端口：http → 80、https → 443、socks5 → 1080；
- 地址内可内嵌认证：`http://user:pass@host:port`（用户名/密码会 URL 解码）；
  `ProxySettings.username` 非空时优先于地址内凭据；
- 校验：不支持的协议、缺少主机、端口非法（0 或 >65535）都会返回中文错误，对应 `PROXY_INVALID`；
- bypass：分号/逗号/空白分隔，始终追加 `localhost;127.0.0.1;<local>` 并去重；映射到 reqwest 时
  `<local>` 会被剔除，其余写入 `NoProxy`（`*.example.com` 等通配规则由 reqwest 解析）。

### 8.3 认证与限制

- Basic 认证：`Proxy::basic_auth(username, password)`；已验证 dev-proxy 开启认证后带凭据可成功抓取；
- 代理密码在本库中为运行时明文（与 Electron 版 `getProxyAuth` 内存缓存一致）；
  **持久化加密不属于本库**：Tauri 后端需要自行实现与 `safeStorage` 等价的系统凭据加密；
- `system` 模式依赖 reqwest 0.13 平台实现，与 Chromium/WinINET 的行为不保证完全一致；
  主后端建议优先使用设置页的 `custom` 代理（可精确控制）；
- 代理只影响本库的 HTTP 客户端；渲染进程加载远程图片/头像是另一条链路（Tauri 需另行处理）。

## 9. 主 Tauri 后端集成步骤

### 9.1 添加依赖

在 `x-gif-studio-tauri/src-tauri/Cargo.toml` 增加 path 依赖（相对于 `src-tauri/`）：

```toml
[dependencies]
xgif-tweet-fetch-poc = { path = "../poc/tweet-fetch" }
```

说明：

- package 名是 `xgif-tweet-fetch-poc`，Rust 中导入名是 `xgif_tweet_fetch`；
- 会同时引入 reqwest 0.13 等依赖；若后端已有 reqwest 且版本兼容，Cargo 会复用同一份；
- 若不想引入 path 依赖，也可以把 `src/` 中的模块复制进 `src-tauri/src/tweet/`（模块之间无 Tauri 依赖），
  但需要自行维护 reqwest/serde/regex/time 依赖与 Cargo.lock。

### 9.2 注册 Tauri 命令（异步 + spawn_blocking）

本库是**阻塞式同步 API**（reqwest blocking）。Tauri 命令应声明为 `async` 并用
`tauri::async_runtime::spawn_blocking` 执行，避免阻塞 WebView 事件循环：

```rust
use xgif_tweet_fetch::{FetchOptions, ProxySettings, TweetInfo};

#[tauri::command]
pub async fn tweet_fetch(
    url: String,
    proxy: Option<ProxySettings>,
) -> Result<TweetInfo, String> {
    let options = FetchOptions {
        proxy: proxy.unwrap_or_default(),
        ..Default::default()
    };
    tauri::async_runtime::spawn_blocking(move || xgif_tweet_fetch::fetch_tweet(&url, &options))
        .await
        .map_err(|error| format!("推文解析任务异常：{}", error))?
        .map_err(|error| error.message)
}
```

若要保留错误码给前端，可返回自定义结构（前端 `OperationResult.code` 可直接使用）：

```rust
#[derive(serde::Serialize)]
pub struct TweetFetchError {
    pub code: &'static str,
    pub message: String,
}
```

并在 `lib.rs` 的 `invoke_handler` 中注册 `tweet_fetch`；前端 `window.desktop.tweet.fetch` 的
`OperationResult<TweetInfo>` 契约保持不变，由命令包装 `{ ok: true, data }` / `{ ok: false, error, code }`。

### 9.3 代理设置映射

设置页 `AppSettings.proxy`（types.ts）字段与 Rust `ProxySettings` 完全一致，可直接序列化传递；
密码在设置层解密后以明文放入 `ProxySettings.password`。

- `mode: system` → 保持默认（reqwest system-proxy）；
- `mode: custom` → 校验 `url` 应在设置保存时调用 `parse_proxy_url`，非法时前端提示
  `PROXY_INVALID` 文案；
- `mode: direct` → 强制直连。

建议后端在每次抓取时按当前设置构建 `Client`（`build_client` 开销小），或在设置变更时重建缓存
的 `Client`，避免旧代理连接复用。

### 9.4 缓存与转换流水线

- `fetch_tweet` 成功后会调用 `remember_tweet` 写入进程级缓存（20 条）；
- 后续 GIF 转换流水线如果只拿到 `tweetId`，用 `get_cached(tweet_id)` 取回作者/正文/媒体信息
  （对应 Electron 版 `tweet.getCached`）；缓存不足或进程重启时重新抓取；
- 需要清理时调用 `clear_cache()`。

### 9.5 超时、日志与重试

- 单接口超时：`FetchOptions.timeout`（默认 15s）；最坏情况 4 个接口串行 ≈ 60s，
  建议 Tauri 命令层再加整体超时/取消提示（blocking 客户端不支持中途取消，取消能力需要后续改造）；
- 排障日志：`fetch_tweet_with_report` 返回 `attempts`（各接口成功/失败与错误消息）与
  `endpoint`（实际命中接口），可直接写入应用日志；
- 重试：当前不内置重试（与 Electron 版一致）；`network=true` 的错误可由调用方决定是否重试。

### 9.6 集成验证建议

1. 单元测试：`cargo test -p xgif-tweet-fetch-poc`（离线，31 项）；
2. 真实网络：`cargo test -p xgif-tweet-fetch-poc --test real_network -- --ignored`（2 项）；
3. Tauri 联调：设置页选择「自定义代理」→ 输入真实代理 → 解析页粘贴公开推文链接 → 结果页作者/正文/
   媒体 URL 与 Electron 版一致（可用本 POC 的 CLI 输出作为对照基线）。

## 10. 真实请求验证记录（2026-11-15）

**环境**：Windows 11 x64；rustc 1.94.0 / cargo 1.94.0；reqwest 0.13.5；验证机可正常访问
`api.fxtwitter.com` 与 `cdn.syndication.twimg.com`（系统代理/直连均可用）。
**测试链接**：`https://x.com/lapislazulidm/status/2119254989323588005`（公开推文，含 4 个 GIF）。

### 10.1 构建与测试

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `cargo test` | **31 passed / 0 failed**（链接解析、三来源归一化、token 对照 V8、代理、缓存、时间） |
| 真实网络回归 | `cargo test --test real_network -- --ignored` | **2 passed**（默认回退链 + `direct` 模式）；重复执行时曾偶发一次两测试同时超时失败，立即重试即通过（公共接口/网络短暂抖动，见第 11 节第 10 条） |

### 10.2 真实抓取（默认回退链，fxtwitter v2）

```powershell
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --verbose --output evidence/real-fetch-fxtwitter-2119254989323588005.json
```

结果：`source=fxtwitter`；作者 **L.L.（@lapislazulidm）**；正文 **「#初星学園ぬいぬい部 GIF2」**；
`createdAt=2026-11-08T02:25:37.000Z`；4 个 `kind=gif` 媒体，首个真实下载地址
`https://video.twimg.com/tweet_video/HWka_9bacAAnUxi.mp4`（478×450），其余 3 个同样为
`video.twimg.com/tweet_video/*.mp4`。stderr 显示 `[尝试] fxtwitter 成功（已取得媒体）`。
证据：`evidence/real-fetch-fxtwitter-2119254989323588005.json`。

### 10.3 syndication 回退链路

```powershell
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --only syndication --verbose --output evidence/real-fetch-syndication-2119254989323588005.json
```

结果：`source=syndication`；作者/正文/4 个媒体与 fxtwitter 一致；头像被规范为
`.../U7mKFfyx_400x400.jpg`；媒体 id 由文件名派生（如 `HWka_9bacAAnUxi`），mp4 地址与 fxtwitter 相同。
证据：`evidence/real-fetch-syndication-2119254989323588005.json`。

### 10.4 自定义代理与代理认证

使用仓库内已有的本机开发代理（只读运行，不修改 x-gif-studio）：
`x-gif-studio/scripts/dev-proxy.mjs`（默认端口 18990，可选 Basic 认证）。

| 场景 | 命令要点 | 结果 |
| --- | --- | --- |
| 自定义 HTTP 代理 | `--proxy http://127.0.0.1:18990` | 抓取成功，代理日志出现 `[proxy] CONNECT api.fxtwitter.com:443` |
| 需认证的代理 | dev-proxy 以 `--user demo --pass secret` 启动，命令加 `--proxy-user demo --proxy-pass secret` | 认证通过并抓取成功 |
| 缺少认证 | 同上但不带 `--proxy-user/--proxy-pass` | 按预期失败：`NETWORK_ERROR`，退出码 2 |

证据：`evidence/real-fetch-via-dev-proxy-2119254989323588005.json`、
`evidence/real-fetch-via-dev-proxy-auth-2119254989323588005.json`。

### 10.5 vxtwitter 第 4 回退（当前网络不可用）

```powershell
./target/debug/tweet-fetch.exe https://x.com/lapislazulidm/status/2119254989323588005 --only vxtwitter
```

结果：`api.vxtwitter.com` 返回 **HTTP 403（Cloudflare challenge）**，按 Electron 版语义归类为
`TWEET_PROTECTED`。这是第 4 回退，主链路（fxtwitter/syndication）正常时不影响解析；
其归一化逻辑已用合成 fixture 单元测试覆盖，真实成功响应**待验证**（换网络环境后可用 `--only vxtwitter` 复测）。

### 10.6 数据说明

`evidence/` 中均为公开推文数据（公开账号、正文、媒体 URL），用于证明真实请求成功；
不包含任何私人信息、账号凭据或本机个人配置（代理验证使用仓库内 dev-proxy 的示例凭据 `demo/secret`）。

## 11. 与 Electron 版的差异与已知限制

1. **网络栈不同**：Electron 用 Chromium `net.fetch`（自动继承 session 代理、与渲染进程图片同链路）；
   Rust 用 reqwest（独立的连接/代理实现）。TLS、HTTP/2、重定向行为可能有细微差异；
2. **代理模式差异**：`system` 模式由 reqwest 平台实现决定，不保证与 WinINET/Chromium 完全一致；
   验证机上 system/direct/custom 均可工作，但换环境需要复测；
3. **取消能力**：blocking reqwest 不支持中断进行中的请求；Electron 版有 AbortController。
   后续若需要「取消解析」，建议改用 reqwest async + tokio 或拆分请求步骤；
4. **超时语义**：reqwest `Client::timeout` 覆盖整个请求（含读取响应体），与 Electron 版 AbortController
   包裹 fetch+text 的效果接近，但不是逐字节等价；
5. **时间解析**：Rust 端支持 API 实际使用的 ISO 8601 / RFC 2822 / ctime 风格与秒/毫秒时间戳；
   JS `new Date()` 还能接受的其它非标准格式（如某些本地化字符串）未覆盖；
6. **图片原图规则**：Rust 端对 `pbs.twimg.com` 采用查询参数重写（与 Electron 版 URLSearchParams 行为一致），
   但不做完整 URL 规范化/百分号编码，非 pbs 域名原样返回；
7. **vxtwitter**：当前网络 403，真实成功响应未验证（见 10.5）；
8. **缓存**：Rust 端为全局 `Mutex` + `Vec`（最近使用在前），语义等价但实现不同；
9. **MSRV**：reqwest 0.13 要求 Rust 1.85+，与项目文档记录的 1.77.2+ 不一致，集成时需同步更新项目开发说明；
10. **公共接口稳定性**：fxtwitter / syndication / vxtwitter 均为第三方公开接口，可能限流或短暂不可用
    （验证期间出现过一次 fxtwitter 请求整体超时，立即重试成功；也出现过 vxtwitter 403）。
    当前实现不内置重试，建议 Tauri 后端对 `network=true` 的错误做一次用户可见的重试或提示。

## 12. 验证方法

```powershell
# 在 x-gif-studio-tauri/poc/tweet-fetch 目录执行
cargo test                                            # 离线单元测试（31 项）
cargo test --test real_network -- --ignored           # 真实网络测试（2 项，需要外网）
cargo run -- https://x.com/lapislazulidm/status/2119254989323588005 --verbose
cargo run -- <url> --only syndication --verbose       # 单独验证 syndication
cargo run -- <url> --proxy http://127.0.0.1:7890      # 验证自定义代理
cargo run -- <url> --proxy-mode direct                # 验证直连
```

代理链路可用 x-gif-studio 的 `scripts/dev-proxy.mjs` 本地验证（只读运行，不需要修改 x-gif-studio）：

```powershell
# 终端 1：启动本地代理
node x-gif-studio/scripts/dev-proxy.mjs --port 18990
# 终端 2：经代理抓取
cd x-gif-studio-tauri/poc/tweet-fetch
./target/debug/tweet-fetch.exe <url> --proxy http://127.0.0.1:18990 --verbose
```

## 13. 后续工作（TODO，未实现）

- [x] 主后端已提供真实 `tweet_fetch` 命令（`src-tauri/src/tweet.rs`）；本 POC 作为独立实现保留，可按第 9 节整体替换；
- [ ] 移植 `electron/lib/media.cjs`：媒体 mp4/图片下载（同样支持代理、进度、取消、大小/格式校验）；
- [ ] 代理密码的加密存储（Tauri 侧等价 `safeStorage` 方案）；
- [ ] 渲染进程远程图片/头像的代理加载（Tauri WebView 网络代理或自定义协议转发）；
- [ ] 取消/重试策略与整体超时（async reqwest 改造）；
- [ ] vxtwitter 真实成功响应验证（换网络环境）；
- [ ] 与 Electron 版做同链接同代理的字段级对比测试（作者、文本、媒体 URL、时长/宽高）；
- [ ] 更新项目 `README.md` / `docs/开发说明.md` 的 Rust 版本与能力清单。