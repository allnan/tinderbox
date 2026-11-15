// 纯 Rust MP4 探测：解析 moov/trak/mdia/hdlr/mdhd/minf/stbl/stts/stsz/stsd/tkhd。
#![allow(dead_code)]

use std::path::Path;

use crate::model::MediaProbe;

const MAX_FRAMES: usize = 200_000;

#[derive(Clone, Debug)]
struct BoxInfo {
    kind: String,
    payload_start: usize,
    end: usize,
}

fn read_box(buffer: &[u8], offset: usize, end: usize) -> Option<BoxInfo> {
    if offset + 8 > end || end > buffer.len() {
        return None;
    }
    let mut size = buffer_read_u32(buffer, offset)? as usize;
    let kind = String::from_utf8_lossy(&buffer[offset + 4..offset + 8]).to_string();
    let mut header = 8usize;
    if size == 1 {
        let big = buffer_read_u64(buffer, offset + 8)?;
        size = big as usize;
        header = 16;
    } else if size == 0 {
        size = end - offset;
    }
    if size < header || offset + size > end {
        return None;
    }
    Some(BoxInfo {
        kind,
        payload_start: offset + header,
        end: offset + size,
    })
}

fn child_boxes(buffer: &[u8], start: usize, end: usize) -> Vec<BoxInfo> {
    let mut result = Vec::new();
    let mut offset = start;
    while offset + 8 <= end {
        match read_box(buffer, offset, end) {
            Some(info) => {
                offset = info.end;
                result.push(info);
            }
            None => break,
        }
    }
    result
}

fn find_child(buffer: &[u8], parent: &BoxInfo, kind: &str) -> Option<BoxInfo> {
    child_boxes(buffer, parent.payload_start, parent.end)
        .into_iter()
        .find(|item| item.kind == kind)
}

fn find_children(buffer: &[u8], parent: &BoxInfo, kind: &str) -> Vec<BoxInfo> {
    child_boxes(buffer, parent.payload_start, parent.end)
        .into_iter()
        .filter(|item| item.kind == kind)
        .collect()
}

fn find_top(buffer: &[u8], kind: &str) -> Option<BoxInfo> {
    child_boxes(buffer, 0, buffer.len())
        .into_iter()
        .find(|item| item.kind == kind)
}

fn buffer_read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 > buffer.len() {
        return None;
    }
    Some(u32::from_be_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]))
}

fn buffer_read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    if offset + 2 > buffer.len() {
        return None;
    }
    Some(u16::from_be_bytes([buffer[offset], buffer[offset + 1]]))
}

fn buffer_read_u64(buffer: &[u8], offset: usize) -> Option<u64> {
    if offset + 8 > buffer.len() {
        return None;
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&buffer[offset..offset + 8]);
    Some(u64::from_be_bytes(bytes))
}

fn read_timescale_duration(buffer: &[u8], info: &BoxInfo) -> Option<(u32, u64)> {
    let version = *buffer.get(info.payload_start)?;
    let base = info.payload_start + 4;
    let offset = base + if version == 1 { 16 } else { 8 };
    let timescale = buffer_read_u32(buffer, offset)?;
    let duration = if version == 1 {
        buffer_read_u64(buffer, offset + 4)?
    } else {
        buffer_read_u32(buffer, offset + 4)? as u64
    };
    Some((timescale, duration))
}

fn read_tkhd_size(buffer: &[u8], info: &BoxInfo) -> Option<(f64, f64)> {
    let version = *buffer.get(info.payload_start)?;
    let offset = info.payload_start + 4 + if version == 1 { 32 } else { 20 } + 8 + 2 + 2 + 2 + 2 + 36;
    let width = buffer_read_u32(buffer, offset)? as f64 / 65536.0;
    let height = buffer_read_u32(buffer, offset + 4)? as f64 / 65536.0;
    Some((width, height))
}

fn read_handler_type(buffer: &[u8], info: &BoxInfo) -> Option<String> {
    if info.payload_start + 12 > info.end {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer[info.payload_start + 8..info.payload_start + 12]).to_string())
}

