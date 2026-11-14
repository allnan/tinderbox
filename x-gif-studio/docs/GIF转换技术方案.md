# X 媒体工坊 · GIF 转换技术方案（调研与实现依据）

> 结论先行：X 的「GIF」实际是无声循环 MP4；X **不提供**原始 GIF 文件（已实测 `*.gif` 相关 CDN 路径全部 404）。
> 想要「不抽帧、不重复帧、画质接近源、体积可控」，关键不是随便调一个 GIF 工具，而是走
> **「按 MP4 每帧时间戳还原原始 GIF 节奏 + 逐帧局部调色板高质量编码 + 有损 LZW 体积优化」** 的专用流水线。
> 本文件记录调研证据、基准数据与实现要求；`electron/lib/gif.cjs` 必须按此实现。

## 1. 调研结论（证据）

### 1.1 X 的「GIF」只有 MP4

- 推文接口（fxtwitter / syndication）里 `animated_gif` 的 `video_info.variants` 只有 `video/mp4`；
- 实测 `https://video.twimg.com/tweet_video/<id>.gif`、`https://pbs.twimg.com/tweet_video/<id>.gif` 等路径均 404；
  媒体详情中只有 `poster`（jpg 缩略图）和 mp4；
- 因此「X 上自己下载的 GIF」要么是下载器把 mp4 存成了 GIF 后缀，要么是第三方转换产物。
  真正可靠的目标是：**在 GIF 格式约束下做到尽可能接近源 MP4 的观感与播放节奏**。

### 1.2 关键发现：X 转码时保留了原始 GIF 的逐帧时长（VFR）

X 把 GIF 转成 MP4 时，用 MP4 的逐帧时长保存了原始 GIF 的延时（GIF 延时单位是 10ms）。实测三个真实样本：

| 样本 | 分辨率 | 帧数 | 时长 | MP4 逐帧时长分布 |
| --- | --- | --- | --- | --- |
| gif1（210×374） | 210×374 | 91 | 3.03s | 30ms×61 + 40ms×30（名义 30fps） |
| gif2（720×720） | 720×720 | 72 | 2.57s | 40ms×41 + 30ms×31（名义 28.125fps） |
| sample1（194×206） | 194×206 | 21 | 2.10s | 100ms×21（10fps） |

也就是说：**原 GIF 的帧延时是 3cs/4cs 交替的 VFR**，X 原样保存在 MP4 时间戳里。
绝大多数转换工具（在线转换、ffmpeg 默认、gifski 默认 PNG 输入）会把帧重采样到固定帧率
（30fps / 15fps / 12fps），造成**重复帧或丢帧 + 播放节奏改变 + 体积变大**。这正是「一般转出来又大又糊」的根因之一。

### 1.3 编码器基准（真实推文样本，2026-11 实测）

同一源 MP4，不同流水线的 GIF 体积（KB）：

| 方案 | gif1 (mp4 77KB) | gif2 (mp4 257KB) | sample1 (mp4 26KB) | 说明 |
| --- | --- | --- | --- | --- |
| ffmpeg 一步直转 | 2152 | 5497 | 270 | 默认调色板，画质差（色带） |
| ffmpeg 两遍 palettegen/paletteuse（sierra2_4a） | 4537 | 14073 | 496 | 画质好但抖动噪点使 LZW 体积暴涨 |
| gifski 质量 90（全分辨率） | 3167 | 6083 | 377 | 画质最好（逐帧局部调色板 + 时域抖动） |
| gifski 质量 80 | 2547 | 4579 | 323 | 质量略降，体积降 ~25% |
| gifski 90 + `gifsicle -O3 --lossy=80` | 3276 | 6292 | 361 | 单独用 lossy 对 gifski 多调色板输出无效（反而略增） |
| **gifski 90 + `gifsicle -O3 --lossy=80 --colors 128`** | **1878** | **2664** | **264** | **体积降 40~56%**，是体积优化主力 |
| gifski 90 + `--width 480` | 3167* | 2006 | 377* | 宽度缩到 480 后体积明显下降（* 原图已更小） |

结论：

