// GIF 体积预估：按目标尺寸 / 帧率 / gifski 质量真实采样编码后外推。
//
// 背景：gifski 的体积无法用固定 bpp 或源文件倍率准确预测。
//   1) 同一源在不同 quality 下体积并非线性；
//   2) gifski 会对连续帧做差分裁剪（只编码变化区域），静态/缓变内容后续帧几乎不占体积；
//   3) gifski 的逐帧体积还依赖帧间调色板/差分状态的收敛：把帧从完整序列中抽出来后，
//      跨段跳变会让若干后续帧明显偏大（同一个「第二帧」在连续序列与采样序列里可差 50%+）。
// 因此用两个互补样本：
//   A. 跨全片均匀分布的 1–4 段连续帧（内容代表性）；
//   B. 首帧 + 中段一段连续帧（让帧间状态充分收敛，取段内靠后的帧作为稳态样本）。
// 两个样本分别按「首帧字节 + 稳态帧均值 × (总帧数-1)」外推后取平均。
//
// 性能：大文件不再「整片解码 + select 抽帧」。每个连续段用 ffmpeg 输入侧 -ss 精确 seek，
// 只解码该段需要的少量帧；A/B 两个样本用 tokio::join! 并发，样本内各段也并发抽取；
// 进程内对最近 8 条请求结果做缓存（按源文件 mtime/size + 全部参数校验，文件变更自动失效）。
//
// 高分辨率（目标宽度 > 900px）：编码耗时主要花在 gifski 逐帧量化上（4K 约 0.2s/帧）。
// 此时只在两个「代理分辨率」（560 / 800 宽）编码同样的采样帧，测量各自的整片预估字节
// E = k · pixels^α，用两点幂律拟合 α 后外推到目标像素；拟合异常（α 越界、E 不随像素增长等）
// 自动回退全分辨率流程。代理样本的调色板开销相对整片体积可忽略（长视频 <1%），拟合只使用
// 逐帧图像数据字节。目标宽度 ≤ 900px 时保持原全分辨率流程。
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::{media, paths, probe_gif, tools};

const MIN_SAMPLES: usize = 3;
const MAX_SAMPLES: usize = 12;
/// 中段连续样本前 2 帧用于帧间状态收敛，不计入稳态均值。
const MID_WARMUP: usize = 2;
/// 中段连续样本长度上限（不含首帧前）：越小编码越快，精度回归仍 <15%。
const MID_MAX_SEGMENT: usize = 9;
/// 输入侧 seek 提前量（秒）：确保首帧正好落在目标帧上。
const SEEK_EPSILON_SEC: f64 = 0.001;
/// 进程内结果缓存条数。
const CACHE_CAPACITY: usize = 8;
/// 目标宽度超过该值时启用代理分辨率双尺度拟合。
const PROXY_TRIGGER_WIDTH: u32 = 900;
/// 代理分辨率宽度对：目标宽度较大时用 800 / 1120（实测外推 4K 误差 <3%），
/// 900–1120px 的目标用 560 / 800（避免高代理超过目标本身）。
const PROXY_WIDE_LOW: u32 = 800;
const PROXY_WIDE_HIGH: u32 = 1120;
const PROXY_NARROW_LOW: u32 = 560;
const PROXY_NARROW_HIGH: u32 = 800;
/// 目标像素数需超过高代理像素数的该倍数，代理才比全分辨率快（如 720p 目标 ≈1.3× 时全分辨率更快，自动回退）。
const PROXY_MIN_PIXEL_RATIO: f64 = 2.0;
/// 代理模式中段连续样本长度上限（比全分辨率更短以压低编码耗时；精度实测 <3%）。
const PROXY_MID_MAX_SEGMENT: usize = 5;
/// 幂律指数合理范围与像素比合理范围（越界视为异常，回退全分辨率）。
const PROXY_ALPHA_MIN: f64 = 0.5;
const PROXY_ALPHA_MAX: f64 = 1.6;

/// 前端传入的预估请求（与 src/shared/types.ts 的 GifEstimateRequest 对应）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateRequest {
    pub file_path: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub quality: Option<i64>,
    #[serde(default)]
    pub colors: Option<i64>,
    #[serde(default)]
    pub encoder: Option<String>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub frame_count: Option<u32>,
    /// 预估模式：fast / balanced / precise / off（缺省 balanced）。
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateFlags {
    /// 估算模型：exact（样本覆盖全部帧）/ hybrid（均匀段 + 中段融合）/ runs / mid /
    /// naive（采样帧均值外推）/ proxy（代理分辨率双尺度幂律外推）
    pub model: String,
    pub encoder: String,
    /// 是否为采样估算（false 表示样本即全部输出帧，等同实际编码）
    pub sampled: bool,
    /// 总帧数来源：frameCount / durationTimesFps / probe
    pub frame_source: String,
    /// 采样时是否按目标帧率重采样
    pub fps_resampled: bool,
    /// 采样 GIF 帧数是否与抽帧数一致（false 表示有重复帧被合并，模型降级）
    pub frame_count_matched: bool,
    /// 是否命中进程内结果缓存
    pub cached: bool,
    /// 是否使用输入侧 -ss 分段 seek 抽取（当前实现恒为 true）
    pub seeked: bool,
    /// 是否使用代理分辨率双尺度拟合
    pub proxy: bool,
    /// 幂律拟合指数 α（model=proxy 时有效）
    pub proxy_alpha: Option<f64>,
    /// 生效的预估模式：balanced / precise
    pub mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EstimateResult {
    /// 预估输出体积（字节）
    pub estimated_bytes: u64,
    /// 样本 A（跨全片均匀连续段）实际字节数（proxy 模式下为高代理分辨率）
    pub sample_bytes: u64,
    pub sample_frames: u32,
    pub parsed_frames: u32,
    pub total_frames: u32,
    /// 样本 A 的连续段数 / 每段帧数
    pub runs: u32,
    pub run_length: u32,
    /// 样本 A 外推值（仅 runs 模型有效）
    pub run_estimate_bytes: Option<u64>,
    /// 样本 B（首帧 + 中段连续）实际字节数 / 帧数
    pub mid_sample_bytes: Option<u64>,
    pub mid_sample_frames: Option<u32>,
    /// 样本 B 外推值（仅 mid 模型有效）
    pub mid_estimate_bytes: Option<u64>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub quality: i64,
    /// 从开始到返回的耗时（毫秒；缓存命中为查找耗时）
    pub elapsed_ms: u64,
    pub flags: EstimateFlags,
}

// ---------------------------------------------------------------------------
// 结果缓存（进程内最近 8 条）
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    key: String,
    result: EstimateResult,
}

