//! MP4 探测（移植 Electron 版 `electron/lib/mp4probe.cjs` 的纯 JS 解析部分）。
//!
//! 只解析 moov/trak/mdia/mdhd/hdlr/minf/stbl/stts/stsz/stsd/tkhd/mvhd，
//! 返回宽高、时长、帧数、平均帧率、逐帧时长（stts decode delta）与是否有音轨。
//! 不依赖 ffprobe，解析失败由调用方回退到 ffmpeg 文本探测。

use std::path::Path;

/// 视频帧数上限，防止损坏文件导致内存爆炸。
const MAX_FRAMES: usize = 200_000;
const MAX_STTS_ENTRIES: u32 = 100_000;

/// MP4 探测结果（字段与 Electron 版 MediaProbe 对齐）。
#[derive(Debug, Clone)]
pub struct MediaProbe {
    pub path: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub duration_sec: f64,
    pub frame_count: usize,
    pub fps: f64,
    pub frame_durations_ms: Vec<f64>,
    pub has_audio: bool,
    pub timescale: Option<u32>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ProbeError {
    pub message: String,
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProbeError {}

fn probe_error(message: impl Into<String>) -> ProbeError {
    ProbeError {
        message: message.into(),
    }
}

#[derive(Debug, Clone, Copy)]
struct BoxInfo {
    kind: [u8; 4],
    payload_start: usize,
    end: usize,
}

impl BoxInfo {
    fn is(&self, kind: &[u8; 4]) -> bool {
        &self.kind == kind
    }
}

#[derive(Debug, Default)]
struct TrakInfo {
    handler: Option<[u8; 4]>,
    timing: Option<(u32, u64)>,
    tkhd_size: Option<(f64, f64)>,
    stsd_size: Option<(u16, u16)>,
    durations: Option<Vec<f64>>,
    sample_count: Option<u32>,
}

/// 探测 MP4 文件。
pub fn probe_file(path: &Path) -> Result<MediaProbe, ProbeError> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| probe_error(format!("媒体文件不存在或无法读取：{}", path.display())))?;
    if !metadata.is_file() || metadata.len() < 16 {
        return Err(probe_error("媒体文件为空或已损坏"));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| probe_error(format!("媒体文件读取失败：{}", error)))?;
    let mut probe = probe_bytes(&bytes)?;
    probe.path = path.to_string_lossy().into_owned();
    probe.size_bytes = metadata.len();
    Ok(probe)
}