1. **gifski 必须用**：同等观感下，比 ffmpeg 两遍法小 50%+，且无 ffmpeg 抖动噪点；
2. **gifsicle `--lossy + --colors`** 是进一步压体积的关键组合（gifski 局部调色板输出直接丢给 gifsicle lossy 无效，必须配合 `--colors` 做全局量化）；
3. **分辨率与帧率上限**是体积的决定性因素（GIF 体积≈宽×高×帧数×每像素编码成本），App 用预设/滑杆把选择权交给用户；
4. **逐帧延时还原**不改变体积，但保证「不抽帧、不重复帧、节奏一致」，是「专用方法」的核心。

## 2. 专用转换流水线（必须按此实现）

入口：`electron/lib/gif.cjs#convert({ jobId, tweetId, media, params, presetId, onProgress })`

### 2.1 步骤

1. **准备媒体**（`media.cjs`）：下载 mp4 到缓存，`mp4probe.cjs` 解析出：
   宽高、帧数、总时长、**每帧时长毫秒数组 `frameDurationsMs`**、是否有音轨。
2. **计算抽帧参数**：
   - `fps === 'source'`：**不做帧率重采样**，抽取全部帧；宽度 = min(源宽, params.width 若设置)；
   - 数字 fps：`-vf fps=<n>` 重采样，宽度 = min(源宽, params.width)；
   - 缩放统一用 `scale=w:-2:flags=lanczos`（保证偶数高度、锐利）。
3. **抽帧**（ffmpeg）：
   `ffmpeg -v error -y -progress pipe:1 -nostats -i <mp4> [-vf <fps=N,>scale=...:flags=lanczos] [-fps_mode passthrough] <tmp>/frames/%06d.png`
   - `fps === 'source'` 时使用 `-fps_mode passthrough`，保证 VFR 源每帧都保留（不重采样、不补帧、不丢帧）；
   - **注意：ffmpeg 9 已移除旧参数 `-vsync 0`，必须用等价的 `-fps_mode passthrough`**（ffmpeg 7/8 两者都可用；本项目实测 ffmpeg 9.0.2-essentials，用旧参数会直接报错）；
   - 数字 fps 用 `fps=<n>` 滤镜重采样；宽度限制用 `scale=<W>:-2:flags=lanczos`（仅当 `W < 源宽` 时追加，保证不放大）；
   - 抽帧进度读 `-progress pipe:1` 输出的 `frame=N` 行，按 `N / 预期帧数` 映射到整体进度。
4. **GIF 编码**：
   - `params.encoder === 'gifski'`（默认，也是唯一常规路径）：
     `gifski -o <out.gif> --fps <nominal> --quality <Q> --repeat <loop> --no-sort --width <W> <frames>/*.png`
     - `nominal = 1000 / 平均帧时长`（毫秒），例如 2560ms/72 帧 → 35.56ms → **28.125**；它只影响 gifski 的初始时长，最终逐帧延时由第 5 步覆盖；
     - gifski 限制 `--fps` 最大 100，必须夹紧；命令行按 `%.3f` 传（如 `--fps 28.125`），避免高帧率源用超大 nominal 报错；
     - **必须显式传 `--width <W>`**：gifski 默认会把动画限制在约 800×600，不传会在宽/高超过该尺寸的源上发生二次缩放；本项目在 ffmpeg 侧已完成缩放，这里只用来解除默认上限；
     - `--no-sort` 保证严格按抽帧顺序编码（逐帧延时依赖帧顺序）；`--repeat` 对应 `loopCount`（-1 不循环 / 0 无限 / N 次）；
     - gifski 1.3x 的进度写到 **stdout**（用 `\r` 刷新、不换行，形如 `Frame 12 / 72`），必须按原始 chunk 解析并节流上报，不能按行读取；
     - 输入帧用「cwd=帧目录 + 相对文件名」传入，避免长帧数触发 Windows 命令行长度上限。
   - `params.encoder === 'ffmpeg'`（高级备选，界面可切换）：
     `ffmpeg -v error -y -framerate <nominal> -i <frames>/%06d.png -vf "palettegen=stats_mode=diff:max_colors=<C>" <tmp>/palette.png`
     `ffmpeg -v error -y -framerate <nominal> -i <frames>/%06d.png -i <tmp>/palette.png -lavfi "paletteuse=dither=<D>:diff_mode=rectangle" -loop <L> <out.gif>`
     其中 `<D>` 为 sierra2_4a / bayer / none，`<L>` 为 gif muxer 的 `-loop`（-1 不循环 / 0 无限 / N 次）。
     该路径直接基于已抽出的 PNG 序列编码，与 gifski 路径共用缩放/抽帧结果；后续同样在第 5 步做延时校正。
     实测 720p/72 帧 sierra2_4a 体积约 14MB（抖动噪点导致 LZW 体积暴涨），只作为 gifski 缺失或用户显式选择时的兜底。
