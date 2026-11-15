// GIF / WebP 转换流水线：ffmpeg 抽全部帧 → gifski / ffmpeg 编码 → 按源 MP4 逐帧时长还原延时 → 写入输出目录与历史。
#![allow(dead_code)]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::http::build_client;
use crate::jobs::JobCtx;
use crate::model::{AppSettings, GifInfo, GifResult, MediaProbe, TweetMedia};
use crate::{history, media, paths, probe_gif, probe_mp4, probe_webp, settings, tools, tweet};

const MIN_DELAY_CS: u16 = 2;
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

const DEFAULT_PARAMS: &str = r#"{
  "encoder": "gifski",
  "width": null,
  "maxLongSide": null,
  "fps": "source",
  "colors": 256,
  "quality": 92,
  "dither": "sierra2_4a",
  "preserveTiming": true,
  "optimize": false,
  "lossy": 0,
  "speed": 1,
  "loopCount": 0
}"#;

fn param<'a>(params: &'a Value, key: &str) -> Option<&'a Value> {
    params.get(key)
}

fn param_f64(params: &Value, key: &str, fallback: f64) -> f64 {
    match param(params, key) {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(fallback),
        Some(Value::String(text)) => text.parse().unwrap_or(fallback),
        _ => fallback,
    }
}

fn param_i64(params: &Value, key: &str, fallback: i64) -> i64 {
    param_f64(params, key, fallback as f64).round() as i64
}

fn param_bool(params: &Value, key: &str, fallback: bool) -> bool {
    match param(params, key) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) != 0,
        _ => fallback,
    }
}

fn param_string(params: &Value, key: &str, fallback: &str) -> String {
    match param(params, key) {
        Some(Value::String(text)) => text.clone(),
        _ => fallback.to_string(),
    }
}

fn param_width(params: &Value) -> Option<u32> {
    param_f64(params, "width", 0.0)
        .round()
        .pipe(|value| if value > 0.0 { Some(value as u32) } else { None })
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

fn unique_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{counter:x}")
}

// ---------------------------------------------------------------------------
// 时间轴计算
// ---------------------------------------------------------------------------

fn compute_delays_cs(durations_ms: &[f64], speed: f64) -> Vec<u16> {
    if durations_ms.is_empty() {
        return Vec::new();
    }
    let speed = if speed.is_finite() && speed > 0.0 { speed } else { 1.0 };
    let mut delays = Vec::with_capacity(durations_ms.len());
    let mut cumulative = 0.0f64;
    let mut assigned = 0f64;
    for duration in durations_ms {
        cumulative += duration.max(0.0) / speed;
        let mut cs = (cumulative / 10.0).round() - assigned;
        if cs < MIN_DELAY_CS as f64 {
            cs = MIN_DELAY_CS as f64;
        }
        delays.push(cs as u16);
        assigned += cs;
    }
    delays
}

fn average_frame_duration(probe: &MediaProbe) -> f64 {
    if !probe.frame_durations_ms.is_empty() {
        let total: f64 = probe.frame_durations_ms.iter().sum();
        if total > 0.0 {
            return total / probe.frame_durations_ms.len() as f64;
        }
    }
    if probe.duration_sec > 0.0 && probe.frame_count > 0 {
        return probe.duration_sec * 1000.0 / probe.frame_count as f64;
    }
    0.0
}

fn nominal_fps(average_ms: f64) -> f64 {
    if average_ms <= 0.0 {
        return 25.0;
    }
    ((1000.0 / average_ms).clamp(1.0, 100.0) * 1000.0).round() / 1000.0
}

fn uniform_durations(duration_sec: f64, frame_count: usize) -> Vec<f64> {
    let count = frame_count.max(1);
    let total = (duration_sec.max(0.0) * 1000.0).max(1.0);
    vec![total / count as f64; count]
}

