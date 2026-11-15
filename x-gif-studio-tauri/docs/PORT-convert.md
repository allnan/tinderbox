# PORT-convert：GIF/WebP 转换流水线 Rust 移植说明

> **状态：POC 已实测通过（2026-11-15），尚未接入 Tauri 命令层。**
> 代码位置：`poc/convert/`（独立 crate，零第三方依赖）；本文面向**主 Tauri 后端集成**，
> 给出可复用函数、参数、进度回调设计与实测证据。
> POC 只读取并调用 `x-gif-studio/tools/bin` 下的 ffmpeg / gifski / gifsicle，**未修改 x-gif-studio 的任何文件**。

## 1. 背景与范围

### 1.1 移植来源

| Electron 源文件 | 移植内容 | Rust 模块 |
| --- | --- | --- |
| `electron/lib/gif.cjs` | 转换主流程、抽帧/编码参数、延时还原、gifsicle、校验 | `src/pipeline.rs` |
| `electron/lib/gifprobe.cjs` | GIF 解析、GCE 延时修补、NETSCAPE2.0 循环扩展 | `src/gif.rs` |
| `electron/lib/webp.cjs` | 动画 WebP 解析、ANMF 时长修补 | `src/webp.rs` |
| `electron/lib/mp4probe.cjs` | moov/trak/stts 解析、逐帧时长、宽高、帧数 | `src/mp4.rs` |
| `electron/lib/tools.cjs` | 子进程执行、行级进度回调、取消、超时 | `src/process.rs` |
| `electron/lib/defaults.cjs` | 参数默认值与范围 | `src/params.rs` |
| `docs/GIF转换技术方案.md` | 两遍调色板 / 时序策略背景 | 本文第 3 节 |

### 1.2 POC 已实现

- **MP4 源探测**：纯 Rust 解析 `stts` 逐帧 decode 时长（X 的「GIF」MP4 用它保存原 GIF 的逐帧延时），
  `frameDurationsMs` 是还原播放节奏的唯一可靠来源；解析失败回退 `ffmpeg -i` 文本探测；
- **ffmpeg 抽取全部帧**：`-fps_mode passthrough`，默认不重采样、不抽帧；支持数字 fps（`fps=N`）
  与只缩不放的 `scale=W:-2:flags=lanczos`；
- **GIF 编码 A：gifski**（默认）——`--no-sort` 保序、`--fps` 名义帧率、`--quality`、`--repeat`；
- **GIF 编码 B：ffmpeg 两遍调色板**——`palettegen=stats_mode=diff:max_colors=N` +
  `paletteuse=dither=...:diff_mode=rectangle`；
- **动画 WebP：ffmpeg `libwebp_anim`**——concat demuxer + `-fps_mode passthrough`；
- **逐帧延时还原**：GIF 重写 GCE 延时字节 / 按需插入 GCE / 写入或移除 NETSCAPE2.0；
  WebP 重写 ANMF 24 位时长；写入后读回校验；
- **可选 gifsicle**：`-O3`、`--lossy=N`、`--colors N`；体积未减小或校验失败时回退未优化版本；
- **进度回调**：`ProgressSink` 事件含阶段 / 整体百分比 / 消息 / 帧进度；支持 `Arc<AtomicBool>` 取消
  与子进程超时（抽帧 5 分钟 / 编码 10 分钟 / 压缩 3 分钟）；
- **ffmpeg 真解码验收**：转换后独立解码产物，校验帧数 / 尺寸 / 时长（POC 默认开启）。

### 1.3 未实现（属于媒体层，不在本次范围）

源媒体下载/保存与缓存、历史记录落库、输出文件命名规则（`buildOutputFileName`）、缩略图、
代理、工具下载器、设置读取、任务队列界面。这些由主 Tauri 后端沿用 Electron 版对应模块移植，见第 7 节。

## 2. 模块与源码入口

| 文件 | 职责 |
| --- | --- |
| `poc/convert/src/lib.rs` | 库入口，导出全部模块（便于主后端 path 依赖） |
| `poc/convert/src/pipeline.rs` | 转换主流程、编码器调用、收尾校验 |
| `poc/convert/src/mp4.rs` | 纯 Rust MP4 探测（stts / stsd / tkhd / mvhd） |
| `poc/convert/src/gif.rs` | GIF 解析与延时修补 |
| `poc/convert/src/webp.rs` | WebP 解析与 ANMF 时长修补 |
| `poc/convert/src/timeline.rs` | 逐帧时长 → 厘秒延时、名义帧率、对齐纯函数 |
| `poc/convert/src/params.rs` | 参数默认值与范围 |
| `poc/convert/src/progress.rs` | 进度事件与回调 trait |
| `poc/convert/src/process.rs` | 子进程执行与回调、取消、超时 |
| `poc/convert/src/tools.rs` | 工具定位与版本查询 |
| `poc/convert/src/ffmpeg.rs` | ffmpeg 文本探测 + 真解码验收 |
| `poc/convert/src/fsutil.rs` | 临时文件 + 原子替换 |
| `poc/convert/src/cli.rs`、`src/main.rs` | POC 命令行入口（JSON 结果 / 进度行） |

工具版本（本机实测，从 `x-gif-studio/tools/bin` 直接调用）：

| 工具 | 版本 |
| --- | --- |
| ffmpeg | 9.0.2-essentials_build-www.gyan.dev（含 `libwebp_anim` / `gif` / `libx264`） |
| gifski | 1.32.0 |
| gifsicle | LCDF Gifsicle 1.97 |