static CACHE: Mutex<Vec<CacheEntry>> = Mutex::new(Vec::new());

fn cache_lookup(key: &str) -> Option<EstimateResult> {
    let cache = CACHE.lock().ok()?;
    cache
        .iter()
        .find(|entry| entry.key == key)
        .map(|entry| entry.result.clone())
}

fn cache_store(key: String, result: &EstimateResult) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|entry| entry.key != key);
        cache.push(CacheEntry {
            key,
            result: result.clone(),
        });
        while cache.len() > CACHE_CAPACITY {
            cache.remove(0);
        }
    }
}

fn effective_estimate_mode(raw: Option<&str>) -> String {
    match raw.unwrap_or("balanced").trim().to_lowercase().as_str() {
        "precise" => "precise".into(),
        "fast" => "fast".into(),
        "off" => "off".into(),
        _ => "balanced".into(),
    }
}

fn cache_key(request: &EstimateRequest, metadata: &std::fs::Metadata, quality: i64, encoder: &str, mode: &str) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);
    format!(
        "{}|{}|{}|{:?}|{:?}|{:?}|{:?}|{}|{}|{:?}|{:?}|{:?}|{:?}",
        mode,
        request.file_path,
        metadata.len(),
        modified,
        request.width,
        request.height,
        request.fps,
        quality,
        encoder,
        request.colors,
        request.duration_sec,
        request.frame_count,
        request.encoder
    )
}

// ---------------------------------------------------------------------------
// 源信息与采样计划
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct SourceMeta {
    width: Option<u32>,
    height: Option<u32>,
    frame_count: Option<u32>,
    duration_sec: Option<f64>,
    fps: Option<f64>,
    /// 每帧起始时间（秒）；MP4 用 stts 逐帧时长、GIF 用逐帧延时累积得到，缺失时用平均 fps 推算。
    frame_times: Vec<f64>,
}

fn with_frame_times(durations_ms: &[f64]) -> Vec<f64> {
    let mut times = Vec::with_capacity(durations_ms.len());
    let mut cursor = 0.0f64;
    for duration in durations_ms {
        times.push(cursor);
        cursor += duration.max(0.0) / 1000.0;
    }
    times
}

fn source_meta(path: &str) -> SourceMeta {
    let mut meta = SourceMeta {
        width: None,
        height: None,
        frame_count: None,
        duration_sec: None,
        fps: None,
        frame_times: Vec::new(),
    };
    if let Some(probe) = media::probe_file(path) {
        meta.width = Some(probe.width);
        meta.height = Some(probe.height);
        meta.frame_count = Some(probe.frame_count).filter(|value| *value > 0);
        meta.duration_sec = Some(probe.duration_sec).filter(|value| *value > 0.0);
        meta.fps = Some(probe.fps).filter(|value| *value > 0.0);
        meta.frame_times = with_frame_times(&probe.frame_durations_ms);
        return meta;
    }
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "gif" {
        if let Ok(probe) = probe_gif::probe(path) {
            let delays: u32 = probe.frame_delays_ms.iter().sum();
            let duration = delays as f64 / 1000.0;
            meta.width = Some(probe.width);
            meta.height = Some(probe.height);
            meta.frame_count = Some(probe.frame_count as u32).filter(|value| *value > 0);
            meta.duration_sec = Some(duration).filter(|value| *value > 0.0);
            meta.fps = if duration > 0.0 {
                Some(probe.frame_count as f64 / duration)
            } else {
                None
            };
            let durations: Vec<f64> = probe
                .frame_delays_ms
                .iter()
                .map(|value| *value as f64)
                .collect();
            meta.frame_times = with_frame_times(&durations);
        }
    }
    meta
}

fn even(value: f64) -> u32 {
    let rounded = (value.round() as i64).max(2);
    (rounded + (rounded & 1)) as u32
}

fn sample_budget(total: u32) -> usize {
    if total as usize <= MAX_SAMPLES {
        total as usize
    } else {
        ((total as f64 / 3.0).ceil() as usize).clamp(MIN_SAMPLES, MAX_SAMPLES)
    }
}

/// 计算采样帧的 seek 时间：重采样时按输出帧时间轴（帧号 / 目标 fps），
/// 否则优先用源逐帧时间戳，缺失时按平均 fps 推算。
struct Seeker {
    frame_times: Vec<f64>,
    uniform_seconds: f64,
    fps_resampled: bool,
    target_fps: f64,
}