fn group_durations(durations: &[f64], target: usize) -> Vec<f64> {
    let count = target.max(1);
    if durations.is_empty() {
        return vec![0.0; count];
    }
    if durations.len() == count {
        return durations.to_vec();
    }
    let total: f64 = durations.iter().sum();
    if total <= 0.0 {
        return vec![0.0; count];
    }
    let mut result = Vec::with_capacity(count);
    let mut cursor = 0usize;
    let mut accumulated = 0.0f64;
    for index in 0..count {
        let target_end = total * (index + 1) as f64 / count as f64;
        let mut group_total = 0.0f64;
        while cursor < durations.len() && (accumulated < target_end || group_total == 0.0) {
            accumulated += durations[cursor];
            group_total += durations[cursor];
            cursor += 1;
            if cursor >= durations.len() || accumulated >= target_end {
                break;
            }
        }
        result.push(group_total);
    }
    let rest: f64 = durations[cursor..].iter().sum();
    if rest > 0.0 {
        if let Some(last) = result.last_mut() {
            *last += rest;
        }
    }
    result
}

fn align_frame_durations(durations: &[f64], target: usize, duration_sec: f64) -> Vec<f64> {
    if target == 0 {
        return Vec::new();
    }
    if durations.len() == target && !durations.is_empty() {
        return durations.to_vec();
    }
    if durations.is_empty() {
        return uniform_durations(duration_sec, target);
    }
    if durations.len() > target {
        return group_durations(durations, target);
    }
    uniform_durations(duration_sec, target)
}

/// 返回 (厘秒延时, 是否发生帧数对齐)
fn resolve_delays(probe: &MediaProbe, target_frames: usize, fps_source: bool, preserve_timing: bool, speed: f64) -> (Vec<u16>, bool) {
    let frames = target_frames.max(1);
    let durations = if preserve_timing && fps_source && !probe.frame_durations_ms.is_empty() {
        align_frame_durations(&probe.frame_durations_ms, frames, probe.duration_sec)
    } else {
        uniform_durations(probe.duration_sec, frames)
    };
    let delays = compute_delays_cs(&durations, speed);
    (delays, frames != probe.frame_durations_ms.len())
}

// ---------------------------------------------------------------------------
// 抽帧 / 编码
// ---------------------------------------------------------------------------

async fn extract_frames(
    job: &JobCtx,
    input: &str,
    frames_dir: &Path,
    fps: Option<u32>,
    target_width: u32,
    source_width: u32,
    expected_frames: u32,
) -> Result<Vec<PathBuf>, String> {
    let _ = std::fs::remove_dir_all(frames_dir);
    std::fs::create_dir_all(frames_dir).map_err(|error| error.to_string())?;
    let pattern = frames_dir.join("%06d.png").to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-i".into(),
        input.to_string(),
    ];
    let mut filters: Vec<String> = Vec::new();
    if let Some(fps) = fps {
        filters.push(format!("fps={fps}"));
    }
    if target_width > 0 && target_width < source_width {
        filters.push(format!("scale={target_width}:-2:flags=lanczos"));
    }
    if !filters.is_empty() {
        args.push("-vf".into());
        args.push(filters.join(","));
    }
    if fps.is_none() {
        args.push("-fps_mode".into());
        args.push("passthrough".into());
    }
    args.push(pattern);
    let expected = expected_frames.max(1) as f64;
    job.progress("extract", 8.0, "开始抽取视频帧…");
    let result = tools::run_tool(Some(job), "ffmpeg", &args, None, |line| {
        if let Some(rest) = line.strip_prefix("frame=") {
            if let Ok(frame) = rest.trim().parse::<u32>() {
                let ratio = (frame as f64 / expected).min(1.0);
                job.progress(
                    "extract",
                    8.0 + ratio * 47.0,
                    &format!("正在抽取视频帧（{frame}）…"),
                );
            }
        }
    })
    .await?;
    if result.code != 0 {
        return Err(format!("ffmpeg 抽帧失败：{}", tail(&result)));
    }
    let mut frames: Vec<PathBuf> = std::fs::read_dir(frames_dir)
        .map_err(|error| error.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|value| value.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
        })
        .collect();
    frames.sort();
    if frames.is_empty() {
        return Err("没有抽取到任何视频帧（源文件可能没有视频轨）".into());
    }
    Ok(frames)
}

fn tail(result: &tools::ProcessResult) -> String {
    let text = if result.stderr.trim().is_empty() { &result.stdout } else { &result.stderr };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" / ")
}