/// 从内存字节解析 MP4。
pub fn probe_bytes(bytes: &[u8]) -> Result<MediaProbe, ProbeError> {
    if bytes.len() < 16 {
        return Err(probe_error("媒体文件不完整，无法解析 MP4 结构"));
    }
    let moov = find_top_level(bytes, b"moov")
        .ok_or_else(|| probe_error("媒体文件不是标准的 MP4（缺少 moov 盒子）"))?;
    let movie_timing = find_child(bytes, moov, b"mvhd").and_then(|mvhd| read_timescale_duration(bytes, mvhd));
    let traks: Vec<TrakInfo> = find_children(bytes, moov, b"trak")
        .iter()
        .filter_map(|trak| parse_trak(bytes, *trak))
        .collect();
    let video_trak = traks
        .iter()
        .find(|trak| {
            trak.handler == Some(*b"vide") && (trak.durations.is_some() || trak.stsd_size.is_some())
        })
        .ok_or_else(|| probe_error("媒体文件里没有视频轨"))?;
    let has_audio = traks.iter().any(|trak| trak.handler == Some(*b"soun"));

    let mut warnings = Vec::new();
    let mut frame_durations_ms = video_trak
        .durations
        .as_ref()
        .filter(|durations| !durations.is_empty())
        .cloned();
    let stts_count = frame_durations_ms.as_ref().map_or(0, Vec::len);
    let sample_count = video_trak.sample_count.unwrap_or(0) as usize;
    let mut frame_count = stts_count;
    if stts_count > 0 && sample_count > 0 && sample_count != stts_count {
        warnings.push(format!(
            "MP4 的 stts 帧时长条目数（{}）与 stsz 采样数（{}）不一致，已按 stts 时间轴为准",
            stts_count, sample_count
        ));
    }
    if frame_count == 0 && sample_count > 0 {
        frame_count = sample_count;
    }

    let track_seconds = video_trak
        .timing
        .map(|(timescale, duration)| {
            if timescale > 0 {
                duration as f64 / timescale as f64
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);
    let movie_seconds = movie_timing
        .map(|(timescale, duration)| {
            if timescale > 0 {
                duration as f64 / timescale as f64
            } else {
                0.0
            }
        })
        .unwrap_or(0.0);
    let mut duration_sec = if track_seconds > 0.0 {
        track_seconds
    } else {
        movie_seconds
    };

    if let Some(durations) = frame_durations_ms.as_ref() {
        let sum_seconds: f64 = durations.iter().sum::<f64>() / 1000.0;
        if !(duration_sec > 0.0) {
            duration_sec = sum_seconds;
        }
    }
    if frame_count == 0 {
        return Err(probe_error("无法从 MP4 中读取视频帧数"));
    }
    if !(duration_sec > 0.0) {
        if let Some(durations) = frame_durations_ms.as_ref() {
            duration_sec = durations.iter().sum::<f64>() / 1000.0;
        }
    }
    if frame_durations_ms.is_none() {
        let uniform = if duration_sec > 0.0 {
            (duration_sec * 1000.0) / frame_count as f64
        } else {
            0.0
        };
        frame_durations_ms = Some(vec![round3(uniform); frame_count]);
    }
    let durations = frame_durations_ms.unwrap_or_default();
    for value in &durations {
        if !value.is_finite() || *value < 0.0 {
            return Err(probe_error("媒体文件逐帧时长异常"));
        }
    }

    let (width, height) = match &video_trak.stsd_size {
        Some((width, height)) if *width > 0 && *height > 0 => (*width as u32, *height as u32),
        _ => match video_trak.tkhd_size {
            Some((width, height)) => (width.round() as u32, height.round() as u32),
            None => (0, 0),
        },
    };
    if width == 0 || height == 0 {
        return Err(probe_error("无法从 MP4 中读取视频尺寸"));
    }

    let fps = if duration_sec > 0.0 {
        frame_count as f64 / duration_sec
    } else {
        0.0
    };
    Ok(MediaProbe {
        path: String::new(),
        size_bytes: 0,
        width,
        height,
        duration_sec: round3(duration_sec),
        frame_count,
        fps: round3(fps),
        frame_durations_ms: durations,
        has_audio,
        timescale: video_trak.timing.map(|(timescale, _)| timescale),
        warnings,
    })
}

fn parse_trak(bytes: &[u8], trak: BoxInfo) -> Option<TrakInfo> {
    let tkhd = find_child(bytes, trak, b"tkhd");
    let mdia = find_child(bytes, trak, b"mdia")?;
    let hdlr = find_child(bytes, mdia, b"hdlr");
    let mdhd = find_child(bytes, mdia, b"mdhd");
    let minf = find_child(bytes, mdia, b"minf");
    let stbl = minf.and_then(|minf| find_child(bytes, minf, b"stbl"));
    let handler = hdlr.and_then(|hdlr| read_handler_type(bytes, hdlr));
    let timing = mdhd.and_then(|mdhd| read_timescale_duration(bytes, mdhd));
    let stts = stbl.and_then(|stbl| find_child(bytes, stbl, b"stts"));
    let stsz = stbl.and_then(|stbl| find_child(bytes, stbl, b"stsz"));
    let stsd = stbl.and_then(|stbl| find_child(bytes, stbl, b"stsd"));
    let durations = match (&stts, timing) {
        (Some(stts), Some((timescale, _))) => read_stts_durations(bytes, *stts, timescale),
        _ => None,
    };
    Some(TrakInfo {
        handler,
        timing,
        tkhd_size: tkhd.and_then(|tkhd| read_tkhd_size(bytes, tkhd)),
        stsd_size: stsd.and_then(|stsd| read_stsd_size(bytes, stsd)),
        durations,
        sample_count: stsz.and_then(|stsz| read_stsz_count(bytes, stsz)),
    })
}

fn read_box(bytes: &[u8], offset: usize, end: usize) -> Option<BoxInfo> {
    if offset + 8 > end {
        return None;
    }
    let mut size = read_u32(bytes, offset)? as u64;
    let mut kind = [0_u8; 4];
    kind.copy_from_slice(bytes.get(offset + 4..offset + 8)?);
    let mut header_size = 8_usize;
    if size == 1 {
        if offset + 16 > end {
            return None;
        }
        size = read_u64(bytes, offset + 8)?;
        header_size = 16;
    } else if size == 0 {
        size = (end - offset) as u64;
    }
    let box_end = offset as u64 + size;
    if size < header_size as u64 || box_end > end as u64 {
        return None;
    }
    Some(BoxInfo {
        kind,
        payload_start: offset + header_size,
        end: box_end as usize,
    })
}

fn child_boxes(bytes: &[u8], start: usize, end: usize) -> Vec<BoxInfo> {
    let mut result = Vec::new();
    let mut offset = start;
    while offset + 8 <= end {
        let Some(info) = read_box(bytes, offset, end) else {
            break;
        };
        offset = info.end;
        result.push(info);
    }
    result
}

fn find_child(bytes: &[u8], parent: BoxInfo, kind: &[u8; 4]) -> Option<BoxInfo> {
    child_boxes(bytes, parent.payload_start, parent.end)
        .into_iter()
        .find(|child| child.is(kind))
}

fn find_children(bytes: &[u8], parent: BoxInfo, kind: &[u8; 4]) -> Vec<BoxInfo> {
    child_boxes(bytes, parent.payload_start, parent.end)
        .into_iter()
        .filter(|child| child.is(kind))
        .collect()
}

fn find_top_level(bytes: &[u8], kind: &[u8; 4]) -> Option<BoxInfo> {
    child_boxes(bytes, 0, bytes.len())
        .into_iter()
        .find(|child| child.is(kind))
}

fn read_timescale_duration(bytes: &[u8], info: BoxInfo) -> Option<(u32, u64)> {
    let version = *bytes.get(info.payload_start)?;
    let base = info.payload_start + 4;
    let offset = base + if version == 1 { 16 } else { 8 };
    if version == 1 {
        if offset + 12 > info.end {
            return None;
        }
        Some((read_u32(bytes, offset)?, read_u64(bytes, offset + 4)?))
    } else {
        if offset + 8 > info.end {
            return None;
        }
        Some((
            read_u32(bytes, offset)?,
            read_u32(bytes, offset + 4)? as u64,
        ))
    }
}

fn read_tkhd_size(bytes: &[u8], info: BoxInfo) -> Option<(f64, f64)> {
    let version = *bytes.get(info.payload_start)?;
    let offset = info.payload_start
        + 4
        + if version == 1 { 32 } else { 20 }
        + 8
        + 2
        + 2
        + 2
        + 2
        + 36;
    if offset + 8 > info.end {
        return None;
    }
    Some((
        read_u32(bytes, offset)? as f64 / 65536.0,
        read_u32(bytes, offset + 4)? as f64 / 65536.0,
    ))
}

fn read_handler_type(bytes: &[u8], info: BoxInfo) -> Option<[u8; 4]> {
    if info.payload_start + 12 > info.end {
        return None;
    }
    let mut handler = [0_u8; 4];
    handler.copy_from_slice(bytes.get(info.payload_start + 8..info.payload_start + 12)?);
    Some(handler)
}

fn read_stsd_size(bytes: &[u8], info: BoxInfo) -> Option<(u16, u16)> {
    let count = read_u32(bytes, info.payload_start + 4)?;
    if count < 1 {
        return None;
    }
    let entry_offset = info.payload_start + 8;
    if entry_offset + 36 > info.end {
        return None;
    }
    Some((
        read_u16(bytes, entry_offset + 32)?,
        read_u16(bytes, entry_offset + 34)?,
    ))
}

fn read_stts_durations(bytes: &[u8], info: BoxInfo, timescale: u32) -> Option<Vec<f64>> {
    if timescale == 0 {
        return None;
    }
    let count = read_u32(bytes, info.payload_start + 4)?;
    if count > MAX_STTS_ENTRIES {
        return None;
    }
    let mut durations = Vec::new();
    let mut offset = info.payload_start + 8;
    for _ in 0..count {
        if offset + 8 > info.end {
            return None;
        }
        let sample_count = read_u32(bytes, offset)? as usize;
        let delta = read_u32(bytes, offset + 4)?;
        offset += 8;
        if sample_count == 0 {
            continue;
        }
        if durations.len() + sample_count > MAX_FRAMES {
            return None;
        }
        let ms = round3(delta as f64 / timescale as f64 * 1000.0);
        for _ in 0..sample_count {
            durations.push(ms);
        }
    }
    Some(durations)
}

fn read_stsz_count(bytes: &[u8], info: BoxInfo) -> Option<u32> {
    if info.payload_start + 12 > info.end {
        return None;
    }
    read_u32(bytes, info.payload_start + 8)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    let slice = bytes.get(offset..offset + 8)?;
    let mut value = [0_u8; 8];
    value.copy_from_slice(slice);
    Some(u64::from_be_bytes(value))
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_box_supports_plain_and_largesize() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&24_u32.to_be_bytes());
        bytes.extend_from_slice(b"moov");
        bytes.extend_from_slice(&[0_u8; 16]);
        let info = read_box(&bytes, 0, bytes.len()).expect("box");
        assert!(info.is(b"moov"));
        assert_eq!(info.payload_start, 8);
        assert_eq!(info.end, 24);

        let mut large = Vec::new();
        large.extend_from_slice(&1_u32.to_be_bytes());
        large.extend_from_slice(b"mdat");
        large.extend_from_slice(&32_u64.to_be_bytes());
        large.extend_from_slice(&[0_u8; 16]);
        let info = read_box(&large, 0, large.len()).expect("largesize box");
        assert_eq!(info.payload_start, 16);
        assert_eq!(info.end, 32);
    }

    #[test]
    fn missing_moov_is_error() {
        let bytes = [0_u8; 32];
        assert!(probe_bytes(&bytes).is_err());
    }
}