impl Seeker {
    fn time_of(&self, index: u32) -> f64 {
        if self.fps_resampled {
            return index as f64 / self.target_fps;
        }
        self.frame_times
            .get(index as usize)
            .copied()
            .unwrap_or_else(|| index as f64 * self.uniform_seconds)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Segment {
    start: u32,
    len: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SampleKind {
    /// 跨全片均匀分布连续段
    Runs,
    /// 首帧 + 中段连续段
    Mid,
}

struct SamplePlan {
    kind: SampleKind,
    segments: Vec<Segment>,
    run_length: u32,
}

fn build_runs_plan(total: u32, budget: usize) -> SamplePlan {
    build_runs_plan_with(total, budget, None)
}

/// 代理模式使用更少的连续段（2 段、每段更长）：减少 seek 解码窗口以进一步降低大文件延迟，
/// 精度已用 800/1120 双代理实测（4K 误差 <3%）。
fn build_proxy_runs_plan(total: u32, budget: usize) -> SamplePlan {
    build_runs_plan_with(total, budget, Some(2))
}

fn build_runs_plan_with(total: u32, budget: usize, runs_override: Option<usize>) -> SamplePlan {
    let budget = budget.min(total as usize).max(1);
    let runs = match runs_override {
        Some(value) => value,
        None => {
            if budget < 6 {
                2
            } else if budget < 8 {
                3
            } else {
                4
            }
        }
    };
    let runs = runs.min((budget / 2).max(1));
    let run_length = (budget / runs).max(1);
    let mut segments: Vec<Segment> = Vec::new();
    for run in 0..runs {
        let start = if runs <= 1 {
            0usize
        } else {
            (((run as f64) * ((total as usize - run_length) as f64) / ((runs - 1) as f64)).round())
                as usize
        };
        let start = start.min(total as usize - 1);
        let len = run_length.min(total as usize - start);
        if len == 0 {
            continue;
        }
        let segment = Segment {
            start: start as u32,
            len: len as u32,
        };
        if !segments.contains(&segment) {
            segments.push(segment);
        }
    }
    SamplePlan {
        kind: SampleKind::Runs,
        segments,
        run_length: run_length as u32,
    }
}

fn build_mid_plan(total: u32, budget: usize) -> SamplePlan {
    build_mid_plan_with(total, budget, MID_MAX_SEGMENT)
}

fn build_mid_plan_with(total: u32, budget: usize, max_segment: usize) -> SamplePlan {
    let length = budget
        .saturating_sub(1)
        .min(MAX_SAMPLES - 1)
        .min(max_segment)
        .max(1);
    let start = ((total as usize).saturating_sub(length) / 2) as u32;
    let mut segments = vec![Segment { start: 0, len: 1 }];
    let available = total.saturating_sub(start);
    if available > 0 {
        let len = (length as u32).min(available);
        if start == 0 {
            // 极短视频：首帧与中段重合时只保留一段，避免重复帧
            segments = vec![Segment { start: 0, len: len.max(1) }];
        } else {
            segments.push(Segment { start, len });
        }
    }
    SamplePlan {
        kind: SampleKind::Mid,
        segments,
        run_length: 0,
    }
}

// ---------------------------------------------------------------------------
// 抽帧 / 编码
// ---------------------------------------------------------------------------

fn tail(result: &tools::ProcessResult) -> String {
    let text = if result.stderr.trim().is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" / ")
}

/// 输入侧 -ss seek 后只解码该段需要的帧（select=lt(n,len) + -frames:v），返回按顺序排列的 PNG。
async fn extract_segment(
    source: String,
    work_dir: PathBuf,
    segment: Segment,
    seek_seconds: f64,
    fps_resampled: bool,
    target_fps: f64,
    out_w: Option<u32>,
    out_h: Option<u32>,
) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(&work_dir).map_err(|error| format!("创建临时目录失败：{error}"))?;
    let pattern = work_dir.join("%06d.png").to_string_lossy().to_string();
    let mut filters: Vec<String> = Vec::new();
    if fps_resampled {
        filters.push(format!("fps={target_fps:.3}"));
    }
    filters.push(format!("select=lt(n\\,{})", segment.len));
    if let (Some(width), Some(height)) = (out_w, out_h) {
        filters.push(format!("scale={width}:{height}:flags=lanczos"));
    } else if let Some(width) = out_w {
        filters.push(format!("scale={width}:-2:flags=lanczos"));
    }
    let seek = if seek_seconds.is_finite() {
        (seek_seconds - SEEK_EPSILON_SEC).max(0.0)
    } else {
        0.0
    };
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-nostats".into(),
        "-ss".into(),
        format!("{seek:.6}"),
        "-i".into(),
        source,
        "-vf".into(),
        filters.join(","),
        "-fps_mode".into(),
        "passthrough".into(),
        // 只解码/输出该段需要的帧数；否则 ffmpeg 会继续解码到文件末尾（大文件的主要耗时来源）。
        "-frames:v".into(),
        segment.len.to_string(),
        pattern,
    ];
    let result = tools::run_tool(None, "ffmpeg", &args, None, |_| {}).await?;
    if result.code != 0 {
        return Err(format!("ffmpeg 分段抽帧失败：{}", tail(&result)));
    }
    let mut frames: Vec<PathBuf> = std::fs::read_dir(&work_dir)
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
    Ok(frames)
}

/// 并发抽取一个样本的全部连续段（最多 4 段），返回每段实际抽到的帧。
async fn extract_segments(
    source: &str,
    root: &std::path::Path,
    segments: &[Segment],
    seeker: &Seeker,
    fps_resampled: bool,
    target_fps: f64,
    out_w: Option<u32>,
    out_h: Option<u32>,
) -> Result<Vec<Vec<PathBuf>>, String> {
    let first = segments.first().copied().ok_or("采样计划为空")?;
    let seek_of = |segment: Segment| seeker.time_of(segment.start);
    let make = |segment: Segment, index: usize| {
        extract_segment(
            source.to_string(),
            root.join(format!("seg{index}")),
            segment,
            seek_of(segment),
            fps_resampled,
            target_fps,
            out_w,
            out_h,
        )
    };
    let (r0, r1, r2, r3) = tokio::join!(
        make(first, 0),
        async {
            match segments.get(1) {
                Some(segment) => make(*segment, 1).await,
                None => Ok(Vec::new()),
            }
        },
        async {
            match segments.get(2) {
                Some(segment) => make(*segment, 2).await,
                None => Ok(Vec::new()),
            }
        },
        async {
            match segments.get(3) {
                Some(segment) => make(*segment, 3).await,
                None => Ok(Vec::new()),
            }
        }
    );
    let mut output = Vec::with_capacity(segments.len());
    output.push(r0?);
    if segments.len() > 1 {
        output.push(r1?);
    }
    if segments.len() > 2 {
        output.push(r2?);
    }
    if segments.len() > 3 {
        output.push(r3?);
    }
    for (index, frames) in output.iter().enumerate() {
        if frames.is_empty() {
            return Err(format!(
                "第 {} 段采样帧为空（seek 时间 {:.3}s）",
                index + 1,
                seek_of(segments[index])
            ));
        }
    }
    Ok(output)
}