5. **延时还原**（`gifprobe.patchDelays`）：
   - `fps === 'source' && preserveTiming`：逐帧延时完全按 stts 还原，采用「累计时间取整」而不是逐帧独立取整：
     `delayCs[i] = round(累计时长_ms / 10) - 已分配厘秒`，**最小 2cs**（GIF 规范：<2 会被查看器当成 10）；
   - 数字 fps 或 `preserveTiming=false`：先按「源总时长 / 输出帧数」均匀分配每帧时长，再走同一套累计取整。
     不能固定写 `round(100/fps)`：例如 15fps 固定 7cs 会把 2.57s 变成 2.73s（漂移 160ms），累计分配会自动得到 7/6cs 交替，总时长保持 2.57s；
   - `speed` 直接作用于每帧时长（`duration / speed`），不改变帧数与画面；小于 2cs 的帧受最小约束夹到 20ms（高倍速时属格式限制）；
   - 修补后**读回校验**：帧数、逐帧延时、循环次数必须与期望完全一致，否则抛错（错误信息为中文）；
   - 循环：`loopCount=0` 写 NETSCAPE2.0 无限循环；>0 写循环次数；-1 表示不循环（移除 NETSCAPE 扩展）。
6. **gifsicle 体积优化（高级选项，默认关闭）**（`params.optimize === true` 且 gifsicle 可用）：
   `gifsicle -O3 [--lossy=<lossy>] [--colors <colors>] <in.gif> -o <out.gif>`
   - ⚠️ **不要放进默认预设**：gifski 输出是逐帧局部调色板 + 时域抖动，gifsicle 的全局量化会让白色毛发/高光出现绿色、黄色色斑。
     720×720/72 帧样本：gifski q92 为 6.30MB、PSNR 38.69dB；加 `--lossy=80 --colors=128` 后 2.86MB，但 PSNR 只有 27.28dB、SSIM 0.7884（见第 5 节实测），肉眼可见偏色；
   - 因此该路径只作为「极限压缩（有损，可能偏色）」高级选项由用户手动开启，界面需提示风险；
   - 实现细节：`--colors` 仅在 `colors < 256` 时添加；`--lossy` 仅在 `lossy > 0` 时添加；压缩后重新探测，若延时/循环被改写则重新校正；若文件反而变大则回退未优化版本。
7. **探测与落盘**：`gifprobe.cjs` 读取宽高/帧数/每帧延时/总时长；计算体积；
   文件写入 `settings.getOutputDir()/<screenName>/<tweetId>/<fileName>.gif`；
   调用 `history.recordResult(...)` 写入历史；返回 `GifResult`。

### 2.2 命名与目录

```
<输出目录>/<作者 screen_name>/<推文 id>/<screenName>_<tweetId>_<media序号>_<宽>x<高>_<presetId|custom>_<YYYYMMDD-HHmmss>.gif
```

- 宽高取最终 GIF 的实际尺寸；`presetId` 不是内置预设时写 `custom`；所有片段经 `paths.safeName` 清洗；
- 同名文件存在时追加 `-2`、`-3` 后缀（时间戳已基本避免冲突）；
- 作者 screen_name 取自最近一次推文解析（同一主进程内缓存）；缓存缺失时回退历史记录里的作者，再回退 `x`。

### 2.3 预设（engine 实测后定稿，与 `src/shared/presets.ts` 一致）