## 3. 流水线设计

### 3.1 总览

```text
源 MP4 ──mp4::probe_file──► MediaProbe（宽高 / 帧数 / duration / frameDurationsMs / timescale）
   │
   ├─ timeline::resolve_delays_for_frames ──► delaysCs（逐帧厘秒延时）
   │
   └─ ffmpeg -fps_mode passthrough ──► frames/%06d.png（全部帧，不重采样、不抽帧）
          │
          ├─ gifski --no-sort ─────────────────► encoded.gif ─┐
          ├─ ffmpeg palettegen+paletteuse ──────► encoded.gif ─┤
          └─ ffmpeg libwebp_anim ───────────────► encoded.webp ┤
                                                               ├─ gif::patch_delays / webp::patch_delays
                                                               │    （按 delaysCs 还原逐帧延时）
                                                               ├─（可选）gifsicle -O3
                                                               ├─ 探测最终帧数/延时/循环 → 校验
                                                               ├─ 原子复制到 output
                                                               └─（POC）ffmpeg 真解码验收
```

### 3.2 源视频探测（`mp4.rs`）

返回结构（与 Electron `MediaProbe` 对齐）：

```rust
pub struct MediaProbe {
    pub path: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub duration_sec: f64,
    pub frame_count: usize,
    pub fps: f64,
    pub frame_durations_ms: Vec<f64>, // 来自 stts，逐帧毫秒（保留 3 位小数）
    pub has_audio: bool,
    pub timescale: Option<u32>,
    pub warnings: Vec<String>,
}
```

规则（与 `mp4probe.cjs` 一致）：

- 逐帧时长来自视频轨 `mdhd.timescale` + `stts` 的 sample_delta，`ms = round(delta / timescale * 1000, 3)`；
- **帧数一律以 stts 时长条目数为准**（`frame_count == frame_durations_ms.len()`），
  stts 与 stsz 数量不一致时写入 `warnings`，不再取两者最大值；
- 时长优先 `mdhd.duration / timescale`，其次 `mvhd`，最后逐帧累加；
- 宽高优先 `stsd` 视频 sample entry，其次 `tkhd` 16.16 定点数；
- **回退**：MP4 解析失败时用 `ffmpeg -i` 文本探测宽高/时长/帧率，逐帧时长按平均帧率估算，
  并写入 warning（此时无法精确还原 VFR 节奏）。

### 3.3 抽帧（`pipeline::build_extract_args`）

默认（`--fps source`，不缩放）：

```text
ffmpeg -v error -y -progress pipe:1 -nostats -i <input> -fps_mode passthrough <work>/frames/%06d.png
```

- `-fps_mode passthrough`：显式声明「不重采样、不抽帧」，ffmpeg 9 已移除旧的 `-vsync`；
- 数字 fps（`--fps 15`）：加 `-vf fps=15`（此时允许重采样，属于用户显式选择）；
- 缩放（`--width 240` 且小于源宽）：追加 `scale=240:-2:flags=lanczos`；只缩不放；
- 进度：解析 stdout `frame=N` 行，映射到整体 8%–55%；
- 抽帧后按文件名排序统计实际帧数（PNG 多于/少于源帧数时由延时对齐逻辑兜底）。

### 3.4 逐帧延时计算（`timeline.rs`）

**核心公式**（`compute_delays_cs`，逐行移植 Electron）：

1. 速度倍率作用于每帧时长：`cumulative += duration / speed`；
2. 用「累计时间取整」分配厘秒：`cs = round(cumulative / 10) - assignedCs`；
3. 规范要求最小 2cs（小于 2cs 的延时会被很多查看器按 10cs 处理）：`cs = max(cs, 2)`；
4. 累计分配保证总时长不漂移。

30fps 示例：每帧 33.333ms → 延时序列 `3, 4, 3, 3, 4, 3, ...`（每 3 帧 10cs），90 帧合计 3000ms，
与源 3.000s 精确一致（实测见第 8 节）。

**名义帧率**（`compute_nominal_fps`）：`1000 / averageFrameDurationMs`，夹紧到 1–100（gifski 限制），
保留 3 位小数（30fps → `30.000`）。它只影响编码器初始时长，最终延时会被 patch 覆盖。

**目标帧数对齐**（`resolve_delays_for_frames`）：

| 场景 | 处理 |
| --- | --- |
| `fps=source` 且 `preserveTiming` | 以源 frameDurationsMs 为准；数量不一致时按时间比例合并（目标更少）或按总时长均分（目标更多） |
| 数字 fps / 关闭 preserveTiming | 源总时长按实际帧数均分 |
| 编码后帧数与抽帧数不一致 | 以编码器实际帧数重新执行上述分配，不直接失败（Electron 同策略） |

### 3.5 GIF 编码 A：gifski（默认）

以帧目录为 cwd，参数与 Electron 完全一致：

```text
gifski.exe -o <work>/encoded.gif --fps 30.000 --quality 92 --repeat 0 --no-sort --width 480 000001.png ... 000090.png
```

- `--no-sort`：保持抽帧顺序（GIF 时序已由 patch 还原）；
- `--fps`：名义帧率（`toFixed(3)` 语义）；
- `--repeat`：`loopCount < 0 → -1`，否则原值（最终循环次数由 patch 写入/移除 NETSCAPE）；
- `--width`：始终传目标宽度（帧已按该宽度抽出，不会二次缩放）；
- 进度：gifski 1.32 把 `Frame X/Y` 写到 stdout 且用 `\r` 刷新，POC 同时兼容 stdout/stderr 分块解析，
  映射到整体 55%–90%。