/// 双输出分段抽帧：一次解码同时输出低/高两个代理分辨率，避免重复解码。
async fn extract_segment_dual(
    source: String,
    low_dir: PathBuf,
    high_dir: PathBuf,
    segment: Segment,
    seek_seconds: f64,
    fps_resampled: bool,
    target_fps: f64,
    low_dims: (u32, u32),
    high_dims: (u32, u32),
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    std::fs::create_dir_all(&low_dir).map_err(|error| format!("创建临时目录失败：{error}"))?;
    std::fs::create_dir_all(&high_dir).map_err(|error| format!("创建临时目录失败：{error}"))?;
    let (low_w, low_h) = low_dims;
    let (high_w, high_h) = high_dims;
    let mut chain = String::new();
    if fps_resampled {
        chain.push_str(&format!("fps={target_fps:.3},"));
    }
    chain.push_str(&format!("select=lt(n\\,{})", segment.len));
    let filter = format!(
        "[0:v]{chain},split=2[low][high];[low]scale={low_w}:{low_h}:flags=lanczos[lo];[high]scale={high_w}:{high_h}:flags=lanczos[hi]"
    );
    let seek = if seek_seconds.is_finite() {
        (seek_seconds - SEEK_EPSILON_SEC).max(0.0)
    } else {
        0.0
    };
    let low_pattern = low_dir.join("%06d.png").to_string_lossy().to_string();
    let high_pattern = high_dir.join("%06d.png").to_string_lossy().to_string();
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-y".into(),
        "-nostats".into(),
        "-ss".into(),
        format!("{seek:.6}"),
        "-i".into(),
        source,
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "[lo]".into(),
        "-frames:v".into(),
        segment.len.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        low_pattern,
        "-map".into(),
        "[hi]".into(),
        "-frames:v".into(),
        segment.len.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        high_pattern,
    ];
    let result = tools::run_tool(None, "ffmpeg", &args, None, |_| {}).await?;
    if result.code != 0 {
        return Err(format!("ffmpeg 双代理分段抽帧失败：{}", tail(&result)));
    }
    let read_frames = |dir: &std::path::Path| -> Vec<PathBuf> {
        let mut frames: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| {
                        path.extension()
                            .and_then(|value| value.to_str())
                            .map(|ext| ext.eq_ignore_ascii_case("png"))
                            .unwrap_or(false)
                    })
                    .collect()
            })
            .unwrap_or_default();
        frames.sort();
        frames
    };
    Ok((read_frames(&low_dir), read_frames(&high_dir)))
}

/// 并发抽取一个代理样本的全部连续段，每段同时输出低/高两个代理分辨率。
async fn extract_segments_dual(
    source: &str,
    root: &std::path::Path,
    segments: &[Segment],
    seeker: &Seeker,
    fps_resampled: bool,
    target_fps: f64,
    low_dims: (u32, u32),
    high_dims: (u32, u32),
) -> Result<Vec<(Vec<PathBuf>, Vec<PathBuf>)>, String> {
    let first = segments.first().copied().ok_or("采样计划为空")?;
    let seek_of = |segment: Segment| seeker.time_of(segment.start);
    let make = |segment: Segment, index: usize| {
        extract_segment_dual(
            source.to_string(),
            root.join(format!("seg{index}-low")),
            root.join(format!("seg{index}-high")),
            segment,
            seek_of(segment),
            fps_resampled,
            target_fps,
            low_dims,
            high_dims,
        )
    };
    let (r0, r1, r2, r3) = tokio::join!(
        make(first, 0),
        async {
            match segments.get(1) {
                Some(segment) => make(*segment, 1).await,
                None => Ok((Vec::new(), Vec::new())),
            }
        },
        async {
            match segments.get(2) {
                Some(segment) => make(*segment, 2).await,
                None => Ok((Vec::new(), Vec::new())),
            }
        },
        async {
            match segments.get(3) {
                Some(segment) => make(*segment, 3).await,
                None => Ok((Vec::new(), Vec::new())),
            }
        }
    );
    let mut output = Vec::with_capacity(segments.len());
    output.push(r0?);
    if segments.len() > 1 {
        output.push(r1?);
    }
    if segments.len() > 2 {
        output.push(r2?);
    }
    if segments.len() > 3 {
        output.push(r3?);
    }
    for (index, (low, high)) in output.iter().enumerate() {
        if low.is_empty() || high.is_empty() {
            return Err(format!(
                "第 {} 段双代理采样帧为空（seek 时间 {:.3}s）",
                index + 1,
                seek_of(segments[index])
            ));
        }
    }
    Ok(output)
}

/// 把各段帧按顺序拼接、编码为样本 GIF，并解析逐帧压缩字节。
async fn encode_segments(
    work_dir: &std::path::Path,
    segment_frames: &[Vec<PathBuf>],
    out_w: Option<u32>,
    target_fps: f64,
    quality: i64,
) -> Result<(u64, Vec<u32>, u32), String> {
    std::fs::create_dir_all(work_dir).map_err(|error| format!("创建临时目录失败：{error}"))?;
    let mut frames: Vec<&PathBuf> = Vec::new();
    for segment in segment_frames {
        for frame in segment {
            frames.push(frame);
        }
    }
    if frames.is_empty() {
        return Err("没有抽取到采样帧（源文件可能没有视频轨）".into());
    }
    let sample_gif = work_dir.join("sample.gif");
    let mut args: Vec<String> = vec![
        "-o".into(),
        sample_gif.to_string_lossy().to_string(),
        "--fps".into(),
        format!("{target_fps:.3}"),
        "--quality".into(),
        quality.to_string(),
        "--repeat".into(),
        "0".into(),
        "--no-sort".into(),
    ];
    if let Some(width) = out_w {
        args.push("--width".into());
        args.push(width.to_string());
    }
    for frame in &frames {
        args.push(frame.to_string_lossy().to_string());
    }
    let result = tools::run_tool(None, "gifski", &args, None, |_| {}).await?;
    if result.code != 0 {
        return Err(format!("gifski 编码采样帧失败：{}", tail(&result)));
    }
    let bytes = paths::file_size(&sample_gif);
    if bytes == 0 {
        return Err("gifski 没有生成采样 GIF".into());
    }
    let parsed = probe_gif::frame_data_sizes(&sample_gif.to_string_lossy()).unwrap_or_default();
    Ok((bytes, parsed, frames.len() as u32))
}