| id | 名称 | 关键参数 | 实测体积（样本 A：720×720/72 帧/2.57s） |
| --- | --- | --- | --- |
| source | 最高画质 | gifski q92、原始分辨率、fps=source、preserveTiming=true、optimize=false | 6.30MB（PSNR 38.69dB，最高画质） |
| balanced | 均衡压缩 | gifski q82、原始分辨率、fps=source、optimize=false | 4.66MB（PSNR 36.55dB，约为 source 的 74%） |
| small（历史基准） | 旧轻量预设 | gifski q85、宽度上限 480、fps=source、optimize=false | 2.65MB（PSNR 36.75dB） |
| mini（历史基准） | 旧极小预设 | gifski q80、宽度上限 360、fps=15、optimize=false | 0.88MB（PSNR 35.68dB，15fps 重采样后 39 帧） |

> 注：上表是早期 480/360 宽度预设的历史基准。当前预设已改为按**最长边**限制尺寸：「均衡=保留尺寸+192色」「轻量=最长边≤720+20fps+128色」「极小=最长边≤480+15fps+64色」，横竖图按各自长边等比换算，体积以实际转换结果为准。

> - **所有预设都不启用 gifsicle**：实测启用后 PSNR 会从约 38dB 掉到约 27dB 并出现色斑（见第 5.8 节）；`optimize/lossy/colors` 只作为高级选项。
> - 宽度是**上限**：源比它小时不放大（例如 480 宽的源在 small 预设下仍是 480 宽，体积不会因预设而下降）。
> - 「不抽帧也不降低画质」对应 `source` 预设；「轻量体积」必须牺牲分辨率/帧率，界面要如实显示体积并让用户自己选。
> - 早期基于旧参数的「约 0.5MB」估算已废弃，mini 实测 0.88MB，以本表为准。

### 2.4 进度阶段

- 单独调用 `media.prepare`（解析后预取媒体）：`download 0-40% → probe 40-70% → thumbnail 70-100%`；
- `gif.convert` 内部（缓存未命中时也会顺带下载，整体进度）：
  `download 0-4% → probe 4-6% → thumbnail 6-8% → extract 8-55% → encode 55-90% → optimize 90-96% → finalize 96-100%`；
- 失败时把所处阶段写进中文错误（`code='CONVERT_FAILED'`），取消时 `code='CANCELLED'`；进度事件统一通过 `jobs.Job` 上报，取消时终止子进程。

## 3. 质量验证方案（engine 任务必须给出基线数据）

1. 用真实公开推文样本（不写入仓库，用 URL 常量 + 临时目录）转换 `source`、`balanced`、`small` 三档；
2. 逐帧对比：GIF 帧 vs 源 MP4 同索引帧（缩放对齐）计算 PSNR/SSIM，报告均值；
3. 抽样核对：三档各截取同一帧生成对比图（临时目录，不入库）；
4. 记录到本文件「基准」小节：样本 URL、参数、体积、尺寸、PSNR/SSIM、结论；
5. 断言：`source` 档 GIF 帧数 == 源帧数，总时长误差 ≤ 20ms，帧延时数组与 stts 还原一致。

## 4. 已知限制与风险

- **前端可预览 GIF**：Electron 页面通过 `xgif://display/?path=...` 加载本地 GIF；大 GIF（>20MB）预览可能卡顿，界面应显示原始体积；
- **首次转换耗时**：抽帧 72 张 + gifski 编码约 3-8s（720p、72 帧、本机实测），必须给进度反馈；
- **gifski 的 AGPL 许可**：本项目个人使用、仅做聚合分发；打包目录内保留 LICENSE，文档注明来源；
- **ffmpeg 体积**：便携包内会放 `ffmpeg.exe`（essentials 构建，约 105MB）；`ffprobe` 不打包，MP4 探测由纯 JS 实现；
- **X 接口稳定性**：使用公开的 fxtwitter / syndication 接口，失败时给出可读错误并支持重试；不得要求登录。
- **帧数不一致自动回退（2026-11 修复）**：
  - mp4probe 保证内部不变量 `frameCount === frameDurationsMs.length`：时间轴以 stts 为准，stts 与 stsz 采样数不一致时只在 `warnings` 中记录，不再取两者较大值；
  - gifski 在缩放/去重时可能合并帧（实测 800×556 / 138 帧源，small 档宽 480 时输出 134 帧）。编码后会先探测实际 GIF 帧数，若与延时数量不一致则按源时间比例重新归一延时，并上报进度提示，不再以「帧延时数量与 GIF 帧数不一致」直接失败；
  - 归一兜底覆盖三处：编码完成后、gifsicle 优化后、最终落盘前；只有延时仍无法对齐时才抛出带「请重试或更换预设」提示的错误。