async fn encode_gifski(
    job: &JobCtx,
    frames_dir: &Path,
    frames: &[PathBuf],
    output: &Path,
    nominal_fps: f64,
    quality: i64,
    width: u32,
    loop_count: i64,
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "-o".into(),
        output.to_string_lossy().to_string(),
        "--fps".into(),
        format!("{nominal_fps:.3}"),
        "--quality".into(),
        quality.clamp(1, 100).to_string(),
        "--repeat".into(),
        loop_count.to_string(),
        "--no-sort".into(),
    ];
    if width > 0 {
        args.push("--width".into());
        args.push(width.to_string());
    }
    for frame in frames {
        args.push(frame.to_string_lossy().to_string());
    }
    job.progress("encode", 55.0, "正在编码 GIF（gifski）…");
    let result = tools::run_tool(Some(job), "gifski", &args, Some(frames_dir), |line| {
        if let Some(position) = line.find("Frame ") {
            let text = &line[position + 6..];
            if let Some((current, total)) = text.split_once('/') {
                let current: f64 = current.trim().parse().unwrap_or(0.0);
                let total: f64 = total.trim().parse().unwrap_or(0.0);
                if total > 0.0 {
                    job.progress(
                        "encode",
                        55.0 + (current / total).min(1.0) * 35.0,
                        &format!("正在编码 GIF（{:.0}/{:.0} 帧）…", current, total),
                    );
                }
            }
        }
    })
    .await?;
    if result.code != 0 {
        return Err(format!("gifski 编码失败：{}", tail(&result)));
    }
    if paths::file_size(output) == 0 {
        return Err("gifski 没有生成 GIF 文件".into());
    }
    job.progress("encode", 90.0, "GIF 编码完成");
    Ok(())
}

async fn encode_ffmpeg_gif(
    job: &JobCtx,
    frames_dir: &Path,
    frames: &[PathBuf],
    output: &Path,
    nominal_fps: f64,
    colors: i64,
    dither: &str,
    loop_count: i64,
) -> Result<(), String> {
    let palette = frames_dir.join("palette.png");
    let pattern = frames_dir.join("%06d.png").to_string_lossy().to_string();
    let palette_args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-framerate".into(),
        format!("{nominal_fps}"),
        "-i".into(),
        pattern.clone(),
        "-vf".into(),
        format!("palettegen=stats_mode=diff:max_colors={}", colors.clamp(2, 256)),
        palette.to_string_lossy().to_string(),
    ];
    job.progress("encode", 55.0, "正在生成调色板…");
    let result = tools::run_tool(Some(job), "ffmpeg", &palette_args, None, |_| {}).await?;
    if result.code != 0 || !palette.exists() {
        return Err(format!("调色板生成失败：{}", tail(&result)));
    }
    let dither = if ["sierra2_4a", "bayer", "none"].contains(&dither) { dither } else { "sierra2_4a" };
    let encode_args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-framerate".into(),
        format!("{nominal_fps}"),
        "-i".into(),
        pattern,
        "-i".into(),
        palette.to_string_lossy().to_string(),
        "-lavfi".into(),
        format!("paletteuse=dither={dither}:diff_mode=rectangle"),
        "-loop".into(),
        loop_count.to_string(),
        output.to_string_lossy().to_string(),
    ];
    job.progress("encode", 65.0, "正在用 ffmpeg 编码 GIF…");
    let result = tools::run_tool(Some(job), "ffmpeg", &encode_args, None, |_| {}).await?;
    if result.code != 0 {
        return Err(format!("ffmpeg 编码 GIF 失败：{}", tail(&result)));
    }
    if paths::file_size(output) == 0 {
        return Err("ffmpeg 没有生成 GIF 文件".into());
    }
    job.progress("encode", 90.0, "GIF 编码完成");
    Ok(())
}

async fn encode_webp(
    job: &JobCtx,
    frames_dir: &Path,
    frames: &[PathBuf],
    output: &Path,
    delays_ms: &[u32],
    quality: i64,
    loop_count: i64,
) -> Result<(), String> {
    let list_path = frames_dir.join("webp-concat.txt");
    let mut lines = String::new();
    for (index, frame) in frames.iter().enumerate() {
        let name = frame.file_name().and_then(|name| name.to_str()).unwrap_or("");
        lines.push_str(&format!("file '{name}'\n"));
        let duration = delays_ms.get(index).copied().unwrap_or(40).max(1);
        lines.push_str(&format!("duration {:.6}\n", duration as f64 / 1000.0));
    }
    std::fs::write(&list_path, lines).map_err(|error| error.to_string())?;
    let loop_value = if loop_count < 0 { 1 } else { loop_count.clamp(0, 65535) };
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.to_string_lossy().to_string(),
        "-c:v".into(),
        "libwebp_anim".into(),
        "-lossless".into(),
        "0".into(),
        "-q:v".into(),
        quality.clamp(1, 100).to_string(),
        "-loop".into(),
        loop_value.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        output.to_string_lossy().to_string(),
    ];
    job.progress("encode", 55.0, "正在编码 WebP…");
    let result = tools::run_tool(Some(job), "ffmpeg", &args, Some(frames_dir), |_| {}).await?;
    if result.code != 0 {
        return Err(format!("ffmpeg 编码 WebP 失败：{}", tail(&result)));
    }
    if paths::file_size(output) == 0 {
        return Err("ffmpeg 没有生成 WebP 文件".into());
    }
    job.progress("encode", 90.0, "WebP 编码完成");
    Ok(())
}