fn mean_estimate(first: u64, sizes: &[u32], total_frames: u32) -> Option<u64> {
    if sizes.is_empty() {
        return None;
    }
    let average = sizes.iter().map(|value| *value as f64).sum::<f64>() / sizes.len() as f64;
    let estimate = first as f64 + average * (total_frames as f64 - 1.0);
    if estimate.is_finite() && estimate > 0.0 {
        Some(estimate.round() as u64)
    } else {
        None
    }
}

/// 采样序列中的稳态帧位置：runs 剔除每段起始帧；mid 剔除首帧 + 中段前 2 帧暖机。
fn steady_positions(kind: SampleKind, segment_lengths: &[usize]) -> Vec<usize> {
    let mut steady: Vec<usize> = Vec::new();
    if kind == SampleKind::Runs {
        let mut position = 0usize;
        for length in segment_lengths {
            for offset in 0..*length {
                if offset > 0 {
                    steady.push(position + offset);
                }
            }
            position += *length;
        }
    } else if segment_lengths.len() >= 2 {
        let base = segment_lengths[0];
        for offset in MID_WARMUP..segment_lengths[1] {
            steady.push(base + offset);
        }
    }
    steady
}

fn model_estimate(
    kind: SampleKind,
    segment_lengths: &[usize],
    parsed: &[u32],
    total_frames: u32,
) -> Option<u64> {
    let steady = steady_positions(kind, segment_lengths);
    let sizes: Vec<u32> = steady
        .iter()
        .filter_map(|position| parsed.get(*position).copied())
        .collect();
    mean_estimate(parsed.first().copied()? as u64, &sizes, total_frames)
}

#[derive(Clone, Debug)]
struct EncodedSample {
    bytes: u64,
    parsed: Vec<u32>,
    frame_count: u32,
}

struct SampleOutcome {
    estimate: Option<u64>,
    sample_bytes: u64,
    sample_frames: u32,
    parsed: Vec<u32>,
    matched: bool,
}

/// 跑一个样本：并发分段 seek 抽帧 → 编码 → 解析 → 按段边界/暖机规则外推。
async fn run_sample(
    source: &str,
    root: &std::path::Path,
    plan: &SamplePlan,
    seeker: &Seeker,
    fps_resampled: bool,
    target_fps: f64,
    out_w: Option<u32>,
    out_h: Option<u32>,
    quality: i64,
    total_frames: u32,
) -> Result<SampleOutcome, String> {
    std::fs::create_dir_all(root).map_err(|error| format!("创建临时目录失败：{error}"))?;
    let segment_frames = extract_segments(
        source,
        &root.join("frames"),
        &plan.segments,
        seeker,
        fps_resampled,
        target_fps,
        out_w,
        out_h,
    )
    .await?;
    let (sample_bytes, parsed, sample_frames) =
        encode_segments(&root.join("encode"), &segment_frames, out_w, target_fps, quality).await?;
    let matched = parsed.len() == sample_frames as usize;
    let lengths: Vec<usize> = segment_frames.iter().map(|frames| frames.len()).collect();
    let estimate = if matched {
        model_estimate(plan.kind, &lengths, &parsed, total_frames)
    } else {
        None
    };

    Ok(SampleOutcome {
        estimate,
        sample_bytes,
        sample_frames,
        parsed,
        matched,
    })
}

// ---------------------------------------------------------------------------
// 代理分辨率双尺度拟合
// ---------------------------------------------------------------------------

struct ProxyOutcome {
    estimated: u64,
    alpha: f64,
    high_estimate: u64,
    low_estimate: u64,
    runs: SampleOutcome,
    mid: Option<SampleOutcome>,
}

fn proxy_pair(target_w: u32) -> Option<(u32, u32)> {
    if target_w > PROXY_WIDE_HIGH {
        Some((PROXY_WIDE_LOW, PROXY_WIDE_HIGH))
    } else if target_w > PROXY_NARROW_HIGH {
        Some((PROXY_NARROW_LOW, PROXY_NARROW_HIGH))
    } else {
        None
    }
}

fn proxy_dims(target_w: u32, target_h: u32, width: u32) -> (u32, u32) {
    let height = even(width as f64 * target_h as f64 / target_w.max(1) as f64);
    (width, height.max(2))
}

fn hybrid_from(runs: &SampleOutcome, mid: Option<&SampleOutcome>) -> Option<u64> {
    match (runs.estimate, mid.and_then(|value| value.estimate)) {
        (Some(run), Some(mid)) => Some(((run as f64 + mid as f64) / 2.0).round().max(1.0) as u64),
        (Some(run), None) => Some(run),
        (None, Some(mid)) => Some(mid),
        (None, None) => None,
    }
}

