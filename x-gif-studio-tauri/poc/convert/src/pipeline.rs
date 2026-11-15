//! GIF / WebP 转换流水线（移植 Electron 版 `electron/lib/gif.cjs` 的 convert 主流程）。
//!
//! 默认流水线（与 Electron 一致）：
//!   ffmpeg 抽全部帧（-fps_mode passthrough，不重采样、不抽帧）
//!   → gifski 编码（--no-sort 保序、--fps 名义帧率、--repeat 循环）
//!   → patch_delays 按源 MP4 stts 逐帧时长还原 GIF 延时（厘秒、最小 2cs）
//!   → 可选 gifsicle 极限压缩（默认关闭）
//!   → 探测 / 校验 → 写入输出目录；
//! 另提供 ffmpeg 两遍调色板 GIF 与 ffmpeg libwebp_anim 动画 WebP。
//!
//! 进度阶段（整体百分比，与 Electron 版一致）：
//!   queued 0 → probe 4-6 → extract 8-55 → encode 55-90 → optimize 90-96 → finalize 96-100

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ffmpeg::{self, FfmpegVerify};
use crate::fsutil;
use crate::gif::{self, PatchGifOptions};
use crate::mp4::{self, MediaProbe};
use crate::params::{AnimFormat, Encoder, FpsMode, GifParams, MIN_DELAY_CS};
use crate::process::{run_process, ProcessCallbacks, RunResult, RunSpec};
use crate::progress::{self, Phase, ProgressSink};
use crate::timeline;
use crate::tools::{self, ToolPaths};
use crate::webp;

const EXTRACT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const ENCODE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const OPTIMIZE_TIMEOUT: Duration = Duration::from_secs(3 * 60);

/// 一次转换请求。
#[derive(Clone)]
pub struct ConvertRequest {
    pub input: PathBuf,
    pub output: PathBuf,
    pub format: AnimFormat,
    pub params: GifParams,
    pub tools: ToolPaths,
    /// 帧文件与中间产物目录；调用方负责创建 / 清理外层目录。
    pub work_dir: PathBuf,
    /// 为 true 时保留抽出的 PNG 帧与中间产物，便于排查。
    pub keep_frames: bool,
    /// 为 true 时在转换结束后用 ffmpeg 真实解码产物，校验帧数 / 尺寸 / 时长。
    pub verify_with_ffmpeg: bool,
    /// 取消令牌：置为 true 后 20ms 内终止当前子进程。
    pub cancel: Arc<AtomicBool>,
}

/// 转换结果（供 Tauri 命令 / 历史记录落库）。
#[derive(Debug, Clone)]
pub struct ConvertResult {
    pub output_path: PathBuf,
    pub format: AnimFormat,
    pub encoder: String,
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

/// 流水线错误。
#[derive(Debug, Clone)]
pub struct ConvertError {
    pub code: String,
    pub stage: String,
    pub message: String,
    pub stderr_tail: Option<String>,
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}（{}阶段）", self.message, self.stage)
    }
}

impl std::error::Error for ConvertError {}

fn convert_error(stage: &str, message: impl Into<String>) -> ConvertError {
    ConvertError {
        code: "CONVERT_FAILED".to_string(),
        stage: stage.to_string(),
        message: message.into(),
        stderr_tail: None,
    }
}

fn stage_error(stage: &str, message: impl Into<String>, tail: Option<String>) -> ConvertError {
    ConvertError {
        code: "CONVERT_FAILED".to_string(),
        stage: stage.to_string(),
        message: message.into(),
        stderr_tail: tail,
    }
}

fn cancelled_error() -> ConvertError {
    ConvertError {
        code: "CANCELLED".to_string(),
        stage: "取消".to_string(),
        message: "任务已取消".to_string(),
        stderr_tail: None,
    }
}