### 3.6 GIF 编码 B：ffmpeg 两遍调色板

第一遍生成调色板：

```text
ffmpeg -v error -y -progress pipe:1 -nostats -framerate 30 -i <work>/frames/%06d.png
  -vf palettegen=stats_mode=diff:max_colors=256 <work>/palette.png
```

第二遍按调色板编码并写循环：

```text
ffmpeg -v error -y -progress pipe:1 -nostats -framerate 30 -i <work>/frames/%06d.png
  -i <work>/palette.png -lavfi paletteuse=dither=sierra2_4a:diff_mode=rectangle -loop 0 <work>/encoded.gif
```

- `-framerate` 取名义帧率的文本形式（整数帧率输出整数，如 `30`；否则保留 3 位小数并去尾 0，如 `23.976`）；
- 颜色数夹紧 16–256；`dither` 仅接受 `sierra2_4a` / `bayer` / `none`；
- 两遍进度分别映射到 55%–70% 与 70%–90%。

### 3.7 动画 WebP 编码（`libwebp_anim`）

先生成 concat 列表（每帧一条 duration，单位秒、6 位小数）：

```text
file '000001.png'
duration 0.030000
file '000002.png'
duration 0.040000
...
```

再编码（cwd 为帧目录）：

```text
ffmpeg -v error -y -progress pipe:1 -nostats -f concat -safe 0 -i webp-concat.txt
  -c:v libwebp_anim -lossless 0 -q:v 92 -loop 0 -fps_mode passthrough <work>/encoded.webp
```

- concat demuxer 会把 duration 量化到图像输入约 40ms 的帧时长网格，且 VFR 模式会丢帧；
  因此与 Electron 一样用 `-fps_mode passthrough` 保留全部帧，编码后再用 `webp::patch_delays`
  把 ANMF 24 位时长改写为精确毫秒；
- `-loop`：`loopCount < 0 → 1`（播放一次），否则夹紧 0–65535（0 = 无限循环）。

### 3.8 逐帧延时还原（patch）

**GIF**（`gif::patch_delays`）：

- 逐帧定位 GCE（`0x21 0xF9`）并重写 delay 2 字节（厘秒，小端）；
- 原文件某帧没有 GCE 时插入一个无透明色、无处置的 GCE；
- `loopCount >= 0` 且无 NETSCAPE2.0 时，在全局调色板后插入
  `21 FF 0B "NETSCAPE2.0" 03 01 <loop lo> <loop hi> 00`；
- `loopCount == -1` 时移除 NETSCAPE2.0 扩展（不循环）；
- 写入后读回校验：帧数、每帧延时、循环次数必须与期望一致，否则报错。

**WebP**（`webp::patch_delays`）：

- 遍历 RIFF chunk，定位每个 ANMF 的 duration 偏移（payload + 12），写 24 位小端毫秒；
- 长度必须与帧数一致；写后读回校验每帧时长。

### 3.9 可选 gifsicle 压缩

```text
gifsicle.exe -O3 [--lossy=N] [--colors N] <work>/delayed.gif -o <work>/optimized.gif
```

- `--lossy` 仅 `>0` 时传；`--colors` 仅 `< 256` 时传；
- 只有体积**严格减小**才接受结果；探测优化后帧数/延时/循环：
  - 帧数变化则按编码器实际帧数重新分配延时；
  - 延时或循环不一致则再次 `patch_delays` 校正；
  - 任何失败都回退未优化版本，不影响主流程；
- 默认关闭：Electron 实测 `--lossy/--colors` 会使高光/毛发偏色，只作为高级选项。

### 3.10 收尾校验与 ffmpeg 验收

- GIF：最终探测帧数必须与延时数组长度一致；存在 <2cs 延时直接报错；总时长与期望相差 >20ms 时告警；
- WebP：帧数必须一致；总时长与期望相差 >50ms 时报错；与源时长相差 >50ms 时告警；
- 源 `fps=source` 但编码器输出帧数与抽帧数不同：按时间比例重分配并记录 warning；
- 最后原子复制到输出路径，可选 `ffmpeg::verify_with_ffmpeg` 真解码验收：
  - 解码帧数与内部探测帧数必须相等；
  - 解码宽高必须相等；
  - 解码时长与内部累计时长相差 >50ms 视为失败（WebP 的 ffmpeg 容器 Duration 为 N/A 时，
    使用 `-progress` 的 `out_time_us` 兜底）。

### 3.11 临时目录与原子写入

- 默认工作目录：`<输出目录>/.convert-work-<pid>/frames/`；CLI 也可用 `--work-dir` 指定；
- 帧目录在结束时删除（`--keep-frames` 保留，便于排查）；
- 输出与 patch 产物均先写同目录临时文件再 rename，避免中断产生半截文件；
- 取消/超时由 `run_process` 每 20ms 轮询 `Arc<AtomicBool>` 与超时时间，命中后 kill 子进程；
  编码器留下的临时文件随后由帧目录清理逻辑删除。

## 4. 可复用 API（主后端直接调用）

库 crate 名：`xgif_convert_poc`（`poc/convert/src/lib.rs` 导出全部模块）。

### 4.1 转换入口