## 5. 基准数据（engine 实测，2026-11）

> 采集方式：本机 Windows 10/11 + Node 22.22 + 本项目 `electron/lib/gif.cjs` 完整流水线；
> 外部工具：`ffmpeg 9.0.2-essentials`、`gifski 1.32.0`、`gifsicle 1.97`。
> 耗时受机器性能影响（换机器只有速度差异），体积与质量结论不变。
> 样本为公开推文，仅用于基准记录，不纳入版本管理。

### 5.1 样本

| 编号 | 推文 | 媒体 | 源 MP4 | 源规格 | stts 逐帧时长 |
| --- | --- | --- | --- | --- | --- |
| A | https://x.com/hardestgifs/status/2116630142135275663 | animated_gif（无音轨） | 257KB | 720×720 / 72 帧 / 2.57s | 40ms×40 + 30ms×32（VFR） |
| B | https://x.com/weird_gifs/status/2103895960703095139 | video（有音轨） | 183KB | 480×486 / 124 帧 / 4.13s | 33.33ms×122 + 33.87ms×2（≈30fps VFR） |

### 5.2 各预设实测（样本 A：720×720 / 72 帧）

| 预设 | gifski 参数 | 体积 | PSNR（均值） | SSIM（均值） | 帧数 | 转换耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| source | q92、原分辨率、fps=source | 6.30MB | 38.69dB | 0.9380 | 72 | 2.46s |
| balanced | q82、原分辨率、fps=source | 4.66MB | 36.55dB | 0.9120 | 72 | 2.24s |
| small | q85、宽≤480、fps=source | 2.65MB | 36.75dB | 0.9107 | 72 | 1.52s |
| mini | q80、宽≤360、15fps | 0.88MB | 35.68dB | 0.8964 | 39 | 0.71s |
| 高级：gifsicle | q92 + `-O3 --lossy=80 --colors 128` | 2.86MB | 27.28dB | 0.7884 | 72 | 8.74s |

（PSNR/SSIM 为逐帧均值；参考帧 = 用与转换完全相同的 ffmpeg 抽帧/缩放命令生成的 PNG；样本 A 72/72 帧、mini 39/39 帧全部对齐比完。）

### 5.3 样本 B（480×486 / 124 帧 / 4.13s，验证视频源与音轨）

| 预设 | 体积 | PSNR（均值） | SSIM（均值） | 帧数 | 转换耗时 |
| --- | --- | --- | --- | --- | --- |
| source | 5.66MB | 36.00dB | 0.9578 | 124 | 2.74s |
| balanced | 3.46MB | 33.87dB | 0.9358 | 124 | 2.14s |
| small（宽度=源宽，不缩放） | 4.14MB | 34.50dB | 0.9431 | 124 | 2.36s |
| mini | 1.32MB | 33.43dB | 0.9381 | 62 | 1.20s |
| 高级：gifsicle | 2.97MB | 27.81dB | 0.8669 | 124 | 11.24s |

### 5.4 时序还原验证（fps='source' + preserveTiming）

| 样本 | 源帧数 | GIF 帧数 | 源时长 | GIF 总延时 | 误差 | 逐帧延时（前 8 帧） |
| --- | --- | --- | --- | --- | --- | --- |
| A | 72 | 72 | 2.57s（stts 合计 2.56s） | 2560ms | 10ms（相对容器时长） | 40/30/40/30/… |
| B | 124 | 124 | 4.134s | 4130ms | 4ms | 30/40/30/30/40/… |

> 结论：GIF 帧数与源完全一致，总时长误差均 ≤10ms（要求 ≤20ms）；逐帧延时与 MP4 stts 一一对应。
> GIF 延时精度只有厘秒，剩余误差来自取整与最小 2cs 约束（样本 B 的 33.33ms 帧会被分配成 3/3/4cs 循环，总量仍对齐）。