/// 用 gifsicle 做体积优化（可选）。
async fn optimize_gif(job: &JobCtx, input: &Path, output: &Path, lossy: i64, colors: i64) -> Option<PathBuf> {
    tools::resolve("gifsicle")?;
    let mut args: Vec<String> = vec!["-O3".into()];
    if lossy > 0 {
        args.push(format!("--lossy={lossy}"));
    }
    if colors < 256 && colors > 1 {
        args.push("--colors".into());
        args.push(colors.to_string());
    }
    args.push(input.to_string_lossy().to_string());
    args.push("-o".into());
    args.push(output.to_string_lossy().to_string());
    job.progress("optimize", 91.0, "正在用 gifsicle 压缩体积…");
    let result = tools::run_tool(Some(job), "gifsicle", &args, None, |_| {}).await.ok()?;
    if result.code != 0 || paths::file_size(output) == 0 {
        return None;
    }
    Some(output.to_path_buf())
}

// ---------------------------------------------------------------------------
// 输出与主流程
// ---------------------------------------------------------------------------

fn format_timestamp() -> String {
    paths::format_timestamp(SystemTime::now())
}

fn preset_segment(preset_id: &Option<String>) -> String {
    match preset_id.as_deref() {
        Some(value) if ["source", "balanced", "small", "mini"].contains(&value) => value.to_string(),
        _ => "custom".into(),
    }
}

fn build_output_file_name(
    screen_name: &str,
    tweet_id: &str,
    media_index: usize,
    width: u32,
    height: u32,
    preset_id: &Option<String>,
    format: &str,
) -> String {
    format!(
        "{}_{}_{}_{}x{}_{}_{}.{}",
        paths::safe_name(screen_name, "x"),
        tweet_id,
        media_index,
        width,
        height,
        preset_segment(preset_id),
        format_timestamp(),
        format
    )
}

fn screenshot_screen_name(tweet_id: &str) -> String {
    if let Some(info) = tweet::get_cached(tweet_id) {
        if !info.author.screen_name.is_empty() {
            return info.author.screen_name;
        }
    }
    history::get(tweet_id)
        .map(|entry| entry.author.screen_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "x".into())
}

pub struct ConvertRequest {
    pub job_id: String,
    pub tweet_id: String,
    pub media: TweetMedia,
    pub params: Value,
    pub preset_id: Option<String>,
    pub format: Option<String>,
    pub auto_save: bool,
}

fn cancelled(error: &str) -> bool {
    error.starts_with("CANCELLED")
}

pub async fn convert(app_settings: &AppSettings, request: ConvertRequest) -> Result<GifResult, String> {
    let format = match request.format.as_deref() {
        None | Some("") => "gif".to_string(),
        Some("gif") => "gif".to_string(),
        Some("webp") => "webp".to_string(),
        Some(other) => return Err(format!("不支持的输出格式：{other}（仅支持 gif / webp）")),
    };
    let media_item = request.media.clone();
    if media_item.kind == "photo" {
        return Err("图片不支持转换为 GIF，请选择 GIF 或视频".into());
    }
    if media_item.source_url.is_empty() {
        return Err("缺少要转换的媒体信息，请重新解析推文".into());
    }
    let job = JobCtx::start(&request.job_id, "gif");
    let result = convert_inner(app_settings, &job, format.clone(), request, media_item).await;
    match result {
        Ok(value) => {
            job.progress("done", 100.0, &format!("{} 已保存：{}", if format == "webp" { "WebP" } else { "GIF" }, value.info.file_name));
            job.finish();
            Ok(value)
        }
        Err(error) => {
            if cancelled(&error) {
                job.progress("cancelled", 0.0, "任务已取消");
                job.finish();
                return Err("CANCELLED: 任务已取消".into());
            }
            job.progress("error", 0.0, &error);
            job.finish();
            Err(error)
        }
    }
}

