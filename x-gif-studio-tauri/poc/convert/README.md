# GIF/WebP 转换流水线 Rust 原型（poc/convert）

> **状态：已实测通过的独立 Rust 原型，尚未接入 Tauri 界面/命令层。**
> 本目录是 [x-gif-studio-tauri](../../README.md) 的转换能力验证（POC），**不修改 x-gif-studio**：
> 只读取并调用 `x-gif-studio/tools/bin` 下的 ffmpeg / gifski / gifsicle。

## 用途

把 Electron 版 `x-gif-studio/electron/lib/gif.cjs` 的转换核心移植成可复用的 Rust 实现，验证：

1. **ffmpeg 抽全部帧（passthrough，不重采样、不抽帧）→ gifski 编码 GIF**；
2. **ffmpeg 两遍调色板（palettegen + paletteuse）编码 GIF**；
3. **ffmpeg `libwebp_anim` 编码动画 WebP**；
4. **可选 gifsicle 压缩**（`-O3` / `--lossy` / `--colors`）；
5. 按源 MP4 `stts` 逐帧时长还原 GIF/WebP 逐帧延时，并用 ffmpeg 真实解码验收帧数 / 尺寸 / 时长。

集成设计（可复用函数、参数、进度回调）见
**[docs/PORT-convert.md](../../docs/PORT-convert.md)**。

## 目录

| 路径 | 说明 |
| --- | --- |
| `src/pipeline.rs` | 转换主流程（探测 → 抽帧 → 编码 → 延时还原 → 校验 → 输出） |
| `src/mp4.rs` | 纯 Rust MP4 探测（stts 逐帧时长 / 宽高 / 帧数） |
| `src/gif.rs` | GIF 解析、延时 / 循环修补（GCE、NETSCAPE2.0） |
| `src/webp.rs` | 动画 WebP 解析、ANMF 逐帧时长修补 |
| `src/timeline.rs` | 逐帧时长 → 厘秒延时的纯函数（含单测） |
| `src/params.rs` | 参数默认值与范围（与 Electron defaults.cjs 对齐） |
| `src/progress.rs` | 进度事件与 `ProgressSink` 回调接口 |
| `src/process.rs` | 子进程执行：逐行/逐块回调、超时、取消 |
| `src/tools.rs` | 工具定位与版本查询 |
| `src/ffmpeg.rs` | ffmpeg 文本探测与真解码验收 |
| `src/fsutil.rs` | 临时文件 + 原子替换写入 |
| `src/cli.rs` / `src/main.rs` | 命令行入口、JSON 输出（`src/lib.rs` 同时提供库 target） |

## 环境与构建

- Windows 10/11 x64（实测；其它平台未验证），Rust 1.77+（实测 1.94.0）；
- 工具来自 `x-gif-studio/tools/bin`（**二进制不入库**）：
  ffmpeg 9.0.2、gifski 1.32.0、gifsicle 1.97；
- 零第三方 crate 依赖，`cargo build` 不需要联网。

```powershell
cd x-gif-studio-tauri/poc/convert
cargo test          # 33 个单元测试
cargo build --release
```

## 快速开始

准备一段测试视频（本目录 `testdata/` 已忽略入库，可随时重新生成）：

```powershell
$repo  = '<仓库根目录>'
$ff    = "$repo\x-gif-studio\tools\bin\ffmpeg.exe"
& $ff -v error -y -f lavfi -i 'testsrc2=size=480x270:rate=30:duration=3' -c:v libx264 -preset veryfast -pix_fmt yuv420p testdata\source-3s-30fps.mp4
```

转换（`--tools-dir` 指向 x-gif-studio 工具目录）：

```powershell
$repo  = '<仓库根目录>'
$tools = "$repo\x-gif-studio\tools\bin"
$exe   = '.\target\release\xgif-convert-poc.exe'

# 1) gifski GIF（默认流水线）
& $exe --input testdata\source-3s-30fps.mp4 --output out\gifski.gif --tools-dir $tools --dump-delays

# 2) ffmpeg 两遍调色板 GIF
& $exe --input testdata\source-3s-30fps.mp4 --output out\ffmpeg-palette.gif --encoder ffmpeg --tools-dir $tools

# 3) 动画 WebP
& $exe --input testdata\source-3s-30fps.mp4 --output out\animated.webp --format webp --tools-dir $tools

# 4) gifski + 可选 gifsicle 压缩
& $exe --input testdata\source-3s-30fps.mp4 --output out\gifski-optimized.gif --optimize --tools-dir $tools
```

产物写入 `out/`（gitignore），stdout 输出一行结果 JSON，默认附带 ffmpeg 真解码验收结果。
`--help` 查看全部参数（fps / width / loop / quality / colors / dither / speed 等）。

## 实测结论（2026-11-15，本机）

| 产物 | 路径 | 编码器 | 尺寸 | 帧数 | 时长 | 体积 |
| --- | --- | --- | --- | --- | --- | --- |
| gifski GIF | `out/gifski.gif` | gifski | 480x270 | 90 | 3.000s | 1,248,222 B |
| ffmpeg 两遍 GIF | `out/ffmpeg-palette.gif` | ffmpeg palettegen/paletteuse | 480x270 | 90 | 3.000s | 1,593,932 B |
| 动画 WebP | `out/animated.webp` | ffmpeg libwebp_anim | 480x270 | 90 | 3.000s | 880,686 B |
| gifski + gifsicle | `out/gifski-optimized.gif` | gifski + gifsicle -O3 | 480x270 | 90 | 3.000s | 1,238,268 B（原 1,248,222 B） |
| 参数用例 | `out/fps15-width240-loop3.gif` | gifski | 240x136 | 45 | 3.000s | 249,748 B |

- 每个产物都用 `ffmpeg ... -f null -` 独立解码复验：帧数、尺寸、时长与期望一致；
  详细输出见 [docs/PORT-convert.md「实测验证」](../../docs/PORT-convert.md#8-实测验证2026-11-15)；
- 源视频 90 帧 @30fps，还原出的 GIF 延时为 3/4/3cs 交替、合计 3000ms（30fps 的精确时间轴）；
- `cargo test`：33 passed / 0 failed。

## 约束

- **不要修改 x-gif-studio**：本目录只读取它的 `tools/bin` 工具，不写它的任何文件；
- 本原型不包含下载、历史记录、输出命名、缩略图等媒体层逻辑，见集成文档第 7 节待办；
- `testdata/`、`out/`、`target/` 均不纳入版本管理。