fn read_stsd_size(buffer: &[u8], info: &BoxInfo) -> Option<(u32, u32)> {
    let count = buffer_read_u32(buffer, info.payload_start + 4)?;
    if count < 1 {
        return None;
    }
    let entry = info.payload_start + 8;
    let width = buffer_read_u16(buffer, entry + 32)? as u32;
    let height = buffer_read_u16(buffer, entry + 34)? as u32;
    Some((width, height))
}

fn read_stts_durations(buffer: &[u8], info: &BoxInfo, timescale: u32) -> Option<Vec<f64>> {
    if timescale == 0 {
        return None;
    }
    let count = buffer_read_u32(buffer, info.payload_start + 4)?;
    if count > 100_000 {
        return None;
    }
    let mut durations = Vec::new();
    let mut offset = info.payload_start + 8;
    for _ in 0..count {
        let sample_count = buffer_read_u32(buffer, offset)?;
        let delta = buffer_read_u32(buffer, offset + 4)?;
        offset += 8;
        if sample_count == 0 {
            continue;
        }
        if durations.len() + sample_count as usize > MAX_FRAMES {
            return None;
        }
        let ms = (delta as f64 / timescale as f64) * 1000.0;
        let ms = (ms * 1000.0).round() / 1000.0;
        for _ in 0..sample_count {
            durations.push(ms);
        }
    }
    Some(durations)
}

fn read_stsz_count(buffer: &[u8], info: &BoxInfo) -> Option<u32> {
    buffer_read_u32(buffer, info.payload_start + 8)
}

struct VideoTrak {
    handler: Option<String>,
    timing: Option<(u32, u64)>,
    tkhd: Option<(f64, f64)>,
    stsd: Option<(u32, u32)>,
    durations: Option<Vec<f64>>,
    sample_count: Option<u32>,
}

fn parse_video_trak(buffer: &[u8], trak: &BoxInfo) -> Option<VideoTrak> {
    let mdia = find_child(buffer, trak, "mdia")?;
    let hdlr = find_child(buffer, &mdia, "hdlr");
    let mdhd = find_child(buffer, &mdia, "mdhd");
    let minf = find_child(buffer, &mdia, "minf");
    let stbl = minf.as_ref().and_then(|minf| find_child(buffer, minf, "stbl"));
    let handler = hdlr.as_ref().and_then(|info| read_handler_type(buffer, info));
    let timing = mdhd.as_ref().and_then(|info| read_timescale_duration(buffer, info));
    let durations = stbl
        .as_ref()
        .and_then(|stbl| {
            let stts = find_child(buffer, stbl, "stts")?;
            let timescale = timing.as_ref()?.0;
            read_stts_durations(buffer, &stts, timescale)
        });
    Some(VideoTrak {
        handler,
        timing,
        tkhd: find_child(buffer, trak, "tkhd").and_then(|info| read_tkhd_size(buffer, &info)),
        stsd: stbl
            .as_ref()
            .and_then(|stbl| find_child(buffer, stbl, "stsd"))
            .and_then(|info| read_stsd_size(buffer, &info)),
        durations,
        sample_count: stbl
            .as_ref()
            .and_then(|stbl| find_child(buffer, stbl, "stsz"))
            .and_then(|info| read_stsz_count(buffer, &info)),
    })
}