async fn convert_inner(
    app_settings: &AppSettings,
    job: &JobCtx,
    format: String,
    request: ConvertRequest,
    media_item: TweetMedia,
) -> Result<GifResult, String> {
    let base_params: Value = serde_json::from_str(DEFAULT_PARAMS).unwrap_or(json!({}));
    let params = if request.params.is_object() { request.params.clone() } else { base_params };
    let encoder = param_string(&params, "encoder", "gifski");
    let fps_source = param_string(&params, "fps", "source") == "source";
    let fps_number = param_f64(&params, "fps", 15.0).round().clamp(1.0, 60.0) as u32;
    let preserve_timing = param_bool(&params, "preserveTiming", true);
    let speed = param_f64(&params, "speed", 1.0).clamp(0.25, 4.0);
    let quality = param_i64(&params, "quality", 92);
    let colors = param_i64(&params, "colors", 256);
    let dither = param_string(&params, "dither", "sierra2_4a");
    let loop_count = param_i64(&params, "loopCount", 0).clamp(-1, 65535);
    let optimize = param_bool(&params, "optimize", false);
    let lossy = param_i64(&params, "lossy", 0);
    let preset_id = request.preset_id.clone();

    tools::require("ffmpeg")?;
    if format == "gif" && encoder != "ffmpeg" {
        tools::require("gifski")?;
    }

    // 1. 准备源媒体（优先复用已保存原文件，否则下载到缓存）
    job.progress("download", 0.0, "正在准备媒体…");
    let saved = history::find_saved(&request.tweet_id, &media_item.id, None)
        .filter(|item| std::path::Path::new(&item.file_path).exists());
    let (local_path, source_probe, source_saved) = match saved {
        Some(saved) => {
            job.progress("probe", 4.0, &format!("使用已保存的原始媒体：{}", saved.file_name));
            let probe = probe_mp4::probe(&saved.file_path)?;
            (saved.file_path.clone(), probe, Some(saved))
        }
        None => {
            let source_saved = if request.auto_save {
                job.progress("download", 0.0, "正在自动保存源媒体…");
                let saved = media::save(app_settings, job, &request.tweet_id, &media_item, false).await?;
                Some(saved.saved)
            } else {
                None
            };
            let prepared = media::prepare(app_settings, job, &request.tweet_id, &media_item, false).await?;
            (prepared.local_path, prepared.probe, source_saved)
        }
    };
    job.throw_if_cancelled()?;
    if source_probe.frame_count == 0 {
        return Err("源媒体没有可用的视频帧".into());
    }

    // 2. 抽帧参数
    let source_width = source_probe.width.max(1);
    let target_width = param_width(&params)
        .map(|width| width.clamp(16, source_width))
        .unwrap_or(source_width);
    let expected_frames = if fps_source {
        source_probe.frame_count
    } else {
        ((source_probe.duration_sec * fps_number as f64).round() as u32).max(1)
    };
    let frames_dir = paths::ensure_dir(
        paths::frames_root().join(format!("{}-{}", paths::safe_name(&media_item.id, "media"), paths::now_ms())),
    );
    let frames = extract_frames(
        job,
        &local_path,
        &frames_dir,
        if fps_source { None } else { Some(fps_number) },
        target_width,
        source_width,
        expected_frames,
    )
    .await?;
    job.throw_if_cancelled()?;
    let actual_frames = frames.len();
    let (mut delays_cs, mut aligned) =
        resolve_delays(&source_probe, actual_frames, fps_source, preserve_timing, speed);
    job.progress(
        "extract",
        55.0,
        &format!(
            "抽帧完成：共 {actual_frames} 帧{}",
            if aligned && preserve_timing { "（已按时间比例对齐）" } else { "" }
        ),
    );

    // 3. 编码
    let nominal = nominal_fps(average_frame_duration(&source_probe));
    let encoded_path = frames_dir.join(if format == "webp" { "encoded.webp" } else { "encoded.gif" });
    if format == "webp" {
        let delays_ms: Vec<u32> = delays_cs.iter().map(|value| *value as u32 * 10).collect();
        encode_webp(job, &frames_dir, &frames, &encoded_path, &delays_ms, quality, loop_count).await?;
        let encoded_probe = probe_webp::probe(&encoded_path.to_string_lossy())?;
        if encoded_probe.frame_count != delays_ms.len() {
            let (repair, _) = resolve_delays(&source_probe, encoded_probe.frame_count, fps_source, preserve_timing, speed);
            delays_cs = repair;
            job.progress("encode", 90.0, "编码器帧数与抽帧不一致，已按时间比例还原时长");
        }
        let delays_ms: Vec<u32> = delays_cs.iter().map(|value| *value as u32 * 10).collect();
        let source = std::fs::read(&encoded_path).map_err(|error| error.to_string())?;
        let patched = probe_webp::patch_delays(&source, &delays_ms)?;
        let delayed_path = frames_dir.join("delayed.webp");
        std::fs::write(&delayed_path, &patched).map_err(|error| error.to_string())?;
        finish_output(app_settings, job, &request, &media_item, &source_probe, source_saved, &delayed_path, "webp", &params, &preset_id, &delays_cs).await
    } else {
        match encoder.as_str() {
            "ffmpeg" => encode_ffmpeg_gif(job, &frames_dir, &frames, &encoded_path, nominal, colors, &dither, loop_count).await?,
            _ => encode_gifski(job, &frames_dir, &frames, &encoded_path, nominal, quality, target_width, loop_count).await?,
        }
        let encoded_probe = probe_gif::probe(&encoded_path.to_string_lossy())?;
        if encoded_probe.frame_count != delays_cs.len() {
            let (repair, _) = resolve_delays(&source_probe, encoded_probe.frame_count, fps_source, preserve_timing, speed);
            delays_cs = repair;
            aligned = true;
            job.progress("encode", 90.0, "编码器帧数与抽帧不一致，已按时间比例还原时长");
        }
        let source = std::fs::read(&encoded_path).map_err(|error| error.to_string())?;
        let patched = probe_gif::patch_delays(&source, &delays_cs, Some(loop_count as i32))?;
        let mut delayed_path = frames_dir.join("delayed.gif");
        std::fs::write(&delayed_path, &patched).map_err(|error| error.to_string())?;
        if optimize {
            let optimized_path = frames_dir.join("optimized.gif");
            if let Some(optimized) = optimize_gif(job, &delayed_path, &optimized_path, lossy, colors).await {
                let before = paths::file_size(&delayed_path);
                let after = paths::file_size(&optimized);
                if after > 0 && after < before {
                    let optimized_probe = probe_gif::probe(&optimized.to_string_lossy())?;
                    if optimized_probe.frame_count == delays_cs.len() {
                        delayed_path = optimized;
                        job.progress("optimize", 96.0, &format!("体积优化完成：{:.2}MB（原 {:.2}MB）", after as f64 / 1024.0 / 1024.0, before as f64 / 1024.0 / 1024.0));
                    }
                }
            }
        }
        let _ = aligned;
        finish_output(app_settings, job, &request, &media_item, &source_probe, source_saved, &delayed_path, "gif", &params, &preset_id, &delays_cs).await
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish_output(
    app_settings: &AppSettings,
    job: &JobCtx,
    request: &ConvertRequest,
    media_item: &TweetMedia,
    source_probe: &MediaProbe,
    source_saved: Option<crate::model::SavedMedia>,
    final_source: &Path,
    format: &str,
    params: &Value,
    preset_id: &Option<String>,
    delays_cs: &[u16],
) -> Result<GifResult, String> {
    job.progress("finalize", 96.0, "正在校验输出文件…");
    let (width, height, frame_count, frame_delays_ms, loop_count, final_probe) = if format == "webp" {
        let probe = probe_webp::probe(&final_source.to_string_lossy())?;
        (probe.width, probe.height, probe.frame_count, probe.frame_delays_ms.clone(), probe.loop_count, probe.size_bytes)
    } else {
        let probe = probe_gif::probe(&final_source.to_string_lossy())?;
        (probe.width, probe.height, probe.frame_count, probe.frame_delays_ms.clone(), Some(probe.loop_count as u16), probe.size_bytes)
    };
    let _ = loop_count;
    if frame_count != delays_cs.len() {
        return Err(format!(
            "输出帧数（{frame_count}）与逐帧延时数量（{}）不一致，请重试或更换预设",
            delays_cs.len()
        ));
    }
    if format == "gif" && frame_delays_ms.iter().any(|value| *value < (MIN_DELAY_CS as u32 * 10)) {
        return Err("输出 GIF 存在小于 2cs 的帧延时".into());
    }
    let total_ms: u64 = frame_delays_ms.iter().map(|value| *value as u64).sum();
    let duration_sec = (total_ms as f64 / 1000.0 * 1000.0).round() / 1000.0;
    let fps = if total_ms > 0 {
        (frame_count as f64 / (total_ms as f64 / 1000.0) * 1000.0).round() / 1000.0
    } else {
        0.0
    };

    let output_dir = settings::effective_output_dir(app_settings);
    let screen_name = screenshot_screen_name(&request.tweet_id);
    let media_index = media::media_index(&media::require_tweet(&request.tweet_id)?, &media_item.id);
    let author_dir = output_dir.join(paths::safe_name(&screen_name, "x"));
    let tweet_dir = author_dir.join(paths::safe_name(&request.tweet_id, "tweet"));
    paths::ensure_dir(tweet_dir.clone());
    let file_name = build_output_file_name(&screen_name, &request.tweet_id, media_index, width, height, preset_id, format);
    let target = paths::unique_path(&tweet_dir, &file_name);
    paths::copy_atomic(final_source, &target)?;
    let size_bytes = paths::file_size(&target);
    let _ = final_probe;
    let info = GifInfo {
        path: target.to_string_lossy().to_string(),
        file_name: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or(file_name),
        width,
        height,
        size_bytes,
        frame_count: frame_count as u32,
        duration_sec,
        fps,
        frame_delays_ms,
    };
    let result = GifResult {
        id: unique_id(),
        tweet_id: request.tweet_id.clone(),
        media_id: media_item.id.clone(),
        gif_path: info.path.clone(),
        format: Some(format.to_string()),
        info,
        params: params.clone(),
        preset_id: preset_id.clone(),
        created_at: paths::iso_now(),
        copies: Vec::new(),
        source_probe: Some(source_probe.clone()),
        source_saved,
    };
    let tweet = media::require_tweet(&request.tweet_id)?;
    let _ = history::record_result(&tweet, media_item, source_probe, &result);
    job.progress("finalize", 100.0, &format!("{} 转换完成", if format == "webp" { "WebP" } else { "GIF" }));
    Ok(result)
}

// ---------------------------------------------------------------------------
// 读取已有动图信息
// ---------------------------------------------------------------------------

pub fn gif_info(file_path: &str) -> Result<GifInfo, String> {
    let path = Path::new(file_path);
    let metadata = std::fs::metadata(path).map_err(|_| format!("动图文件不存在或已被移动：{file_path}"))?;
    let header = std::fs::read(path).map_err(|error| format!("读取动图失败：{error}"))?;
    let is_webp = header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP";
    let (width, height, frame_count, frame_delays_ms, duration_sec, fps) = if is_webp {
        let probe = probe_webp::probe(file_path)?;
        let total: u64 = probe.frame_delays_ms.iter().map(|value| *value as u64).sum();
        (
            probe.width,
            probe.height,
            probe.frame_count,
            probe.frame_delays_ms.clone(),
            ((total as f64 / 1000.0) * 1000.0).round() / 1000.0,
            if total > 0 { (probe.frame_count as f64 / (total as f64 / 1000.0) * 1000.0).round() / 1000.0 } else { 0.0 },
        )
    } else {
        let probe = probe_gif::probe(file_path)?;
        let total: u64 = probe.frame_delays_ms.iter().map(|value| *value as u64).sum();
        (
            probe.width,
            probe.height,
            probe.frame_count,
            probe.frame_delays_ms.clone(),
            ((total as f64 / 1000.0) * 1000.0).round() / 1000.0,
            if total > 0 { (probe.frame_count as f64 / (total as f64 / 1000.0) * 1000.0).round() / 1000.0 } else { 0.0 },
        )
    };
    Ok(GifInfo {
        path: path.to_string_lossy().to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        width,
        height,
        size_bytes: metadata.len(),
        frame_count: frame_count as u32,
        duration_sec,
        fps,
        frame_delays_ms,
    })
}