```rust
pub fn convert(
    request: &ConvertRequest,
    sink: &mut dyn ProgressSink,
) -> Result<ConvertResult, ConvertError>;

pub struct ConvertRequest {
    pub input: PathBuf,        // 源视频（X 媒体 MP4）
    pub output: PathBuf,       // 产物路径（扩展名由调用方决定，pipeline 按 format 写内容）
    pub format: AnimFormat,    // Gif | Webp
    pub params: GifParams,     // 参数（内部会 normalized）
    pub tools: ToolPaths,      // ffmpeg / gifski / gifsicle 绝对路径
    pub work_dir: PathBuf,     // 临时目录（帧目录 = work_dir/frames）
    pub keep_frames: bool,
    pub verify_with_ffmpeg: bool,
    pub cancel: Arc<AtomicBool>,
}

pub struct ConvertResult {
    pub output_path: PathBuf,
    pub format: AnimFormat,
    pub encoder: String,          // gifski | ffmpeg | ffmpeg-libwebp_anim
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub frame_count: usize,
    pub duration_sec: f64,
    pub fps: f64,
    pub frame_delays_ms: Vec<u32>,
    pub loop_count: Option<i32>,
    pub source: MediaProbe,
    pub ffmpeg_verify: Option<FfmpegVerify>,
    pub tool_versions: Vec<(String, String)>,
    pub warnings: Vec<String>,
    pub elapsed_ms: u128,
}

pub struct ConvertError {
    pub code: String,          // CONVERT_FAILED | CANCELLED | TOOLS_MISSING | IO_ERROR
    pub stage: String,         // 准备 / 探测 / 抽帧 / 编码 / 收尾 / 验证 …
    pub message: String,       // 可直接展示的中文
    pub stderr_tail: Option<String>,
}
```

### 4.2 探测与延时修补

```rust
// MP4
mp4::probe_file(path: &Path) -> Result<MediaProbe, ProbeError>;
mp4::probe_bytes(bytes: &[u8]) -> Result<MediaProbe, ProbeError>;

// GIF
gif::probe_file(path: &Path) -> Result<GifInfo, GifError>;
gif::patch_delays(
    src: &Path,
    dst: &Path,
    delays_cs: &[u32],
    options: &PatchGifOptions,   // { min_cs: Option<u32>, loop_count: Option<i32> }
) -> Result<GifInfo, GifError>; // 成功后返回读回校验过的探测结果

// WebP
webp::probe_file(path: &Path) -> Result<WebpInfo, WebpError>;
webp::patch_delays(src: &Path, dst: &Path, delays_ms: &[u32])
    -> Result<WebpInfo, WebpError>;
```

`GifInfo` 字段：`width/height/frame_count/frame_delays_cs/frame_delays_ms/duration_sec/fps/loop_count/size_bytes`；
`WebpInfo` 字段：`width/height/frame_count/frame_delays_ms/duration_sec/fps/loop_count/animated/size_bytes`。

### 4.3 时间轴纯函数

```rust
timeline::compute_delays_cs(frame_durations_ms: &[f64], speed: f64, min_cs: u32) -> Vec<u32>;
timeline::average_frame_duration(durations: &[f64], fallback_duration_sec: f64, frame_count: usize) -> f64;
timeline::compute_nominal_fps(average_ms: f64) -> f64;  // 1–100，保留 3 位小数
timeline::align_frame_durations(durations: &[f64], target_frames: usize, duration_sec: f64) -> Vec<f64>;
timeline::resolve_delays_for_frames(
    source_durations_ms: &[f64],
    source_duration_sec: f64,
    target_frames: usize,
    fps: FpsMode,
    preserve_timing: bool,
    speed: f64,
) -> DelayPlan; // { delays_cs: Vec<u32>, durations_ms: Vec<f64>, aligned: bool }
timeline::loop_to_repeat(loop_count: i32) -> i32; // gifski --repeat
timeline::loop_to_webp(loop_count: i32) -> u16;  // -1 → 1，其余夹紧 0–65535
```

这些函数无 I/O、可直接单测（POC 覆盖 30fps 总时长、最小 2cs、倍速、帧数对齐、循环映射等）。

### 4.4 子进程执行

```rust
process::run_process(spec: &RunSpec<'_>, callbacks: &mut dyn ProcessCallbacks) -> std::io::Result<RunResult>;

pub struct RunSpec<'a> {
    pub bin: &'a Path,
    pub args: &'a [String],       // 参数数组，不经过 shell，天然避免注入
    pub cwd: Option<&'a Path>,
    pub timeout: Option<Duration>,
    pub cancel: Option<&'a AtomicBool>,
}

pub trait ProcessCallbacks {
    fn stdout_line(&mut self, _line: &str) {}
    fn stderr_line(&mut self, _line: &str) {}
    fn stdout_chunk(&mut self, _chunk: &str) {}   // gifski 的 `\r` 进度
    fn stderr_chunk(&mut self, _chunk: &str) {}
}
```

回调在调用线程同步执行；内部用两个 reader 线程 + channel 避免管道死锁，Windows 以
`CREATE_NO_WINDOW` 启动（不闪控制台窗口）。错误输出保留尾部 400K 字符用于报错摘要。

### 4.5 工具定位与版本

```rust
tools::resolve_tools(&ToolOverrides {
    tools_dir: Some(&tools_dir),       // CLI --tools-dir
    ffmpeg: None, gifski: None, gifsicle: None, // 显式覆盖
}) -> Result<ToolPaths, ToolError>;

pub struct ToolPaths {
    pub ffmpeg: PathBuf,
    pub gifski: Option<PathBuf>,
    pub gifsicle: Option<PathBuf>,   // 可选
}

tools::collect_versions(&tools) -> Vec<(String, String)>;
```