fn tools_missing(message: impl Into<String>) -> ConvertError {
    ConvertError {
        code: "TOOLS_MISSING".to_string(),
        stage: "准备".to_string(),
        message: message.into(),
        stderr_tail: None,
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), ConvertError> {
    if cancel.load(Ordering::Relaxed) {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

/// 执行一次转换。`sink` 接收带整体百分比的进度事件。
///
/// 与 Electron 版一致：失败时先派发 `error` 阶段事件，取消时派发 `cancelled` 阶段事件，
/// 然后返回错误；成功时以 `done` 事件结尾。
pub fn convert(
    request: &ConvertRequest,
    sink: &mut dyn ProgressSink,
) -> Result<ConvertResult, ConvertError> {
    let outcome = convert_inner(request, sink);
    if let Err(error) = &outcome {
        if error.code == "CANCELLED" {
            progress::emit(sink, Phase::Cancelled, 0.0, "任务已取消", None, None);
        } else {
            progress::emit(sink, Phase::Error, 0.0, &error.message, None, None);
        }
    }
    outcome
}

fn convert_inner(
    request: &ConvertRequest,
    sink: &mut dyn ProgressSink,
) -> Result<ConvertResult, ConvertError> {
    let started = Instant::now();
    let params = request.params.clone().normalized();
    let mut warnings: Vec<String> = Vec::new();

    progress::emit(sink, Phase::Queued, 0.0, "正在准备转换任务…", None, None);
    if !request.input.is_file() {
        return Err(convert_error(
            "准备",
            format!("源视频不存在或不是文件：{}", request.input.display()),
        ));
    }
    if request.format == AnimFormat::Gif
        && params.encoder == Encoder::Gifski
        && request.tools.gifski.is_none()
    {
        return Err(tools_missing(
            "缺少外部工具 gifski。请用 --tools-dir 指向 x-gif-studio/tools/bin，或把 gifski.exe 放到 PATH 中",
        ));
    }
    let tool_versions = tools::collect_versions(&request.tools);

    // 1. 探测源视频（纯 Rust MP4 解析，失败时回退 ffmpeg 文本探测）。
    progress::emit(sink, Phase::Probe, 4.0, "正在读取源视频信息…", None, None);
    let source = probe_source(&request.input, &request.tools.ffmpeg)?;
    warnings.extend(source.warnings.iter().cloned());
    progress::emit(
        sink,
        Phase::Probe,
        6.0,
        format!(
            "源视频：{}x{}，{} 帧，{:.3} 秒",
            source.width, source.height, source.frame_count, source.duration_sec
        ),
        None,
        None,
    );
    if source.frame_count == 0 {
        return Err(convert_error("准备媒体", "源媒体没有可用的视频帧"));
    }

    // 2. 计算抽帧参数。
    let source_width = source.width.max(1);
    let target_width = match params.width {
        Some(width) => width.min(source_width).max(16),
        None => source_width,
    };
    let fps_mode = params.fps;
    let average_ms = timeline::average_frame_duration(
        &source.frame_durations_ms,
        source.duration_sec,
        source.frame_count,
    );
    let nominal_fps = timeline::compute_nominal_fps(average_ms);
    let expected_frames = match fps_mode {
        FpsMode::Source => source.frame_count,
        FpsMode::Numeric(fps) => ((source.duration_sec * f64::from(fps)).round() as usize).max(1),
    };

    // 3. 抽帧（passthrough：不重采样、不抽帧）。work_dir 统一转绝对路径：
    //    后续 gifski / ffmpeg 会以帧目录为 cwd，产物路径必须是绝对路径。
    let work_dir = std::path::absolute(&request.work_dir).unwrap_or_else(|_| request.work_dir.clone());
    let frames_dir = work_dir.join("frames");
    let mut cleanup = CleanupGuard::new(request.keep_frames);
    std::fs::create_dir_all(&work_dir)
        .map_err(|error| convert_error("抽帧", format!("创建临时目录失败：{}", error)))?;
    if frames_dir.exists() {
        let _ = std::fs::remove_dir_all(&frames_dir);
    }
    std::fs::create_dir_all(&frames_dir)
        .map_err(|error| convert_error("抽帧", format!("创建帧缓存目录失败：{}", error)))?;
    cleanup.watch_dir(frames_dir.clone());

    progress::emit(sink, Phase::Extract, 8.0, "开始抽取视频帧…", None, None);
    let frame_names = extract_frames(
        &request.input,
        &frames_dir,
        fps_mode,
        target_width,
        source_width,
        expected_frames,
        &request.tools.ffmpeg,
        request.cancel.as_ref(),
        sink,
    )?;
    check_cancel(request.cancel.as_ref())?;
    let actual_frames = frame_names.len();

    // 4. 计算逐帧延时：passthrough 时以源逐帧时长为准，否则按总时长均分。
    let preserve_timing = params.preserve_timing && matches!(fps_mode, FpsMode::Source);
    let delay_plan = timeline::resolve_delays_for_frames(
        &source.frame_durations_ms,
        source.duration_sec,
        actual_frames,
        fps_mode,
        preserve_timing,
        params.speed,
    );
    let mut target_delays_cs = delay_plan.delays_cs.clone();
    progress::emit(
        sink,
        Phase::Extract,
        55.0,
        format!(
            "抽帧完成：共 {} 帧{}",
            actual_frames,
            if preserve_timing && delay_plan.aligned {
                "（源帧数不一致，已按时间比例对齐）"
            } else {
                ""
            }
        ),
        Some(actual_frames as u64),
        Some(actual_frames as u64),
    );
    check_cancel(request.cancel.as_ref())?;

    // 5. 编码。
    let encoded_path = frames_dir.join(match request.format {
        AnimFormat::Gif => "encoded.gif",
        AnimFormat::Webp => "encoded.webp",
    });
    let encoder_label = match (request.format, params.encoder) {
        (AnimFormat::Webp, _) => "ffmpeg-libwebp_anim".to_string(),
        (AnimFormat::Gif, encoder) => encoder.as_str().to_string(),
    };
    progress::emit(
        sink,
        Phase::Encode,
        55.0,
        if request.format == AnimFormat::Webp {
            "正在编码 WebP…"
        } else {
            "正在编码 GIF…"
        },
        None,
        None,
    );
    let encoded_ok = match (request.format, params.encoder) {
        (AnimFormat::Webp, _) => encode_with_webp(
            &frames_dir,
            &frame_names,
            &encoded_path,
            &target_delays_cs,
            &params,
            &request.tools.ffmpeg,
            request.cancel.as_ref(),
            sink,
        )?,
        (AnimFormat::Gif, Encoder::Gifski) => {
            let gifski = request.tools.gifski.as_ref().ok_or_else(|| {
                tools_missing("缺少外部工具 gifski，无法用 gifski 编码 GIF")
            })?;
            encode_with_gifski(
                &frames_dir,
                &frame_names,
                &encoded_path,
                nominal_fps,
                target_width,
                &params,
                gifski,
                request.cancel.as_ref(),
                sink,
            )?
        }
        (AnimFormat::Gif, Encoder::Ffmpeg) => encode_with_ffmpeg(
            &frames_dir,
            &frame_names,
            &encoded_path,
            nominal_fps,
            &params,
            &request.tools.ffmpeg,
            request.cancel.as_ref(),
            sink,
        )?,
    };
    if !encoded_ok {
        return Err(convert_error("编码", "编码器没有生成输出文件"));
    }
    progress::emit(
        sink,
        Phase::Encode,
        90.0,
        if request.format == AnimFormat::Webp {
            "WebP 编码完成"
        } else {
            "GIF 编码完成"
        },
        None,
        None,
    );
    check_cancel(request.cancel.as_ref())?;

    // 6. 编码后处理：还原逐帧延时 / 可选 gifsicle / 收尾校验。
    let mut final_path = encoded_path.clone();
    let final_info = match request.format {
        AnimFormat::Gif => finalize_gif(
            &frames_dir,
            &encoded_path,
            actual_frames,
            &source,
            fps_mode,
            preserve_timing,
            &params,
            request.cancel.as_ref(),
            &mut target_delays_cs,
            &mut warnings,
            &request.tools,
            sink,
            &mut final_path,
        )?,
        AnimFormat::Webp => finalize_webp(
            &frames_dir,
            &encoded_path,
            actual_frames,
            &source,
            fps_mode,
            preserve_timing,
            &params,
            request.cancel.as_ref(),
            &mut target_delays_cs,
            &mut warnings,
            sink,
            &mut final_path,
        )?,
    };
    check_cancel(request.cancel.as_ref())?;

    // 7. 写入输出文件（同目录临时文件 + 原子替换）。
    progress::emit(sink, Phase::Finalize, 96.0, "正在写入输出文件…", None, None);
    fsutil::copy_atomically(&final_path, &request.output).map_err(|error| {
        convert_error(
            "收尾",
            format!("写入输出文件失败（{}）：{}", request.output.display(), error),
        )
    })?;
    let size_bytes = std::fs::metadata(&request.output)
        .map_err(|error| convert_error("收尾", format!("读取输出文件失败：{}", error)))?
        .len();

    // 8. 用 ffmpeg 真实解码产物做最终验证（POC 验收要求；生产可按需关闭）。
    let ffmpeg_verify = if request.verify_with_ffmpeg {
        progress::emit(sink, Phase::Finalize, 97.0, "正在用 ffmpeg 验证输出…", None, None);
        let verify = ffmpeg::verify_with_ffmpeg(&request.tools.ffmpeg, &request.output)
            .map_err(|error| stage_error("验证", format!("ffmpeg 验证失败：{}", error), None))?;
        let frame_ok = verify.frame_count as usize == final_info.frame_count;
        let size_ok = verify.width == final_info.width && verify.height == final_info.height;
        if !frame_ok || !size_ok {
            return Err(stage_error(
                "验证",
                format!(
                    "ffmpeg 验证不一致：解码得到 {} 帧 {}x{}，期望 {} 帧 {}x{}",
                    verify.frame_count,
                    verify.width,
                    verify.height,
                    final_info.frame_count,
                    final_info.width,
                    final_info.height
                ),
                None,
            ));
        }
        let duration_delta_ms = ((verify.duration_sec - final_info.duration_sec) * 1000.0).abs();
        if duration_delta_ms > 50.0 {
            return Err(stage_error(
                "验证",
                format!(
                    "ffmpeg 验证时长不一致：解码 {:.3}s，期望 {:.3}s（相差 {:.1}ms）",
                    verify.duration_sec, final_info.duration_sec, duration_delta_ms
                ),
                None,
            ));
        }
        if duration_delta_ms > 1.0 {
            warnings.push(format!(
                "ffmpeg 解码时长与逐帧延时累计相差 {:.1}ms（在 50ms 容差内）",
                duration_delta_ms
            ));
        }
        Some(verify)
    } else {
        None
    };

    progress::emit(
        sink,
        Phase::Finalize,
        100.0,
        format!("{} 转换完成", request.format.label()),
        None,
        None,
    );
    progress::emit(
        sink,
        Phase::Done,
        100.0,
        format!(
            "{} 已保存：{}",
            request.format.label(),
            request
                .output
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        ),
        None,
        None,
    );

    Ok(ConvertResult {
        output_path: request.output.clone(),
        format: request.format,
        encoder: encoder_label,
        width: final_info.width,
        height: final_info.height,
        size_bytes,
        frame_count: final_info.frame_count,
        duration_sec: final_info.duration_sec,
        fps: final_info.fps,
        frame_delays_ms: final_info.frame_delays_ms,
        loop_count: final_info.loop_count,
        source,
        ffmpeg_verify,
        tool_versions,
        warnings,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// 收尾后的最终产物信息。
#[derive(Debug, Clone, Default)]
struct FinalInfo {
    width: u32,
    height: u32,
    frame_count: usize,
    duration_sec: f64,
    fps: f64,
    frame_delays_ms: Vec<u32>,
    loop_count: Option<i32>,
}

impl FinalInfo {
    fn from_gif(info: &gif::GifInfo) -> FinalInfo {
        FinalInfo {
            width: info.width,
            height: info.height,
            frame_count: info.frame_count,
            duration_sec: info.duration_sec,
            fps: info.fps,
            frame_delays_ms: info.frame_delays_ms.clone(),
            loop_count: Some(info.loop_count),
        }
    }

    fn from_webp(info: &webp::WebpInfo) -> FinalInfo {
        FinalInfo {
            width: info.width,
            height: info.height,
            frame_count: info.frame_count,
            duration_sec: info.duration_sec,
            fps: info.fps,
            frame_delays_ms: info.frame_delays_ms.clone(),
            loop_count: info.loop_count.map(i32::from),
        }
    }
}

fn probe_source(input: &Path, ffmpeg_bin: &Path) -> Result<MediaProbe, ConvertError> {
    match mp4::probe_file(input) {
        Ok(probe) => Ok(probe),
        Err(mp4_error) => {
            if let Some(fallback) = ffmpeg::probe_video(ffmpeg_bin, input) {
                let frame_count = fallback.frame_count.max(1);
                let uniform_ms = if fallback.duration_sec > 0.0 {
                    round3(fallback.duration_sec * 1000.0 / frame_count as f64)
                } else {
                    0.0
                };
                let size_bytes = std::fs::metadata(input).map(|meta| meta.len()).unwrap_or(0);
                let fps = if fallback.fps > 0.0 {
                    fallback.fps
                } else if fallback.duration_sec > 0.0 {
                    frame_count as f64 / fallback.duration_sec
                } else {
                    0.0
                };
                Ok(MediaProbe {
                    path: input.to_string_lossy().into_owned(),
                    size_bytes,
                    width: fallback.width,
                    height: fallback.height,
                    duration_sec: round3(fallback.duration_sec),
                    frame_count,
                    fps: round3(fps),
                    frame_durations_ms: vec![uniform_ms; frame_count],
                    has_audio: fallback.has_audio,
                    timescale: None,
                    warnings: vec![format!(
                        "MP4 结构解析失败（{}），已回退 ffmpeg 文本探测并按平均帧率估算逐帧时长",
                        mp4_error.message
                    )],
                })
            } else {
                Err(convert_error(
                    "准备媒体",
                    format!("无法解析媒体文件：{}", mp4_error.message),
                ))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 抽帧
// ---------------------------------------------------------------------------

fn build_extract_args(
    input: &Path,
    frames_dir: &Path,
    fps: FpsMode,
    target_width: u32,
    source_width: u32,
) -> Vec<String> {
    let mut args: Vec<String> = ["-v", "error", "-y", "-progress", "pipe:1", "-nostats", "-i"]
        .iter()
        .map(|value| value.to_string())
        .collect();
    args.push(input.to_string_lossy().into_owned());
    let mut filters: Vec<String> = Vec::new();
    if let FpsMode::Numeric(value) = fps {
        filters.push(format!("fps={}", value));
    }
    if target_width > 0 && target_width < source_width {
        filters.push(format!("scale={}:-2:flags=lanczos", target_width));
    }
    if !filters.is_empty() {
        args.push("-vf".to_string());
        args.push(filters.join(","));
    }
    if matches!(fps, FpsMode::Source) {
        // 不缩放、不重采样：显式声明 passthrough（ffmpeg 9 已移除旧的 -vsync 参数）。
        args.push("-fps_mode".to_string());
        args.push("passthrough".to_string());
    }
    args.push(frames_dir.join("%06d.png").to_string_lossy().into_owned());
    args
}

fn extract_frames(
    input: &Path,
    frames_dir: &Path,
    fps: FpsMode,
    target_width: u32,
    source_width: u32,
    expected_frames: usize,
    ffmpeg_bin: &Path,
    cancel: &AtomicBool,
    sink: &mut dyn ProgressSink,
) -> Result<Vec<String>, ConvertError> {
    let args = build_extract_args(input, frames_dir, fps, target_width, source_width);
    let mut callbacks = ExtractCallbacks {
        sink,
        expected: expected_frames,
        last_frame: 0,
    };
    let result = run_process(
        &RunSpec {
            bin: ffmpeg_bin,
            args: &args,
            cwd: None,
            timeout: Some(EXTRACT_TIMEOUT),
            cancel: Some(cancel),
        },
        &mut callbacks,
    )
    .map_err(|error| convert_error("抽帧", format!("ffmpeg 执行失败：{}", error)))?;
    check_process(result, "抽帧", "ffmpeg")?;
    let mut frame_names: Vec<String> = std::fs::read_dir(frames_dir)
        .map_err(|error| convert_error("抽帧", format!("读取帧缓存目录失败：{}", error)))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let is_png = path
                .extension()
                .map(|ext| ext.eq_ignore_ascii_case("png"))
                .unwrap_or(false);
            if is_png {
                entry.file_name().to_str().map(|name| name.to_string())
            } else {
                None
            }
        })
        .collect();
    frame_names.sort();
    if frame_names.is_empty() {
        return Err(convert_error(
            "抽帧",
            "没有抽取到任何视频帧（源文件可能没有视频轨）",
        ));
    }
    Ok(frame_names)
}

struct ExtractCallbacks<'a> {
    sink: &'a mut dyn ProgressSink,
    expected: usize,
    last_frame: u64,
}

impl ProcessCallbacks for ExtractCallbacks<'_> {
    fn stdout_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("frame=") else {
            return;
        };
        let Ok(frame) = rest.trim().parse::<u64>() else {
            return;
        };
        if frame == self.last_frame {
            return;
        }
        self.last_frame = frame;
        let total = self.expected.max(1) as f64;
        let ratio = (frame as f64 / total).clamp(0.0, 1.0);
        let message = if self.expected > 0 {
            format!("正在抽取视频帧（{}/{}）…", frame, self.expected)
        } else {
            format!("正在抽取视频帧（{}）…", frame)
        };
        progress::emit(
            &mut *self.sink,
            Phase::Extract,
            8.0 + ratio * 47.0,
            message,
            Some(frame),
            (self.expected > 0).then_some(self.expected as u64),
        );
    }
}

// ---------------------------------------------------------------------------
// gifski 编码
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn encode_with_gifski(
    frames_dir: &Path,
    frame_names: &[String],
    output_path: &Path,
    nominal_fps: f64,
    width: u32,
    params: &GifParams,
    gifski: &Path,
    cancel: &AtomicBool,
    sink: &mut dyn ProgressSink,
) -> Result<bool, ConvertError> {
    let mut args: Vec<String> = vec![
        "-o".to_string(),
        output_path.to_string_lossy().into_owned(),
        "--fps".to_string(),
        format!("{:.3}", nominal_fps),
        "--quality".to_string(),
        params.quality.to_string(),
        "--repeat".to_string(),
        timeline::loop_to_repeat(params.loop_count).to_string(),
        "--no-sort".to_string(),
    ];
    if width > 0 {
        args.push("--width".to_string());
        args.push(width.to_string());
    }
    args.extend(frame_names.iter().cloned());
    let mut callbacks = GifskiCallbacks {
        sink,
        total: frame_names.len(),
        last_percent: -1.0,
    };
    let result = run_process(
        &RunSpec {
            bin: gifski,
            args: &args,
            cwd: Some(frames_dir),
            timeout: Some(ENCODE_TIMEOUT),
            cancel: Some(cancel),
        },
        &mut callbacks,
    )
    .map_err(|error| convert_error("编码", format!("gifski 执行失败：{}", error)))?;
    check_process(result, "编码", "gifski")?;
    Ok(file_nonempty(output_path))
}

struct GifskiCallbacks<'a> {
    sink: &'a mut dyn ProgressSink,
    total: usize,
    last_percent: f64,
}

impl GifskiCallbacks<'_> {
    fn handle(&mut self, chunk: &str) {
        // gifski 1.32 把进度写到 stdout，并用 \r 刷新而不是换行；这里兼容 stdout / stderr。
        for (frame, total) in scan_frame_progress(chunk) {
            let ratio = if total > 0 {
                (frame as f64 / total as f64).clamp(0.0, 1.0)
            } else if self.total > 0 {
                (frame as f64 / self.total as f64).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let percent = 55.0 + ratio * 35.0;
            if (percent - self.last_percent).abs() < f64::EPSILON {
                continue;
            }
            self.last_percent = percent;
            let message = if total > 0 {
                format!("正在编码 GIF（{}/{} 帧）…", frame, total)
            } else {
                "正在编码 GIF…".to_string()
            };
            progress::emit(
                &mut *self.sink,
                Phase::Encode,
                percent,
                message,
                Some(frame),
                (total > 0).then_some(total),
            );
        }
    }
}

impl ProcessCallbacks for GifskiCallbacks<'_> {
    fn stdout_chunk(&mut self, chunk: &str) {
        self.handle(chunk);
    }

    fn stderr_chunk(&mut self, chunk: &str) {
        self.handle(chunk);
    }
}

/// 扫描文本里的 `Frame X/Y` 进度（可能被 \r 分隔）。
fn scan_frame_progress(text: &str) -> Vec<(u64, u64)> {
    let bytes = text.as_bytes();
    let mut results = Vec::new();
    let mut index = 0_usize;
    while index + 5 <= bytes.len() {
        if &bytes[index..index + 5] == b"Frame" {
            let mut cursor = index + 5;
            while cursor < bytes.len() && (bytes[cursor] == b' ' || bytes[cursor] == b'\t') {
                cursor += 1;
            }
            let frame_start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            if cursor > frame_start {
                if let Ok(frame) = text[frame_start..cursor].parse::<u64>() {
                    let mut separator = cursor;
                    while separator < bytes.len()
                        && (bytes[separator] == b' ' || bytes[separator] == b'\t')
                    {
                        separator += 1;
                    }
                    if separator < bytes.len() && bytes[separator] == b'/' {
                        let mut total_cursor = separator + 1;
                        while total_cursor < bytes.len()
                            && (bytes[total_cursor] == b' ' || bytes[total_cursor] == b'\t')
                        {
                            total_cursor += 1;
                        }
                        let total_start = total_cursor;
                        while total_cursor < bytes.len() && bytes[total_cursor].is_ascii_digit() {
                            total_cursor += 1;
                        }
                        if total_cursor > total_start {
                            if let Ok(total) = text[total_start..total_cursor].parse::<u64>() {
                                results.push((frame, total));
                            }
                        }
                    }
                }
            }
            index = cursor.max(index + 5);
        } else {
            index += 1;
        }
    }
    results
}

// ---------------------------------------------------------------------------
// ffmpeg 两遍调色板 GIF 编码
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn encode_with_ffmpeg(
    frames_dir: &Path,
    frame_names: &[String],
    output_path: &Path,
    nominal_fps: f64,
    params: &GifParams,
    ffmpeg_bin: &Path,
    cancel: &AtomicBool,
    sink: &mut dyn ProgressSink,
) -> Result<bool, ConvertError> {
    let frame_rate = frame_rate_string(nominal_fps);
    let input_pattern = frames_dir.join("%06d.png").to_string_lossy().into_owned();
    let palette_path = frames_dir.join("palette.png");
    let colors = params.colors.clamp(2, 256);
    let palette_args: Vec<String> = vec![
        "-v".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        "-framerate".to_string(),
        frame_rate.clone(),
        "-i".to_string(),
        input_pattern.clone(),
        "-vf".to_string(),
        format!("palettegen=stats_mode=diff:max_colors={}", colors),
        palette_path.to_string_lossy().into_owned(),
    ];
    let mut callbacks = PaletteCallbacks {
        sink,
        total: frame_names.len(),
        last_frame: 0,
    };
    let result = run_process(
        &RunSpec {
            bin: ffmpeg_bin,
            args: &palette_args,
            cwd: None,
            timeout: Some(ENCODE_TIMEOUT),
            cancel: Some(cancel),
        },
        &mut callbacks,
    )
    .map_err(|error| convert_error("编码", format!("调色板生成失败：{}", error)))?;
    check_process(result, "编码", "ffmpeg（palettegen）")?;
    if !palette_path.is_file() {
        return Err(convert_error("编码", "调色板生成失败：没有生成 palette.png"));
    }

    let loop_count = timeline::loop_to_repeat(params.loop_count);
    let dither = params.dither.as_str();
    let encode_args: Vec<String> = vec![
        "-v".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        "-framerate".to_string(),
        frame_rate,
        "-i".to_string(),
        input_pattern,
        "-i".to_string(),
        palette_path.to_string_lossy().into_owned(),
        "-lavfi".to_string(),
        format!("paletteuse=dither={}:diff_mode=rectangle", dither),
        "-loop".to_string(),
        loop_count.to_string(),
        output_path.to_string_lossy().into_owned(),
    ];
    let mut callbacks = EncodeGifCallbacks {
        sink,
        total: frame_names.len(),
        last_frame: 0,
    };
    let result = run_process(
        &RunSpec {
            bin: ffmpeg_bin,
            args: &encode_args,
            cwd: None,
            timeout: Some(ENCODE_TIMEOUT),
            cancel: Some(cancel),
        },
        &mut callbacks,
    )
    .map_err(|error| convert_error("编码", format!("ffmpeg 编码失败：{}", error)))?;
    check_process(result, "编码", "ffmpeg（paletteuse）")?;
    Ok(file_nonempty(output_path))
}

struct PaletteCallbacks<'a> {
    sink: &'a mut dyn ProgressSink,
    total: usize,
    last_frame: u64,
}

impl ProcessCallbacks for PaletteCallbacks<'_> {
    fn stdout_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("frame=") else {
            return;
        };
        let Ok(frame) = rest.trim().parse::<u64>() else {
            return;
        };
        if frame == self.last_frame {
            return;
        }
        self.last_frame = frame;
        let ratio = (frame as f64 / self.total.max(1) as f64).clamp(0.0, 1.0);
        progress::emit(
            &mut *self.sink,
            Phase::Encode,
            55.0 + ratio * 15.0,
            "正在生成调色板…",
            Some(frame),
            Some(self.total.max(1) as u64),
        );
    }
}