### 5.5 实际命令（样本 A，source 预设）

```powershell
# 1) 抽全部帧（VFR，不重采样）——注意 ffmpeg 9 用 -fps_mode passthrough，旧的 -vsync 0 已被移除
tools/bin/ffmpeg.exe -v error -y -progress pipe:1 -nostats -i cache/media/<mediaId>.mp4 -fps_mode passthrough cache/frames/<id>/%06d.png

# 2) gifski 编码（进度写 stdout；--width 用于解除 gifski 默认约 800x600 上限）
tools/bin/gifski.exe -o encoded.gif --fps 28.125 --quality 92 --repeat 0 --no-sort --width 720 000001.png ... 000072.png

# 3) 纯 JS 还原逐帧延时 + 读回校验：gifprobe.patchDelays(encoded.gif, delayed.gif, [40,30,...], { unit:'cs', loopCount:0 })

# 4) 高级可选（默认关闭；实测有损且偏色）：gifsicle -O3 --lossy=80 --colors 128 delayed.gif -o optimized.gif
```

### 5.6 端到端耗时（冷缓存 + 真实网络）

| 阶段 | 耗时 |
| --- | --- |
| tweet.fetch（fxtwitter v2） | 约 0.5s |
| media.prepare（下载 257KB + 纯 JS 探测 + ffmpeg 缩略图） | 1.35s |
| gif.convert（source 预设，720×720/72 帧） | 2.69s |
| gif.info | 3ms |
| 合计 | 约 4.6s |

### 5.7 质量评估方法（可复现）

- 用 Python（Pillow + numpy）读取 GIF：`ImageSequence` 逐帧转 RGB，帧延时从 `frame.info['duration']` 读取；
- 参考帧：用与转换完全相同的 ffmpeg 抽取参数（同样的 fps/scale）生成 PNG 序列，按帧索引与 GIF 对齐（尺寸不一致时用 LANCZOS 缩放到 GIF 尺寸）；
- PSNR：RGB 三通道整体 MSE → `10*log10(255²/MSE)`，逐帧计算后取均值/最小值；
- SSIM：转灰度后在 11×11 高斯窗（σ=1.5）下按标准公式逐帧计算后取均值；
- 三档抽样帧人工核对（临时目录，不入库）。评估脚本只用于基准，不纳入版本管理。

### 5.8 结论

1. **gifski 是唯一常规编码路径**：同尺寸下比 ffmpeg 两遍调色板小 50%+ 且无抖动噪点；ffmpeg 路径只作 gifski 缺失/显式选择时的兜底。
2. **gifsicle 不建议默认启用**：`-O3 --lossy=80 --colors 128` 确实能把 6.30MB 压到 2.86MB（-55%），但 PSNR 从 38.69dB 掉到 27.28dB、SSIM 0.7884，白色毛发/高光出现绿/黄色斑；本项目的 gifski 输出是逐帧局部调色板，全局量化对它伤害最大。故 optimize 默认关闭，仅作「极限压缩（有损，可能偏色）」高级选项。
3. **帧数与时序必须还原**：样本 A/B 的 GIF 帧数 = 源帧数（72/72、124/124），总时长误差 10ms/4ms（≤20ms），这是本工具区别于普通转换器的核心。
4. **体积主要由分辨率 × 帧数决定**：样本 A 从 720→480 宽即从 6.30MB 降到 2.65MB；15fps 重采样后（39 帧）可压到 0.88MB。界面应如实展示体积并让用户自行取舍。
5. **数字 fps 的延时必须按累计时间分配**：固定 `round(100/fps)` 会让 15fps 档从 2.57s 漂移到 2.73s；按累计取整后得到 7/6cs 交替，总时长保持 2.57s。

### 5.9 帧数不一致的自动回退与验证（2026-11）

**背景**：用户反馈转换失败「还原逐帧延时阶段：帧延时数量（86）与 GIF 帧数（84）不一致」。排查确认两条可能路径：