POC 查找顺序：显式路径 → `--tools-dir` → PATH。主后端应替换/扩展为
「应用可写工具目录 → 打包 resources/tools → PATH」，与 Electron `tools.cjs` 对齐。

### 4.6 ffmpeg 文本探测与验收

```rust
ffmpeg::probe_video(ffmpeg: &Path, input: &Path) -> Option<FfmpegMediaProbe>;
ffmpeg::verify_with_ffmpeg(ffmpeg: &Path, file: &Path) -> Result<FfmpegVerify, String>;

pub struct FfmpegVerify {
    pub width: u32,
    pub height: u32,
    pub frame_count: u64,
    pub duration_sec: f64,
    pub exit_code: Option<i32>,
}
```

## 5. 参数与默认值

### 5.1 参数表

| 参数 | Rust 字段 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| 编码器 | `encoder` | `Gifski` | gifski / ffmpeg | 仅 GIF；WebP 固定 ffmpeg libwebp_anim |
| 宽度 | `width: Option<u32>` | `None`（源宽） | 64–1920 | 只缩不放，实际 `min(源宽, 值)` |
| 帧率 | `fps: FpsMode` | `Source` | source / 4–60 | source = passthrough |
| 颜色数 | `colors` | 256 | 16–256 | 仅 ffmpeg GIF 调色板 |
| 质量 | `quality` | 92 | 1–100 | gifski / WebP |
| 抖动 | `dither` | sierra2_4a | sierra2_4a / bayer / none | 仅 ffmpeg GIF |
| 保时序 | `preserve_timing` | true | bool | 仅 source 模式生效 |
| 极限压缩 | `optimize` | false | bool | 需 gifsicle |
| 有损值 | `lossy` | 0 | 0–200 | gifsicle `--lossy` |
| 速度 | `speed` | 1.0 | 0.25–4.0 | 作用于逐帧时长 |
| 循环 | `loop_count` | 0 | -1–100 | -1 不循环，0 无限 |

这些默认值/范围与 `defaults.cjs` 的 `DEFAULT_PARAMS` / `PARAM_LIMITS` 一致；
`GifParams::normalized()` 会再次夹紧外部输入，前端不需要自行校验。

### 5.2 输出文件名 / 循环语义

- POC 只写 `output` 指定的路径，不生成文件名（Electron 的 `buildOutputFileName` 属媒体层）；
- GIF 循环：`-1` = 移除 NETSCAPE（播放一次）；`0` = 无限循环；`n` = 循环 n 次；
- WebP 循环：`-1 → 1`（播放一次），`0` = 无限，其余夹紧 0–65535；
- 编码器参数里的循环只是初始值，最终以 patch 读回校验后的值为准。

## 6. 进度回调设计（Tauri 集成）

### 6.1 事件与 trait

```rust
pub enum Phase { Queued, Probe, Extract, Encode, Optimize, Finalize, Done, Cancelled, Error }

pub struct ProgressEvent {
    pub phase: Phase,
    pub percent: f64,              // 整条流水线的 0–100
    pub message: String,           // 可直接展示的中文
    pub frame: Option<u64>,        // 当前阶段帧号（1 起）
    pub total_frames: Option<u64>, // 当前阶段总帧数
}

pub trait ProgressSink {
    fn progress(&mut self, event: &ProgressEvent);
}

// 已提供：
impl ProgressSink for () {}                    // 丢弃进度（单测 / 静默）
impl<F: FnMut(&ProgressEvent)> ProgressSink for F {} // 可直接传闭包

// 便捷派发：progress::emit(sink, Phase::Encode, 67.4, "正在编码 GIF…", Some(32), Some(90));
```

流水线在成功结束时派发 `done`；失败派发 `error`；取消派发 `cancelled`（与 Electron
`job.progress("error"/"cancelled")` 行为一致）。

### 6.2 阶段与整体百分比

| 阶段 | 事件 | 百分比 | 触发点 |
| --- | --- | --- | --- |
| queued | 准备 | 0 | 任务开始 |
| probe | 探测 | 4 → 6 | 读源视频前后 |
| extract | 抽帧 | 8 → 55 | 8 起；逐帧 `8 + 帧/期望 * 47`；完成 55 |
| encode | 编码 | 55 → 90 | gifski/WebP 55→90；ffmpeg 调色板 55→70、70→90 |
| optimize | 优化 | 90 → 96 | gifsicle 开始 90、完成 96；跳过 92 |
| finalize | 收尾 | 90/96 → 100 | 延时还原 90、校验 96/97/98、写入 96、完成 100 |
| done | 完成 | 100 | 已保存 |
| cancelled / error | 取消 / 失败 | 0 | 错误返回前 |

### 6.3 取消与超时

- 取消：调用方持有 `Arc<AtomicBool>`，前端点「取消」后 `store(true, Ordering::Relaxed)`；
  `run_process` 每 20ms 检查一次并 kill 当前工具进程，流水线返回 `CANCELLED`；
- 超时（与 Electron 一致）：抽帧 5 分钟、编码 10 分钟、gifsicle 3 分钟；超时 kill 并报错；
- 非子进程阶段（探测 / patch / 复制）会检查取消标志后再继续，粒度是阶段级。

### 6.4 Tauri 命令示例（示意）

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use xgif_convert_poc::pipeline::{self, ConvertRequest, ConvertResult};
use xgif_convert_poc::progress::{ProgressEvent, ProgressSink};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub phase: &'static str,
    pub percent: f64,
    pub message: String,
    pub frame: Option<u64>,
    pub total_frames: Option<u64>,
}