/// 在低/高两个代理宽度编码同样的采样帧，按 size = k · pixels^α 拟合后外推到目标尺寸。
/// 目标宽度 > 1120px 时用 800/1120 代理对（外推距离近、实测 4K 误差 <3%），900–1120px 用 560/800。
/// 返回 Ok(None) 表示拟合异常，调用方回退全分辨率流程。
async fn proxy_estimate(
    source: &str,
    temp_root: &std::path::Path,
    seeker: &Seeker,
    fps_resampled: bool,
    target_fps: f64,
    target_w: u32,
    target_h: u32,
    quality: i64,
    total_frames: u32,
    budget: usize,
    proxy_low_w: u32,
    proxy_high_w: u32,
) -> Result<Option<ProxyOutcome>, String> {
    if target_w <= proxy_high_w {
        return Ok(None);
    }
    let (low_w, low_h) = proxy_dims(target_w, target_h, proxy_low_w);
    let (high_w, high_h) = proxy_dims(target_w, target_h, proxy_high_w);
    if high_w < 2 || low_w < 2 || low_h < 2 || high_h < 2 {
        return Ok(None);
    }
    // 代理模式用 2 段更长的连续段，减少 seek 解码窗口（精度已实测验证）。
    let runs_plan = build_proxy_runs_plan(total_frames, budget);
    let mid_plan = build_mid_plan_with(total_frames, budget, PROXY_MID_MAX_SEGMENT);
    let runs_root = temp_root.join("proxy-runs");
    let mid_root = temp_root.join("proxy-mid");
    let runs_future = extract_segments_dual(
        source,
        &runs_root,
        &runs_plan.segments,
        seeker,
        fps_resampled,
        target_fps,
        (low_w, low_h),
        (high_w, high_h),
    );
    let mid_future = async {
        extract_segments_dual(
            source,
            &mid_root,
            &mid_plan.segments,
            seeker,
            fps_resampled,
            target_fps,
            (low_w, low_h),
            (high_w, high_h),
        )
        .await
    };
    let (runs_dual, mid_dual) = tokio::join!(runs_future, mid_future);
    let runs_dual = runs_dual?;
    let mid_dual = match mid_dual {
        Ok(value) if value.len() >= 2 => value,
        _ => return Ok(None),
    };

    let runs_low_frames: Vec<Vec<PathBuf>> = runs_dual.iter().map(|(low, _)| low.clone()).collect();
    let runs_high_frames: Vec<Vec<PathBuf>> = runs_dual.iter().map(|(_, high)| high.clone()).collect();
    let mid_low_frames: Vec<Vec<PathBuf>> = mid_dual.iter().map(|(low, _)| low.clone()).collect();
    let mid_high_frames: Vec<Vec<PathBuf>> = mid_dual.iter().map(|(_, high)| high.clone()).collect();

    let runs_low_dir = temp_root.join("proxy-runs-low");
    let runs_high_dir = temp_root.join("proxy-runs-high");
    let mid_low_dir = temp_root.join("proxy-mid-low");
    let mid_high_dir = temp_root.join("proxy-mid-high");
    let (runs_low, runs_high, mid_low, mid_high) = tokio::join!(
        encode_segments(&runs_low_dir, &runs_low_frames, Some(low_w), target_fps, quality),
        encode_segments(&runs_high_dir, &runs_high_frames, Some(high_w), target_fps, quality),
        encode_segments(&mid_low_dir, &mid_low_frames, Some(low_w), target_fps, quality),
        encode_segments(&mid_high_dir, &mid_high_frames, Some(high_w), target_fps, quality),
    );
    let (runs_low_bytes, runs_low_parsed, runs_low_count) = runs_low?;
    let (runs_high_bytes, runs_high_parsed, runs_high_count) = runs_high?;
    let (mid_low_bytes, mid_low_parsed, mid_low_count) = mid_low?;
    let (mid_high_bytes, mid_high_parsed, mid_high_count) = mid_high?;

    let runs_lengths: Vec<usize> = runs_high_frames.iter().map(|frames| frames.len()).collect();
    let mid_lengths: Vec<usize> = mid_high_frames.iter().map(|frames| frames.len()).collect();

    let build_sample = |bytes: u64,
                        parsed: Vec<u32>,
                        frame_count: u32,
                        lengths: &[usize],
                        kind: SampleKind|
     -> SampleOutcome {
        let matched = parsed.len() == frame_count as usize;
        let estimate = if matched {
            model_estimate(kind, lengths, &parsed, total_frames)
        } else {
            None
        };
        SampleOutcome {
            estimate,
            sample_bytes: bytes,
            sample_frames: frame_count,
            parsed,
            matched,
        }
    };

    let runs_high_sample = build_sample(
        runs_high_bytes,
        runs_high_parsed,
        runs_high_count,
        &runs_lengths,
        SampleKind::Runs,
    );
    let runs_low_sample = build_sample(
        runs_low_bytes,
        runs_low_parsed,
        runs_low_count,
        &runs_lengths,
        SampleKind::Runs,
    );
    let mid_high_sample = build_sample(
        mid_high_bytes,
        mid_high_parsed,
        mid_high_count,
        &mid_lengths,
        SampleKind::Mid,
    );
    let mid_low_sample = build_sample(
        mid_low_bytes,
        mid_low_parsed,
        mid_low_count,
        &mid_lengths,
        SampleKind::Mid,
    );

    let high_estimate = match hybrid_from(&runs_high_sample, Some(&mid_high_sample)) {
        Some(value) => value,
        None => return Ok(None),
    };
    let low_estimate = match hybrid_from(&runs_low_sample, Some(&mid_low_sample)) {
        Some(value) => value,
        None => return Ok(None),
    };

    let px_low = low_w as f64 * low_h as f64;
    let px_high = high_w as f64 * high_h as f64;
    let px_target = target_w as f64 * target_h as f64;
    if !(px_high > px_low) || !(px_target > px_high) || low_estimate == 0 {
        return Ok(None);
    }
    // 外推距离保护：目标像素 / 高代理像素过大时幂律外推不可靠，回退全分辨率。
    if px_target / px_high > 64.0 {
        return Ok(None);
    }
    let size_ratio = high_estimate as f64 / low_estimate as f64;
    let pixel_ratio = px_high / px_low;
    if !size_ratio.is_finite() || size_ratio <= 1.0 {
        // 体积没有随像素增加而增加，说明采样/编码异常，回退全分辨率。
        return Ok(None);
    }
    let alpha = size_ratio.ln() / pixel_ratio.ln();
    if !alpha.is_finite() || alpha < PROXY_ALPHA_MIN || alpha > PROXY_ALPHA_MAX {
        return Ok(None);
    }
    let estimated = high_estimate as f64 * (px_target / px_high).powf(alpha);
    if !estimated.is_finite() || estimated < high_estimate as f64 || estimated > 1.0e13 {
        return Ok(None);
    }

    Ok(Some(ProxyOutcome {
        estimated: estimated.round() as u64,
        alpha,
        high_estimate,
        low_estimate,
        runs: runs_high_sample,
        mid: Some(mid_high_sample),
    }))
}