struct EncodeGifCallbacks<'a> {
    sink: &'a mut dyn ProgressSink,
    total: usize,
    last_frame: u64,
}

impl ProcessCallbacks for EncodeGifCallbacks<'_> {
    fn stdout_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("frame=") else {
            return;
        };
        let Ok(frame) = rest.trim().parse::<u64>() else {
            return;
        };
        if frame == self.last_frame {
            return;
        }
        self.last_frame = frame;
        let total = self.total.max(1);
        let ratio = (frame as f64 / total as f64).clamp(0.0, 1.0);
        progress::emit(
            &mut *self.sink,
            Phase::Encode,
            70.0 + ratio * 20.0,
            format!("正在用 ffmpeg 编码 GIF（{}/{} 帧）…", frame, total),
            Some(frame),
            Some(total as u64),
        );
    }
}

// ---------------------------------------------------------------------------
// ffmpeg libwebp_anim 动画 WebP 编码
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn encode_with_webp(
    frames_dir: &Path,
    frame_names: &[String],
    output_path: &Path,
    delays_cs: &[u32],
    params: &GifParams,
    ffmpeg_bin: &Path,
    cancel: &AtomicBool,
    sink: &mut dyn ProgressSink,
) -> Result<bool, ConvertError> {
    let list_path = frames_dir.join("webp-concat.txt");
    let mut content = String::new();
    for (index, name) in frame_names.iter().enumerate() {
        content.push_str(&format!("file '{}'\n", name));
        let delay_ms = delays_cs.get(index).copied().unwrap_or(0) * 10;
        content.push_str(&format!("duration {:.6}\n", delay_ms as f64 / 1000.0));
    }
    std::fs::write(&list_path, content)
        .map_err(|error| convert_error("编码", format!("写入 WebP concat 列表失败：{}", error)))?;

    let args: Vec<String> = vec![
        "-v".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        "-nostats".to_string(),
        "-f".to_string(),
        "concat".to_string(),
        "-safe".to_string(),
        "0".to_string(),
        "-i".to_string(),
        list_path.to_string_lossy().into_owned(),
        "-c:v".to_string(),
        "libwebp_anim".to_string(),
        "-lossless".to_string(),
        "0".to_string(),
        "-q:v".to_string(),
        params.quality.to_string(),
        "-loop".to_string(),
        timeline::loop_to_webp(params.loop_count).to_string(),
        "-fps_mode".to_string(),
        "passthrough".to_string(),
        output_path.to_string_lossy().into_owned(),
    ];
    let mut callbacks = EncodeWebpCallbacks {
        sink,
        total: frame_names.len(),
        last_frame: 0,
    };
    let result = run_process(
        &RunSpec {
            bin: ffmpeg_bin,
            args: &args,
            cwd: Some(frames_dir),
            timeout: Some(ENCODE_TIMEOUT),
            cancel: Some(cancel),
        },
        &mut callbacks,
    )
    .map_err(|error| convert_error("编码", format!("ffmpeg 编码 WebP 失败：{}", error)))?;
    check_process(result, "编码", "ffmpeg（libwebp_anim）")?;
    Ok(file_nonempty(output_path))
}