struct ChannelSink(Channel<JobProgressEvent>);

impl ProgressSink for ChannelSink {
    fn progress(&mut self, event: &ProgressEvent) {
        let _ = self.0.send(JobProgressEvent {
            phase: event.phase.as_str(),
            percent: event.percent,
            message: event.message.clone(),
            frame: event.frame,
            total_frames: event.total_frames,
        });
    }
}

#[tauri::command]
pub async fn gif_convert(
    request: ConvertRequestDto,          // 由前端 GifParams / media 信息转换
    channel: Channel<JobProgressEvent>,
    cancels: tauri::State<'_, CancelRegistry>,
) -> Result<ConvertResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    cancels.register(request.job_id.clone(), cancel.clone());

    let request = request.into_pipeline_request(cancel); // DTO → ConvertRequest，工具路径由应用配置提供
    let mut sink = ChannelSink(channel);
    tauri::async_runtime::spawn_blocking(move || pipeline::convert(&request, &mut sink))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message)
}

#[tauri::command]
pub fn gif_cancel(cancels: tauri::State<'_, CancelRegistry>, job_id: String) {
    cancels.cancel(&job_id); // cancel.store(true, Ordering::Relaxed)
}
```

注意：

- 转换是 CPU/磁盘密集的阻塞任务，务必放 `spawn_blocking`，不要阻塞 Tauri 主线程 / async 运行时；
- `Channel` 事件按实际进度频繁发送（gifski 每若干帧、ffmpeg 每帧），前端可自行节流；
- `ConvertRequest` 里的 `ToolPaths` 与参数类型不实现 serde，建议用 DTO 转换，避免把内部类型暴露给前端。

### 6.5 实际事件样例（本机运行 gifski GIF 截取）

```json
{"type":"progress","phase":"probe","percent":6.0,"message":"源视频：480x270，90 帧，3.000 秒"}
{"type":"progress","phase":"extract","percent":55.0,"message":"正在抽取视频帧（90/90）…","frame":90,"totalFrames":90}
{"type":"progress","phase":"encode","percent":67.4,"message":"正在编码 GIF（32/90 帧）…","frame":32,"totalFrames":90}
{"type":"progress","phase":"finalize","percent":100.0,"message":"GIF 转换完成"}
{"type":"progress","phase":"done","percent":100.0,"message":"GIF 已保存：gifski.gif"}
```

## 7. 主 Tauri 后端集成清单

### 7.1 引入方式

推荐把 `poc/convert` 作为独立 crate 引用，而不是复制散落代码：

```toml
# x-gif-studio-tauri/src-tauri/Cargo.toml
[dependencies]
xgif-convert-poc = { path = "../poc/convert" }
```

```rust
use xgif_convert_poc::pipeline::{self, ConvertRequest};
```

如果希望随主工程一起发布，可把 crate 移到 `src-tauri/crates/xgif-convert` 并加入 workspace；
本文档与 POC 的模块边界已按此方式拆分（无 CLI 依赖，`cli.rs` 可裁掉）。

### 7.2 工具定位

- 打包时把 ffmpeg / gifski / gifsicle 放到 Tauri `resources/tools/`，不要把二进制提交进 git；
- 解析顺序建议：应用可写工具目录（升级/按需下载）→ 打包 resources → PATH；
- 启动时用 `tools::collect_versions` 校验版本与能力（例如 `ffmpeg -encoders` 是否含 `libwebp_anim`），
  在设置页展示「工具就绪 / 缺失」；
- POC 的 `--tools-dir` 只是演示入口，主后端应替换 `resolve_tools` 的查找逻辑或直接构造
  `ToolPaths`（不经过 `ToolOverrides`）。

### 7.3 输出路径与命名

POC 不做命名，`ConvertRequest.output` 由调用方给绝对路径。Electron 版命名规则（供移植）：

```text
<screenName>_<tweetId>_<mediaIndex>_<宽>x<高>_<presetId|custom>_<yyyyMMdd-HHmmss>.<gif|webp>
```

- 目录：`<输出目录>/<screenName>/<tweetId>/`；文件名各段需 safeName 过滤；
- 同名时追加 `-2`、`-3` 直到不冲突（Electron `uniquePath`）；
- 生成前先探测产物拿到最终宽高（`ConvertResult.width/height`），再拼文件名；
- POC 的 `ConvertResult` 已包含历史记录需要的
  `width/height/sizeBytes/frameCount/durationSec/fps/frameDelaysMs`，可直接映射到 `GifResult.info`。

### 7.4 工作目录与清理

- 建议每任务独立目录：`app_cache_dir()/convert/<jobId>`，传给 `work_dir`；
- pipeline 只删除 `work_dir/frames/`（`keep_frames=false`）；外层目录由调用方在任务结束后
  `remove_dir_all`；
- 并发任务不共享 work_dir，避免帧文件互相覆盖；
- 磁盘：抽出的 PNG 帧约为「分辨率 × 帧数 × 数十 KB」，长视频/高分辨率时注意缓存清理。

### 7.5 错误处理与任务状态

| code | 含义 | UI 建议 |
| --- | --- | --- |
| `TOOLS_MISSING` | 缺 ffmpeg / gifski | 引导到设置页下载/配置工具 |
| `CANCELLED` | 用户取消 | 任务卡片标记已取消，不弹错误 |
| `CONVERT_FAILED` | 转换 / 校验失败 | 展示 `stage`+`message`，`stderrTail` 写入日志 |
| `IO_ERROR` | 目录/文件读写失败 | 检查磁盘与目录权限 |

建议任务状态机：`queued → running(phase) → done / error / cancelled`，与 Electron `Job` 语义一致。

### 7.6 并发与性能

- 本机实测（480x270、90 帧，含 ffmpeg 验收）端到端：gifski 1.28s、ffmpeg 调色板 1.77s、WebP 1.63s；
  抽帧 PNG I/O 与编码是主要耗时，gifski 单次编码内存占用随分辨率上升；
- 建议限制同时进行的转换任务数（例如 1–2 个），避免多个 gifski/ffmpeg 抢占 CPU/内存；
- POC 未实现帧缓存；Electron 版按 `mediaId + fps + targetWidth + 时间戳` 做帧目录缓存，
  主后端如需重复转换同一媒体可移植该策略；
- ffmpeg 验收会再完整解码一次产物，生产建议 `verify_with_ffmpeg: false`，
  只在设置页提供「转换后校验」选项。

## 8. 实测验证（2026-11-15）

### 8.1 环境与测试源

- Windows 11 x64，Rust 1.94.0，工具为 `x-gif-studio/tools/bin` 下的真实二进制；
- 测试视频由 ffmpeg testsrc 生成（3 秒 / 30fps / 480x270 / H.264）：

```powershell
$repo  = '<仓库根目录>'
$ff    = "$repo\x-gif-studio\tools\bin\ffmpeg.exe"
& $ff -v error -y -f lavfi -i 'testsrc2=size=480x270:rate=30:duration=3' -c:v libx264 -preset veryfast -pix_fmt yuv420p testdata\source-3s-30fps.mp4
```

`ffmpeg -i` 源信息（172,012 字节）：

```text
  Duration: 00:00:03.00, start: 0.000000, bitrate: 458 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 480x270 [SAR 1:1 DAR 16:9], 453 kb/s, 30 fps, 30 tbr, 15360 tbn