fn build_result(
    estimated: u64,
    runs: &SampleOutcome,
    mid: Option<&SampleOutcome>,
    total_frames: u32,
    runs_plan: &SamplePlan,
    width: u32,
    height: u32,
    fps: f64,
    quality: i64,
    elapsed_ms: u64,
    model: &str,
    encoder: String,
    frame_source: &str,
    fps_resampled: bool,
    flags_extra: (bool, Option<f64>),
    mode: &str,
) -> EstimateResult {
    let run_estimate = runs.estimate;
    let mid_estimate = mid.and_then(|value| value.estimate);
    EstimateResult {
        estimated_bytes: estimated,
        sample_bytes: runs.sample_bytes,
        sample_frames: runs.sample_frames,
        parsed_frames: runs.parsed.len() as u32,
        total_frames,
        runs: runs_plan.segments.len() as u32,
        run_length: runs_plan.run_length,
        run_estimate_bytes: run_estimate,
        mid_sample_bytes: mid.map(|value| value.sample_bytes),
        mid_sample_frames: mid.map(|value| value.sample_frames),
        mid_estimate_bytes: mid_estimate,
        width,
        height,
        fps,
        quality,
        elapsed_ms,
        flags: EstimateFlags {
            model: model.into(),
            encoder,
            sampled: true,
            frame_source: frame_source.into(),
            fps_resampled,
            frame_count_matched: runs.matched,
            cached: false,
            seeked: true,
            proxy: flags_extra.0,
            proxy_alpha: flags_extra.1,
            mode: mode.to_string(),
        },
    }
}