1. mp4probe 曾用 `max(stts 条目数, stsz 采样数)` 作为帧数，正常样本一致，但异常文件可能出现 stts 86 条 / stsz 84 个的错配，下游拿到 86 个延时却只能抽出 84 帧；
2. gifski 在缩放/去重时会合并帧：真实复现为 800×556 / 138 帧源，small 档（宽 480）输出 134 帧，延时数量（138）与 GIF 帧数（134）不一致。

**修复策略**：

- `mp4probe.cjs`：帧数一律以 stts 条目数（`frameDurationsMs.length`）为准，stts 与 stsz 不一致时写入 `warnings`，不再取较大值；
- `gif.cjs`：抽帧延时按「源逐帧时长数组长度」对齐；编码完成后先 `gifprobe.probe` 得到实际 GIF 帧数，若与延时数量不一致则按源时间比例重新归一（fps=source 按源时长合并/均匀分配，数字 fps 按源总时长均匀分配），并在进度中提示；gifsicle 优化后与最终落盘前各再兜底一次；
- `gifprobe.patchDelays`：保持严格校验，错误信息追加「请重试或更换预设」等可操作提示。

**批量验证（3 条真实推文、12 次转换全部成功）**：

| 推文 | 媒体 | 源规格 | source 档 | small 档 |
| --- | --- | --- | --- | --- |
| https://x.com/lapislazulidm/status/2119254989323588005 | 4 个 GIF（478×450 / 2 个 480×480 / 290×290） | 60 / 78 / 136 / 142 帧，2.4–9.5s | 4/4 成功，帧数同源，时长偏差 0ms，1.1–2.8s | 4/4 成功，帧数同源，时长偏差 0ms，1.0–2.8s |
| https://x.com/Sylvielove2022/status/2119991793848877080 | GIF 800×556 | 138 帧 / 5.75s | 138 帧 / 16.95MB / 5.5s，偏差 0ms | **134 帧（触发自动回退）** / 4.78MB / 2.2s，总时长 5770ms（源 5750ms，偏差 20ms） |
| https://x.com/hardestgifs/status/2116630142135275663 | GIF 720×720 | 72 帧 / 2.57s | 72 帧 / 6.30MB / 2.6s，偏差 10ms | 72 帧 / 2.65MB / 1.4s，偏差 10ms |

**复现证据**：Sylvielove 样本 small 档转换时进度输出
`编码器帧数 134 与抽帧 138 不一致，已按时间比例还原时长`，
最终 GIF 为 134 帧、总延时 5770ms（源 5750ms，20ms 在阈值内），转换成功；这说明用户遇到的同类「86 vs 84」不再会导致失败。

> 说明：轻量体积档发生帧合并时无法逐帧一一对应，自动回退按「总时长一致」优先；如需严格逐帧保真，请使用 source 档（不缩放，实测不会触发合并）。


## 附录 A：X 原生格式确认与最新基准（2026-11-12 实测）

### A.1 X 没有「GIF 编码器」，只有 GIF→MP4

- 下载的 X「GIF」文件本身是 H.264 MP4，文件内元数据含 **encoder=Twitter**（不是本地工具转出来的）；
- 仅有的 CDN 变体是 video/mp4；`*.gif` 路径 404（见 §1.1）；
- X 服务端把上传的 GIF 转成 MP4 并保留逐帧延时（见 §1.2）。**"X 自己的 GIF 方案" = 它生成的 MP4，而不是可下载的高质量 GIF**；
- 所以「画质最高、体积最小」的 X 原生形态就是**原始 MP4**：本工具保存时是字节级原样保存，不重新编码。

### A.2 真实样本：同一媒体 MP4 与 GIF 体积对比

| 媒体 | 源 MP4 | 本工具 GIF（原样还原） | 倍数 |
| --- | --- | --- | --- |
| catshealdeprsn 596×576 / 30fps / 3.13s | **221 KB** | 11,899 KB | **~54×** |
| ChibiReviews 996×980 / 23fps / 3.56s | 590 KB | 9,404 KB | ~16× |
| Jacobaaaaa154 640×360 / 12fps / 6.75s | 326 KB | 7,546 KB | ~23× |