struct EncodeWebpCallbacks<'a> {
    sink: &'a mut dyn ProgressSink,
    total: usize,
    last_frame: u64,
}

impl ProcessCallbacks for EncodeWebpCallbacks<'_> {
    fn stdout_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("frame=") else {
            return;
        };
        let Ok(frame) = rest.trim().parse::<u64>() else {
            return;
        };
        if frame == self.last_frame {
            return;
        }
        self.last_frame = frame;
        let total = self.total.max(1);
        let ratio = (frame as f64 / total as f64).clamp(0.0, 1.0);
        progress::emit(
            &mut *self.sink,
            Phase::Encode,
            55.0 + ratio * 35.0,
            format!("正在编码 WebP（{}/{} 帧）…", frame, total),
            Some(frame),
            Some(total as u64),
        );
    }
}

// ---------------------------------------------------------------------------
// 收尾：GIF
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn finalize_gif(
    frames_dir: &Path,
    encoded_path: &Path,
    actual_frames: usize,
    source: &MediaProbe,
    fps_mode: FpsMode,
    preserve_timing: bool,
    params: &GifParams,
    cancel: &AtomicBool,
    target_delays_cs: &mut Vec<u32>,
    warnings: &mut Vec<String>,
    tools: &ToolPaths,
    sink: &mut dyn ProgressSink,
    final_path: &mut PathBuf,
) -> Result<FinalInfo, ConvertError> {
    let encoded_info = gif::probe_file(encoded_path)
        .map_err(|error| convert_error("编码", format!("无法读取编码后的 GIF：{}", error)))?;
    if encoded_info.frame_count == 0 {
        return Err(convert_error("编码", "编码器没有生成任何 GIF 帧"));
    }
    if encoded_info.frame_count != target_delays_cs.len() {
        *target_delays_cs = recompute_delays_cs(
            source,
            encoded_info.frame_count,
            fps_mode,
            preserve_timing,
            params.speed,
        );
        let message = format!(
            "编码器帧数 {} 与抽帧 {} 不一致，已按时间比例还原时长",
            encoded_info.frame_count, actual_frames
        );
        progress::emit(sink, Phase::Encode, 90.0, message.clone(), None, None);
        progress::emit(sink, Phase::Finalize, 90.0, message.clone(), None, None);
        warnings.push(message);
    }

    progress::emit(sink, Phase::Finalize, 90.0, "正在还原逐帧延时…", None, None);
    let delayed_path = frames_dir.join("delayed.gif");
    let patch_options = PatchGifOptions {
        min_cs: Some(MIN_DELAY_CS),
        loop_count: Some(params.loop_count),
    };
    let mut accepted_path = delayed_path.clone();
    gif::patch_delays(encoded_path, &delayed_path, target_delays_cs, &patch_options)
        .map_err(|error| convert_error("还原逐帧延时", format!("写入 GIF 逐帧延时失败：{}", error)))?;

    if params.optimize {
        progress::emit(sink, Phase::Optimize, 90.0, "正在用 gifsicle 压缩体积…", None, None);
        if let Some(gifsicle) = tools.gifsicle.as_ref() {
            let optimized_path = frames_dir.join("optimized.gif");
            match optimize_with_gifsicle(
                gifsicle,
                &delayed_path,
                &optimized_path,
                target_delays_cs,
                params,
                source,
                fps_mode,
                preserve_timing,
                cancel,
                sink,
            ) {
                Ok(Some((path, _info, delays))) => {
                    accepted_path = path;
                    *target_delays_cs = delays;
                }
                Ok(None) => {}
                Err(error) if error.code == "CANCELLED" => return Err(error),
                Err(_) => {
                    progress::emit(
                        sink,
                        Phase::Optimize,
                        92.0,
                        "gifsicle 不可用，跳过体积优化",
                        None,
                        None,
                    );
                }
            }
        } else {
            warnings.push("gifsicle 不可用，已跳过体积优化".to_string());
            progress::emit(
                sink,
                Phase::Optimize,
                92.0,
                "gifsicle 不可用，跳过体积优化",
                None,
                None,
            );
        }
    } else {
        progress::emit(sink, Phase::Optimize, 92.0, "已跳过有损体积优化", None, None);
    }
    check_cancel(cancel)?;

    progress::emit(sink, Phase::Finalize, 96.0, "正在校验输出文件…", None, None);
    let mut info = gif::probe_file(&accepted_path)
        .map_err(|error| convert_error("收尾", format!("无法读取最终 GIF：{}", error)))?;
    if info.frame_count != target_delays_cs.len() {
        *target_delays_cs =
            recompute_delays_cs(source, info.frame_count, fps_mode, preserve_timing, params.speed);
        let repaired_path = frames_dir.join("final-delays.gif");
        let repaired_info = gif::patch_delays(&accepted_path, &repaired_path, target_delays_cs, &patch_options)
            .map_err(|error| convert_error("收尾", format!("重新写入 GIF 逐帧延时失败：{}", error)))?;
        accepted_path = repaired_path;
        info = repaired_info;
        progress::emit(
            sink,
            Phase::Finalize,
            97.0,
            format!("最终帧数 {} 已重新分配逐帧延时", info.frame_count),
            None,
            None,
        );
    }
    if info.frame_count != target_delays_cs.len() {
        return Err(convert_error(
            "收尾",
            format!(
                "输出 GIF 帧数（{}）与逐帧延时数量（{}）仍不一致；请重试或更换参数",
                info.frame_count,
                target_delays_cs.len()
            ),
        ));
    }
    if matches!(fps_mode, FpsMode::Source) && info.frame_count != actual_frames {
        let message = format!(
            "编码器输出 {} 帧，与抽帧 {} 帧不同（已按时间比例还原时长）",
            info.frame_count, actual_frames
        );
        progress::emit(sink, Phase::Finalize, 97.0, message.clone(), None, None);
        warnings.push(message);
    }
    if info.frame_delays_ms.iter().any(|ms| *ms < MIN_DELAY_CS * 10) {
        return Err(convert_error("收尾", "输出 GIF 存在小于 2cs 的帧延时"));
    }
    let expected_duration_ms: i64 = target_delays_cs.iter().map(|cs| i64::from(*cs) * 10).sum();
    let actual_duration_ms: i64 = info.frame_delays_ms.iter().map(|ms| i64::from(*ms)).sum();
    let duration_delta_ms = (actual_duration_ms - expected_duration_ms).abs();
    if duration_delta_ms > 20 && preserve_timing {
        let message = format!("提示：输出时长与期望相差 {}ms", duration_delta_ms);
        progress::emit(sink, Phase::Finalize, 98.0, message.clone(), None, None);
        warnings.push(message);
    }
    *final_path = accepted_path;
    Ok(FinalInfo::from_gif(&info))
}