/// 采样编码估算 GIF 体积。任何一步失败都返回可展示的中文错误，前端回退经验公式。
pub async fn estimate(request: EstimateRequest) -> Result<EstimateResult, String> {
    let started = std::time::Instant::now();
    let source = PathBuf::from(&request.file_path);
    if request.file_path.trim().is_empty() || !source.is_file() {
        return Err(format!("源文件不存在，无法预估体积：{}", request.file_path));
    }
    let encoder = request
        .encoder
        .as_deref()
        .unwrap_or("gifski")
        .trim()
        .to_lowercase();
    if encoder != "gifski" {
        return Err("体积预估目前仅支持 gifski 编码，请切换编码器后用经验公式估算".into());
    }
    let quality = request.quality.unwrap_or(92).clamp(1, 100);
    let mode = effective_estimate_mode(request.mode.as_deref());
    if mode == "fast" || mode == "off" {
        return Err(if mode == "fast" {
            "当前体积预估模式为「快速」，不调用采样编码（使用经验公式估算）".into()
        } else {
            "体积预估已关闭（可在设置中切换预估模式）".to_string()
        });
    }

    // 进程内缓存：源文件大小/mtime + 全部参数 + 预估模式构成 key，文件变更自动失效。
    let metadata = std::fs::metadata(&source).map_err(|error| format!("读取源文件信息失败：{error}"))?;
    let key = cache_key(&request, &metadata, quality, &encoder, &mode);
    if let Some(mut cached) = cache_lookup(&key) {
        cached.flags.cached = true;
        cached.flags.seeked = true;
        cached.elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(cached);
    }

    let meta = source_meta(&request.file_path);
    let target_fps = request
        .fps
        .filter(|value| value.is_finite() && *value > 0.5 && *value < 240.0)
        .or(meta.fps)
        .unwrap_or(10.0);

    let duration = request
        .duration_sec
        .filter(|value| value.is_finite() && *value > 0.0)
        .or(meta.duration_sec);
    let requested_frames = request.frame_count.filter(|value| *value > 0);
    let probed_frames = meta.frame_count.filter(|value| *value > 0);
    let source_frames = requested_frames.or(probed_frames);
    let source_fps = match (source_frames, duration) {
        (Some(frames), Some(seconds)) if seconds > 0.0 => Some(frames as f64 / seconds),
        _ => meta.fps,
    };
    let fps_resampled = match source_fps {
        Some(value) if value > 0.5 => target_fps < value * 0.995,
        _ => true,
    };
    let frame_source = if requested_frames.is_some() {
        "frameCount"
    } else if duration.is_some() {
        "durationTimesFps"
    } else {
        "probe"
    };
    let total_frames = if fps_resampled {
        duration
            .map(|seconds| (seconds * target_fps).round())
            .filter(|value| *value >= 1.0)
            .map(|value| value as u32)
            .or_else(|| {
                source_frames.map(|frames| {
                    let ratio = source_fps
                        .filter(|value| *value > 0.5)
                        .map(|value| target_fps / value)
                        .unwrap_or(1.0);
                    (frames as f64 * ratio).round().max(1.0) as u32
                })
            })
            .ok_or_else(|| "无法确定源总帧数，暂时无法预估体积".to_string())?
    } else {
        source_frames
            .or_else(|| duration.map(|seconds| (seconds * target_fps).round().max(1.0) as u32))
            .ok_or_else(|| "无法确定源总帧数，暂时无法预估体积".to_string())?
    };
    if total_frames == 0 {
        return Err("源总帧数为 0，暂时无法预估体积".into());
    }

    // 目标尺寸：优先用前端算好的输出尺寸；缺失时退回源尺寸（不缩放）。
    let mut out_w = request.width.filter(|value| *value >= 2);
    let mut out_h = request.height.filter(|value| *value >= 2);
    if out_w.is_none() {
        out_w = meta.width.filter(|value| *value >= 2);
        out_h = out_h.or(meta.height.filter(|value| *value >= 2));
    } else if out_h.is_none() {
        if let (Some(source_width), Some(source_height)) = (meta.width, meta.height) {
            if source_width > 0 {
                out_h = Some(even(
                    out_w.unwrap() as f64 * source_height as f64 / source_width as f64,
                ));
            }
        }
    }

    let uniform_seconds = source_fps
        .filter(|value| value.is_finite() && *value > 0.5)
        .map(|value| 1.0 / value)
        .or_else(|| duration.map(|seconds| seconds / total_frames as f64))
        .unwrap_or(1.0 / 10.0);
    let seeker = Seeker {
        frame_times: meta.frame_times.clone(),
        uniform_seconds,
        fps_resampled,
        target_fps,
    };

    let temp_root = std::env::temp_dir().join(format!(
        "xgif-estimate-{}-{}",
        std::process::id(),
        paths::now_ms()
    ));
    std::fs::create_dir_all(&temp_root).map_err(|error| format!("创建临时目录失败：{error}"))?;
    let _guard = TempDir(temp_root.clone());

    let budget = sample_budget(total_frames);

    // 总帧数很少时直接编码全部帧：样本就是最终 GIF，结果精确（无需 seek 技巧）。
    if total_frames as usize <= MAX_SAMPLES {
        let all_frames = extract_segment(
            request.file_path.clone(),
            temp_root.join("all"),
            Segment {
                start: 0,
                len: total_frames,
            },
            0.0,
            fps_resampled,
            target_fps,
            out_w,
            out_h,
        )
        .await?;
        let (sample_bytes, parsed, sample_frames) =
            encode_segments(&temp_root.join("all-encode"), &[all_frames], out_w, target_fps, quality)
                .await?;
        let result = EstimateResult {
            estimated_bytes: sample_bytes,
            sample_bytes,
            sample_frames,
            parsed_frames: parsed.len() as u32,
            total_frames,
            runs: 1,
            run_length: total_frames,
            run_estimate_bytes: None,
            mid_sample_bytes: None,
            mid_sample_frames: None,
            mid_estimate_bytes: None,
            width: out_w.unwrap_or(0),
            height: out_h.unwrap_or(0),
            fps: target_fps,
            quality,
            elapsed_ms: started.elapsed().as_millis() as u64,
            flags: EstimateFlags {
                model: "exact".into(),
                encoder,
                sampled: false,
                frame_source: frame_source.into(),
                fps_resampled,
                frame_count_matched: true,
                cached: false,
                seeked: true,
                proxy: false,
                proxy_alpha: None,
                mode: mode.clone(),
            },
        };
        cache_store(key, &result);
        return Ok(result);
    }

    let runs_plan = build_runs_plan(total_frames, budget);
    let mid_plan = build_mid_plan(total_frames, budget);

    // 高分辨率（目标宽度 > 900px 且目标像素 ≥ 2× 高代理像素）：优先走代理分辨率双尺度拟合；
    // 异常/失败或代理不划算（如 720p 目标）时回退全分辨率。
    if let (Some(target_w), Some(target_h)) = (out_w, out_h) {
        let pair = proxy_pair(target_w);
        let proxy_worthwhile = pair
            .map(|(_, high_w)| {
                let (high_px_w, high_px_h) = proxy_dims(target_w, target_h, high_w);
                (target_w as f64 * target_h as f64)
                    > (high_px_w as f64 * high_px_h as f64) * PROXY_MIN_PIXEL_RATIO
            })
            .unwrap_or(false);
        if mode != "precise" && target_w > PROXY_TRIGGER_WIDTH && target_h >= 2 && pair.is_some() && proxy_worthwhile {
            let pair = pair.expect("pair checked above");
            match proxy_estimate(
                &request.file_path,
                &temp_root,
                &seeker,
                fps_resampled,
                target_fps,
                target_w,
                target_h,
                quality,
                total_frames,
                budget,
                pair.0,
                pair.1,
            )
            .await
            {
                Ok(Some(proxy)) => {
                    let result = build_result(
                        proxy.estimated,
                        &proxy.runs,
                        proxy.mid.as_ref(),
                        total_frames,
                        &runs_plan,
                        target_w,
                        target_h,
                        target_fps,
                        quality,
                        started.elapsed().as_millis() as u64,
                        "proxy",
                        encoder,
                        frame_source,
                        fps_resampled,
                        (true, Some(proxy.alpha)),
                        &mode,
                    );
                    cache_store(key, &result);
                    return Ok(result);
                }
                Ok(None) => {
                    // 拟合异常：继续走全分辨率流程（临时目录按子目录区分，互不冲突）。
                }
                Err(_) => {
                    // 代理编码失败：回退全分辨率。
                }
            }
        }
    }

    let run_mid = mid_plan.segments.len() >= 2;
    let runs_root = temp_root.join("runs");
    let mid_root = temp_root.join("mid");
    let runs_future = run_sample(
        &request.file_path,
        &runs_root,
        &runs_plan,
        &seeker,
        fps_resampled,
        target_fps,
        out_w,
        out_h,
        quality,
        total_frames,
    );
    let mid_future = async {
        if !run_mid {
            return Err("中段样本不可用".to_string());
        }
        run_sample(
            &request.file_path,
            &mid_root,
            &mid_plan,
            &seeker,
            fps_resampled,
            target_fps,
            out_w,
            out_h,
            quality,
            total_frames,
        )
        .await
    };
    let (runs_result, mid_result) = tokio::join!(runs_future, mid_future);

    let runs = match runs_result {
        Ok(outcome) => outcome,
        Err(error) => {
            // 均匀段样本失败时，若中段样本可用则降级返回 mid 模型结果。
            if let Ok(mid) = mid_result {
                if let Some(estimate) = mid.estimate {
                    let result = build_result(
                        estimate,
                        &SampleOutcome {
                            estimate: None,
                            sample_bytes: 0,
                            sample_frames: 0,
                            parsed: Vec::new(),
                            matched: mid.matched,
                        },
                        Some(&mid),
                        total_frames,
                        &runs_plan,
                        out_w.unwrap_or(0),
                        out_h.unwrap_or(0),
                        target_fps,
                        quality,
                        started.elapsed().as_millis() as u64,
                        "mid",
                        encoder,
                        frame_source,
                        fps_resampled,
                        (false, None),
                        &mode,
                    );
                    cache_store(key, &result);
                    return Ok(result);
                }
            }
            return Err(error);
        }
    };
    let mid = mid_result.ok();

    let (model, estimated) = match (runs.estimate, mid.as_ref().and_then(|value| value.estimate)) {
        (Some(run), Some(mid_value)) => (
            "hybrid",
            ((run as f64 + mid_value as f64) / 2.0).round().max(1.0) as u64,
        ),
        (Some(run), None) => ("runs", run),
        (None, Some(mid_value)) => ("mid", mid_value),
        (None, None) => (
            "naive",
            (runs.sample_bytes as f64 * total_frames as f64 / runs.sample_frames.max(1) as f64)
                .round()
                .max(1.0) as u64,
        ),
    };

    let result = build_result(
        estimated,
        &runs,
        mid.as_ref(),
        total_frames,
        &runs_plan,
        out_w.unwrap_or(0),
        out_h.unwrap_or(0),
        target_fps,
        quality,
        started.elapsed().as_millis() as u64,
        model,
        encoder,
        frame_source,
        fps_resampled,
        (false, None),
        &mode,
    );
    cache_store(key, &result);
    Ok(result)
}