```

POC 纯 Rust 探测：`480x270，90 帧，3.000 秒，timescale=15360，逐帧 33.333ms`（MP4 stts 512/15360）。

### 8.2 转换命令

```powershell
cd x-gif-studio-tauri\poc\convert
cargo build --release
$repo  = '<仓库根目录>'
$tools = "$repo\x-gif-studio\tools\bin"
$exe   = '.\target\release\xgif-convert-poc.exe'

& $exe --input testdata\source-3s-30fps.mp4 --output out\gifski.gif --tools-dir $tools --dump-delays
& $exe --input testdata\source-3s-30fps.mp4 --output out\ffmpeg-palette.gif --encoder ffmpeg --tools-dir $tools
& $exe --input testdata\source-3s-30fps.mp4 --output out\animated.webp --format webp --tools-dir $tools
& $exe --input testdata\source-3s-30fps.mp4 --output out\gifski-optimized.gif --optimize --tools-dir $tools
& $exe --input testdata\source-3s-30fps.mp4 --output out\fps15-width240-loop3.gif --fps 15 --width 240 --loop 3 --tools-dir $tools
```

所有命令退出码 0，结果 JSON 中 `ffmpegVerify.exitCode=0`。

### 8.3 产物一览

| 产物 | 编码器 | 尺寸 | 帧数 | 时长 | 循环 | 体积 |
| --- | --- | --- | --- | --- | --- | --- |
| `out/gifski.gif` | gifski | 480x270 | 90 | 3.000s | 0 | 1,248,222 B（1.19 MiB） |
| `out/ffmpeg-palette.gif` | ffmpeg palettegen/paletteuse | 480x270 | 90 | 3.000s | 0 | 1,593,932 B（1.52 MiB） |
| `out/animated.webp` | ffmpeg libwebp_anim | 480x270 | 90 | 3.000s | 0 | 880,686 B（0.84 MiB） |
| `out/gifski-optimized.gif` | gifski + gifsicle -O3 | 480x270 | 90 | 3.000s | 0 | 1,238,268 B（压缩前 1,248,222 B） |
| `out/fps15-width240-loop3.gif` | gifski（15fps/240 宽/循环 3） | 240x136 | 45 | 3.000s | 3 | 249,748 B |

产物位于 `x-gif-studio-tauri/poc/convert/out/`（已被 gitignore，不入库）。

### 8.4 ffmpeg 独立验证输出

验证命令（对每个产物真实解码，而非相信容器元数据）：

```powershell
& $ff -hide_banner -progress pipe:1 -nostats -i <file> -map 0:v:0 -f null -
```

实际输出（`out/ffmpeg-verify.log`，完整保存）：

```text
[FILE] out\gifski.gif  sizeBytes=1248222
  Duration: 00:00:03.00, start: 0.000000, bitrate: 3328 kb/s
  Stream #0:0: Video: gif, bgra, 480x270, 33.33 fps, 30 tbr, 100 tbn
  decodedFrames=90

[FILE] out\ffmpeg-palette.gif  sizeBytes=1593932
  Duration: 00:00:03.00, start: 0.000000, bitrate: 4250 kb/s
  Stream #0:0: Video: gif, bgra, 480x270 [SAR 64:64 DAR 16:9], 33.33 fps, 30 tbr, 100 tbn
  decodedFrames=90

[FILE] out\animated.webp  sizeBytes=880686
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: webp_anim, argb, 480x270, 30 fps, 100 tbr, 1k tbn
  decodedFrames=90