pub fn probe_buffer(buffer: &[u8]) -> Result<MediaProbe, String> {
    if buffer.len() < 16 {
        return Err("媒体文件不完整，无法解析 MP4 结构".into());
    }
    let moov = find_top(buffer, "moov").ok_or_else(|| "媒体文件不是标准的 MP4（缺少 moov 盒子）".to_string())?;
    let movie_timing = find_child(buffer, &moov, "mvhd").and_then(|info| read_timescale_duration(buffer, &info));
    let traks: Vec<Option<VideoTrak>> = find_children(buffer, &moov, "trak")
        .iter()
        .map(|trak| parse_video_trak(buffer, trak))
        .collect();
    let video = traks
        .iter()
        .flatten()
        .find(|trak| trak.handler.as_deref() == Some("vide") && (trak.durations.is_some() || trak.stsd.is_some()))
        .ok_or_else(|| "媒体文件里没有视频轨".to_string())?;
    let has_audio = traks
        .iter()
        .flatten()
        .any(|trak| trak.handler.as_deref() == Some("soun"));

    let mut warnings: Vec<String> = Vec::new();
    let mut frame_durations = video.durations.clone();
    let stts_count = frame_durations.as_ref().map(|items| items.len()).unwrap_or(0);
    let sample_count = video.sample_count.unwrap_or(0) as usize;
    let mut frame_count = stts_count;
    if stts_count > 0 && sample_count > 0 && sample_count != stts_count {
        warnings.push(format!(
            "MP4 的 stts 帧时长条目数（{stts_count}）与 stsz 采样数（{sample_count}）不一致，已按 stts 时间轴为准"
        ));
    }
    if frame_count == 0 && sample_count > 0 {
        frame_count = sample_count;
    }

    let track_seconds = video
        .timing
        .as_ref()
        .map(|(timescale, duration)| if *timescale > 0 { *duration as f64 / *timescale as f64 } else { 0.0 })
        .unwrap_or(0.0);
    let movie_seconds = movie_timing
        .as_ref()
        .map(|(timescale, duration)| if *timescale > 0 { *duration as f64 / *timescale as f64 } else { 0.0 })
        .unwrap_or(0.0);
    let mut duration_sec = if track_seconds > 0.0 { track_seconds } else { movie_seconds };

    if let Some(durations) = frame_durations.as_ref() {
        if duration_sec <= 0.0 {
            duration_sec = durations.iter().sum::<f64>() / 1000.0;
        }
    }
    if frame_count == 0 {
        return Err("无法从 MP4 中读取视频帧数".into());
    }
    if duration_sec <= 0.0 {
        return Err("无法从 MP4 中读取视频时长".into());
    }
    let frame_durations = match frame_durations.take() {
        Some(mut durations) if !durations.is_empty() => {
            durations.resize(frame_count, duration_sec * 1000.0 / frame_count as f64);
            durations
        }
        _ => {
            let uniform = duration_sec * 1000.0 / frame_count as f64;
            vec![(uniform * 1000.0).round() / 1000.0; frame_count]
        }
    };
    if frame_durations.len() != frame_count {
        frame_count = frame_durations.len();
    }
    let size = match video.stsd {
        Some((width, height)) if width > 0 && height > 0 => Some((width, height)),
        _ => video.tkhd.map(|(width, height)| (width.round() as u32, height.round() as u32)),
    };
    let (width, height) = size.ok_or_else(|| "无法从 MP4 中读取视频尺寸".to_string())?;
    if width == 0 || height == 0 {
        return Err("无法从 MP4 中读取视频尺寸".into());
    }
    let fps = frame_count as f64 / duration_sec;
    Ok(MediaProbe {
        path: String::new(),
        width,
        height,
        duration_sec: (duration_sec * 1000.0).round() / 1000.0,
        frame_count: frame_count as u32,
        fps: (fps * 1000.0).round() / 1000.0,
        frame_durations_ms: frame_durations,
        has_audio,
        size_bytes: 0,
        warnings,
    })
}

pub fn probe(path: &str) -> Result<MediaProbe, String> {
    let file_path = Path::new(path);
    let metadata = std::fs::metadata(file_path).map_err(|_| format!("媒体文件不存在或无法读取：{path}"))?;
    if metadata.len() < 16 {
        return Err("媒体文件为空或已损坏".into());
    }
    let buffer = std::fs::read(file_path).map_err(|error| format!("读取媒体文件失败：{error}"))?;
    let mut probe = probe_buffer(&buffer)?;
    probe.path = path.to_string();
    probe.size_bytes = metadata.len();
    Ok(probe)
}