GIF 格式本身（256 色索引 + LZW）就是体积放大器；**不存在能压到 MP4 量级的高质量真 GIF**。

### A.3 同一源 MP4 的 GIF 编码器基准（596×576 / 94 帧 / 30fps）

| 方案 | 体积 | SSIM（对比源 MP4 解码帧） | 结论 |
| --- | --- | --- | --- |
| **gifski q92（本工具默认）** | **11,899 KB** | **0.9651** | 体积最小、质量最好的一档 |
| gifski q100 | 17,733 KB | 0.9861 | 质量略升，体积 +49% |
| ffmpeg palettegen 全片单调色板 | 21,334 KB | 0.9752 | 更大且更差 |
| ffmpeg palettegen 逐帧调色板 | 22,745 KB | 0.9761 | 更大，收益很小 |
| gifski + gifsicle --lossy=80（不加 --colors） | 13,367 KB | 0.9614 | 对 gifski 局部调色板无效，体积反增 |

结论与 §1.3 一致：**gifski + 逐帧时序还原** 是当前最优；要更小只能降分辨率/颜色/帧率，或开「极限压缩」（gifsicle 有损，可能偏色，体积可再降 40%+）。

## 附录 B：GIF 压缩方案对比与动画 WebP 结论（2026-11-12 实测）

测试样本：X 源 MP4 596×576 / 30fps / 3.13s / 94 帧（MP4 221 KB），对比目标为「保留全部帧、不降分辨率」。

### B.1 真 GIF 的各种压缩路线

| 方案 | 体积 | SSIM（对源 MP4 解码帧） | 说明 |
| --- | --- | --- | --- |
| **gifski q92（本工具默认）** | **11,899 KB** | **0.9651** | 体积/画质综合最优的一档 |
| gifski q92 + gifsicle -O3 | 13,809 KB | 0.9651 | 帧差/透明优化对 gifski 输出**无收益**（反而变大） |
| ffmpeg 全局调色板 + diff_mode=rectangle + gifsicle -O3 | 21,131 KB | 0.9752 | 画质更高，但体积接近翻倍 |
| ffmpeg stats_mode=diff 调色板 + gifsicle -O3 | 20,727 KB | 0.9726 | 同上，体积大 |
| gifski + gifsicle -O3 --lossy=80 --colors 128 | 8,244 KB | 0.8938 | 唯一能明显缩体积的真 GIF 方案，但颜色/细节损失可见 |

结论：**帧差优化（gifsicle -O1..O3）不是「小体积高画质 GIF」的魔法**——它只优化帧存储结构，gifski 本身已做过类似处理；要让真 GIF 明显变小，只能降颜色/有损（质量下降明显）或降分辨率/帧率。全局调色板 + 区域差分可以提升画质，但体积更大。

### B.2 动画 WebP（本次新增导出格式）

同一批帧直接编码为动画 WebP（libwebp_anim，24-bit、保留全部帧与时序）：

| 方案 | 体积 | SSIM | 相对 GIF |
| --- | --- | --- | --- |
| 动画 WebP q80（本工具实现） | **3,016 KB** | **0.9677**（PSNR 38.47dB） | 体积约为 GIF 的 **1/3.9**，画质更高 |
| 动画 WebP q90（本工具实现） | 4,818 KB | 0.9855（PSNR 42.29dB） | 体积约为 GIF 的 1/2.5，画质明显更高 |
| （对照）GIF gifski q92 | 11,899 KB | 0.9363（PSNR 36.20dB） | — |

注：WebP 与 GIF 的逐帧延时数组完全一致（94 帧 / 3.13s）；表格为真实样本经本工具引擎转换后的实测值（Pillow/ffmpeg 对齐口径）；应用内另一样本（478×450 / 60 帧 / 2.4s）实测 GIF 1.82MB vs WebP 765KB。

结论：**同时追求高画质与小体积时，动画 WebP 是正确格式**（GIF 的 1/4–1/5 体积、更高画质、保留全部帧与逐帧时序）；真 GIF 只在兼容性必须时使用。X 平台本身不提供 GIF 编码器，其「GIF」仍是 MP4（见附录 A），所以「X 同款小体积高画质」本质是 MP4/WebP，而不是真 GIF。