[FILE] out\gifski-optimized.gif  sizeBytes=1238268
  Duration: 00:00:03.00, start: 0.000000, bitrate: 3302 kb/s
  Stream #0:0: Video: gif, bgra, 480x270, 33.33 fps, 30 tbr, 100 tbn
  decodedFrames=90

[FILE] out\fps15-width240-loop3.gif  sizeBytes=249748
  Duration: 00:00:03.00, start: 0.000000, bitrate: 665 kb/s
  Stream #0:0: Video: gif, bgra, 240x136, 16.67 fps, 15 tbr, 100 tbn
  decodedFrames=45
```

说明：

- GIF 的 `Duration: 00:00:03.00` 来自逐帧延时累计，与源 3.000s 一致，证明 patch 后的时序正确；
- WebP 的 `Duration: N/A` 是 ffmpeg `webp_anim` demuxer 不提供容器全局时长的已知表现；
  POC 用 `-progress` 的 `out_time_us`（3.000s）兜底，并从 ANMF 逐帧时长累计得到 3000ms，
  帧数（90）与尺寸（480x270）仍由 ffmpeg 真实解码确认；
- 15fps 用例：45 帧、240x136、时长保持 3.000s，证明 fps/宽度参数与总时长保持逻辑生效。

### 8.5 POC 内部探测 / 验收结果

gifski GIF 结果 JSON 关键字段（完整 JSON 见 `out/gifski.result.json`）：

```json
{
  "frameCount": 90,
  "durationSec": 3.000,
  "fps": 30.000,
  "sizeBytes": 1248222,
  "loopCount": 0,
  "delaySummary": {"count": 90, "totalMs": 3000, "minCs": 3, "maxCs": 4},
  "source": {"width": 480, "height": 270, "frameCount": 90, "durationSec": 3.000, "timescale": 15360},
  "ffmpegVerify": {"width": 480, "height": 270, "frameCount": 90, "durationSec": 3.000, "exitCode": 0}
}
```

逐帧延时序列（`--dump-delays`）为 `3,4,3,3,4,3,...` 交替，合计 3000ms；
15fps 用例为 `7,6,7,...` 交替，合计 3000ms、45 帧。

### 8.6 gifsicle 压缩记录

```text
[ 90.0%] 优化       正在用 gifsicle 压缩体积…
[ 96.0%] 优化       体积优化完成：1.18MB（原 1.19MB）
```

体积从 1,248,222 B 降到 1,238,268 B（约 -0.8%）。这是 testsrc 合成内容的实测值；
真实内容/更激进的 `--lossy` 收益不同，且可能有可见偏色，因此默认关闭（与 Electron 一致）。

### 8.7 单元测试

```text
cd x-gif-studio-tauri\poc\convert
cargo test
# test result: ok. 33 passed; 0 failed
```

覆盖：延时累计/最小 2cs/倍速、帧数对齐、名义帧率、循环映射、GIF patch 回读、WebP patch 回读、
MP4 box 解析、ffmpeg 文本解析、参数归一化、CLI 解析、进程行切分等。

### 8.8 复现步骤

1. 按 8.1 生成测试视频（或准备任意 X 媒体 MP4）；
2. `cargo test && cargo build --release`；
3. 按 8.2 运行四条转换命令，产物在 `out/`；
4. 按 8.4 用 ffmpeg 解码产物，核对 `decodedFrames / Duration / Stream`；
5. 若需保留帧文件排查：加 `--keep-frames`，帧目录位于 `<输出目录>/.convert-work-<pid>/frames/`。

## 9. 已知限制与待办

1. **精确逐帧时长仅 MP4**：非 MP4 源回退 ffmpeg 文本探测，帧时长按平均帧率估算；X 媒体均为 MP4，暂不阻塞；
2. **WebP 容器无全局时长**：ffmpeg 对动画 WebP 报 `Duration: N/A`，验收需用 `out_time_us` 或
   ANMF 累计时长；主后端展示时用 `ConvertResult.durationSec` 即可；
3. **gifsicle 非无损**：`--lossy` / `--colors` 可能偏色，默认关闭；POC 实测只用于体积收益对比；
4. **未移植媒体层**：下载/保存、历史记录、输出命名、缩略图、代理、工具下载、设置读取、任务队列；
5. **无帧缓存**：同一媒体重复转换会重新抽帧；可按 Electron 的 `mediaId+fps+width` 键移植缓存；
6. **平台**：Windows 实测；非 Windows 的 `CREATE_NO_WINDOW`、`.exe` 查找、可执行权限未验证；
7. **数字 fps 会重采样**：这是用户显式选择，与 source passthrough 不同；
8. **取消粒度**：子进程 20ms 内终止；patch / 复制等非子进程阶段在阶段边界检查取消；
9. **ffmpeg 验收**：POC 默认开启，会额外完整解码一次产物，生产建议关闭或做成可选诊断；
10. **文档索引**：本文尚未加入 `x-gif-studio-tauri/README.md` 的文档列表，仓库维护者可在合适时机补充链接。

## 10. 参考文件

- Electron 源实现：`x-gif-studio/electron/lib/gif.cjs`、`gifprobe.cjs`、`webp.cjs`、`mp4probe.cjs`、`defaults.cjs`、`tools.cjs`
- 技术方案背景：`x-gif-studio/docs/GIF转换技术方案.md`（第 2 节流水线、逐帧延时策略）
- POC 代码与使用说明：[poc/convert/README.md](../poc/convert/README.md)
- 项目说明：[README.md](../README.md)、[开发说明](开发说明.md)