/// 可选 gifsicle 压缩；失败 / 结果不合格时返回 Ok(None) 由调用方回退未优化版本。
#[allow(clippy::too_many_arguments)]
fn optimize_with_gifsicle(
    gifsicle: &Path,
    input_path: &Path,
    output_path: &Path,
    current_delays_cs: &[u32],
    params: &GifParams,
    source: &MediaProbe,
    fps_mode: FpsMode,
    preserve_timing: bool,
    cancel: &AtomicBool,
    sink: &mut dyn ProgressSink,
) -> Result<Option<(PathBuf, gif::GifInfo, Vec<u32>)>, ConvertError> {
    let mut args: Vec<String> = vec!["-O3".to_string()];
    let lossy = params.lossy.min(200);
    if lossy > 0 {
        args.push(format!("--lossy={}", lossy));
    }
    if params.colors < 256 {
        args.push("--colors".to_string());
        args.push(params.colors.max(2).to_string());
    }
    args.push(input_path.to_string_lossy().into_owned());
    args.push("-o".to_string());
    args.push(output_path.to_string_lossy().into_owned());
    let result = match run_process(
        &RunSpec {
            bin: gifsicle,
            args: &args,
            cwd: None,
            timeout: Some(OPTIMIZE_TIMEOUT),
            cancel: Some(cancel),
        },
        &mut (),
    ) {
        Ok(result) => result,
        Err(_) => return Ok(None),
    };
    if result.cancelled {
        return Err(cancelled_error());
    }
    if !result.success() || !file_nonempty(output_path) {
        return Ok(None);
    }
    let before = std::fs::metadata(input_path).map(|meta| meta.len()).unwrap_or(0);
    let after = std::fs::metadata(output_path).map(|meta| meta.len()).unwrap_or(0);
    if after >= before {
        progress::emit(
            sink,
            Phase::Optimize,
            96.0,
            "压缩后体积未减小，已回退未优化版本",
            None,
            None,
        );
        return Ok(None);
    }
    let info = match gif::probe_file(output_path) {
        Ok(info) => info,
        Err(_) => return Ok(None),
    };
    let mut delays = current_delays_cs.to_vec();
    if info.frame_count != delays.len() {
        delays = recompute_delays_cs(source, info.frame_count, fps_mode, preserve_timing, params.speed);
        progress::emit(
            sink,
            Phase::Optimize,
            94.0,
            format!("优化后帧数 {} 有变化，已重新分配延时", info.frame_count),
            None,
            None,
        );
    }
    let expected_ms: Vec<u32> = delays.iter().map(|cs| cs * 10).collect();
    let delays_ok = info.frame_delays_ms == expected_ms;
    let loop_ok = info.loop_count == params.loop_count;
    if delays_ok && loop_ok {
        progress::emit(
            sink,
            Phase::Optimize,
            96.0,
            format!(
                "体积优化完成：{:.2}MB（原 {:.2}MB）",
                after as f64 / 1024.0 / 1024.0,
                before as f64 / 1024.0 / 1024.0
            ),
            None,
            None,
        );
        return Ok(Some((output_path.to_path_buf(), info, delays)));
    }
    let fixed_path = PathBuf::from(format!("{}.fixed.gif", output_path.to_string_lossy()));
    let patch_options = PatchGifOptions {
        min_cs: Some(MIN_DELAY_CS),
        loop_count: Some(params.loop_count),
    };
    match gif::patch_delays(output_path, &fixed_path, &delays, &patch_options) {
        Ok(fixed_info) => {
            progress::emit(sink, Phase::Optimize, 96.0, "体积优化完成并校正延时", None, None);
            Ok(Some((fixed_path, fixed_info, delays)))
        }
        Err(_) => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 收尾：WebP
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn finalize_webp(
    frames_dir: &Path,
    encoded_path: &Path,
    actual_frames: usize,
    source: &MediaProbe,
    fps_mode: FpsMode,
    preserve_timing: bool,
    params: &GifParams,
    _cancel: &AtomicBool,
    target_delays_cs: &mut Vec<u32>,
    warnings: &mut Vec<String>,
    sink: &mut dyn ProgressSink,
    final_path: &mut PathBuf,
) -> Result<FinalInfo, ConvertError> {
    let encoded_probe = webp::probe_file(encoded_path)
        .map_err(|error| convert_error("编码", format!("无法读取编码后的 WebP：{}", error)))?;
    if encoded_probe.frame_count == 0 {
        return Err(convert_error("编码", "编码器没有生成任何 WebP 帧"));
    }
    let mut target_delays_ms: Vec<u32> = target_delays_cs.iter().map(|cs| cs * 10).collect();
    if encoded_probe.frame_count != target_delays_ms.len() {
        target_delays_ms = recompute_delays_cs(
            source,
            encoded_probe.frame_count,
            fps_mode,
            preserve_timing,
            params.speed,
        )
        .iter()
        .map(|cs| cs * 10)
        .collect();
        let message = format!(
            "编码器帧数 {} 与抽帧 {} 不一致，已按时间比例还原时长",
            encoded_probe.frame_count, actual_frames
        );
        progress::emit(sink, Phase::Encode, 90.0, message.clone(), None, None);
        progress::emit(sink, Phase::Finalize, 90.0, message.clone(), None, None);
        warnings.push(message);
    }

    progress::emit(sink, Phase::Finalize, 90.0, "正在写入 WebP 逐帧延时…", None, None);
    let delayed_path = frames_dir.join("delayed.webp");
    let mut accepted_path = delayed_path.clone();
    let mut info = webp::patch_delays(encoded_path, &delayed_path, &target_delays_ms)
        .map_err(|error| convert_error("还原逐帧延时", format!("写入 WebP 逐帧延时失败：{}", error)))?;

    progress::emit(sink, Phase::Finalize, 96.0, "正在校验 WebP 输出…", None, None);
    if info.frame_count != target_delays_ms.len() {
        target_delays_ms = recompute_delays_cs(
            source,
            info.frame_count,
            fps_mode,
            preserve_timing,
            params.speed,
        )
        .iter()
        .map(|cs| cs * 10)
        .collect();
        let repaired_path = frames_dir.join("final-delays.webp");
        info = webp::patch_delays(&delayed_path, &repaired_path, &target_delays_ms)
            .map_err(|error| convert_error("收尾", format!("重新写入 WebP 逐帧延时失败：{}", error)))?;
        accepted_path = repaired_path;
        progress::emit(
            sink,
            Phase::Finalize,
            97.0,
            format!("最终帧数 {} 已重新分配逐帧延时", info.frame_count),
            None,
            None,
        );
    }
    if info.frame_count != target_delays_ms.len() {
        return Err(convert_error(
            "收尾",
            format!(
                "输出 WebP 帧数（{}）与逐帧延时数量（{}）不一致；请重试或更换参数",
                info.frame_count,
                target_delays_ms.len()
            ),
        ));
    }
    if matches!(fps_mode, FpsMode::Source) && info.frame_count != actual_frames {
        let message = format!(
            "编码器输出 {} 帧，与抽帧 {} 帧不同（已按时间比例还原时长）",
            info.frame_count, actual_frames
        );
        progress::emit(sink, Phase::Finalize, 97.0, message.clone(), None, None);
        warnings.push(message);
    }
    let expected_duration_ms: i64 = target_delays_ms.iter().map(|ms| i64::from(*ms)).sum();
    let actual_duration_ms: i64 = info.frame_delays_ms.iter().map(|ms| i64::from(*ms)).sum();
    let duration_delta = (actual_duration_ms - expected_duration_ms).abs();
    if duration_delta > 50 {
        return Err(convert_error(
            "收尾",
            format!("WebP 总时长与期望相差 {}ms（超过 50ms）", duration_delta),
        ));
    }
    let source_delta_ms = (actual_duration_ms as f64 - source.duration_sec * 1000.0).abs();
    if source_delta_ms > 50.0 {
        let message = format!("提示：WebP 时长与源相差 {:.0}ms", source_delta_ms);
        progress::emit(sink, Phase::Finalize, 98.0, message.clone(), None, None);
        warnings.push(message);
    }
    *target_delays_cs = target_delays_ms
        .iter()
        .map(|ms| (ms + 5) / 10)
        .collect();
    *final_path = accepted_path;
    Ok(FinalInfo::from_webp(&info))
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

fn recompute_delays_cs(
    source: &MediaProbe,
    target_frames: usize,
    fps_mode: FpsMode,
    preserve_timing: bool,
    speed: f64,
) -> Vec<u32> {
    timeline::resolve_delays_for_frames(
        &source.frame_durations_ms,
        source.duration_sec,
        target_frames,
        fps_mode,
        preserve_timing,
        speed,
    )
    .delays_cs
}

fn check_process(result: RunResult, stage: &str, tool: &str) -> Result<RunResult, ConvertError> {
    if result.cancelled {
        return Err(cancelled_error());
    }
    if result.timed_out {
        return Err(convert_error(stage, format!("{} 执行超时", tool)));
    }
    if !result.success() {
        let tail = result.tail(6);
        let message = if tail.is_empty() {
            format!("{} 退出码 {:?}", tool, result.code)
        } else {
            format!("{} 退出码 {:?}：{}", tool, result.code, tail)
        };
        return Err(stage_error(stage, message, Some(tail)));
    }
    Ok(result)
}

fn file_nonempty(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

/// ffmpeg `-framerate` 文本：整数帧率输出整数，否则保留 3 位小数并去掉末尾 0。
fn frame_rate_string(fps: f64) -> String {
    let rounded = (fps * 1000.0).round() / 1000.0;
    if (rounded - rounded.trunc()).abs() < 1e-9 {
        return format!("{}", rounded as i64);
    }
    let mut text = format!("{:.3}", rounded);
    while text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

/// 转换结束时清理帧目录与中间产物（`keep_frames` 为 true 时保留）。
struct CleanupGuard {
    keep: bool,
    dirs: Vec<PathBuf>,
}

impl CleanupGuard {
    fn new(keep: bool) -> CleanupGuard {
        CleanupGuard {
            keep,
            dirs: Vec::new(),
        }
    }

    fn watch_dir(&mut self, dir: PathBuf) {
        self.dirs.push(dir);
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        for dir in &self.dirs {
            if dir.exists() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_args_passthrough_has_no_filter() {
        let args = build_extract_args(
            Path::new("in.mp4"),
            Path::new("frames"),
            FpsMode::Source,
            480,
            480,
        );
        assert!(args.contains(&"-fps_mode".to_string()));
        assert!(args.contains(&"passthrough".to_string()));
        assert!(!args.contains(&"-vf".to_string()));
        assert_eq!(args.last().unwrap(), "frames\\%06d.png");
    }

    #[test]
    fn extract_args_fps_and_scale_are_combined() {
        let args = build_extract_args(
            Path::new("in.mp4"),
            Path::new("frames"),
            FpsMode::Numeric(15),
            320,
            640,
        );
        let filter_index = args.iter().position(|arg| arg == "-vf").expect("-vf");
        assert_eq!(args[filter_index + 1], "fps=15,scale=320:-2:flags=lanczos");
        assert!(!args.contains(&"-fps_mode".to_string()));
    }

    #[test]
    fn frame_rate_text_matches_electron() {
        assert_eq!(frame_rate_string(30.0), "30");
        assert_eq!(frame_rate_string(23.976), "23.976");
        assert_eq!(frame_rate_string(29.97), "29.97");
        assert_eq!(frame_rate_string(15.0), "15");
    }

    #[test]
    fn scan_frame_progress_reads_carriage_return_chunks() {
        let chunks = "Frame 1/90\rFrame 12/90\rFrame 90/90\r";
        let found = scan_frame_progress(chunks);
        assert_eq!(found.len(), 3);
        assert_eq!(found.last().copied(), Some((90, 90)));
    }

    #[test]
    fn check_process_reports_non_zero_exit() {
        let result = RunResult {
            code: Some(1),
            timed_out: false,
            cancelled: false,
            stdout: String::new(),
            stderr: "line1\nline2".to_string(),
        };
        let error = check_process(result, "编码", "ffmpeg").expect_err("should fail");
        assert_eq!(error.stage, "编码");
        assert!(error.message.contains("退出码"));
    }
}
