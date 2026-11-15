//! 动画 WebP 解析与逐帧时长修补（移植 Electron 版 `electron/lib/webp.cjs`）。
//!
//! 容器结构（RIFF/WEBP）：
//!   RIFF <size> WEBP
//!   ├─ VP8X 扩展信息（画布宽高、flags；flags 的 0x02 位表示动画）
//!   ├─ ANIM 动画控制（背景色 + 循环次数，0 = 无限循环）
//!   └─ ANMF × N 帧：x(3) y(3) w-1(3) h-1(3) duration(3, 毫秒) flags(1) + 帧数据块
//!
//! ffmpeg 的 concat demuxer 会把 duration 量化到图像输入的默认帧时长网格（约 40ms），
//! 因此编码后必须用 `patch_delays` 把 ANMF 时长改写为精确值（与 GIF 的 patch_delays 同一思路）。

use std::path::Path;

const ANIMATION_FLAG: u8 = 0x02;
const MAX_DURATION_MS: u32 = 0x00ff_ffff;

#[derive(Debug, Clone)]
pub struct WebpError {
    pub message: String,
}

impl std::fmt::Display for WebpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WebpError {}

fn webp_error(message: impl Into<String>) -> WebpError {
    WebpError {
        message: message.into(),
    }
}

/// 单帧 ANMF 信息。
#[derive(Debug, Clone)]
pub struct AnmfFrame {
    pub duration_ms: u32,
    pub duration_offset: usize,
    pub width: u32,
    pub height: u32,
}

/// WebP 容器结构。
#[derive(Debug, Clone)]
pub struct ParsedWebp {
    pub width: u32,
    pub height: u32,
    pub loop_count: Option<u16>,
    pub frames: Vec<AnmfFrame>,
    pub animated: bool,
}

/// WebP 探测结果（字段与 Electron webp.probe 对齐）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct WebpInfo {
    pub width: u32,
    pub height: u32,
    pub frame_count: usize,
    pub frame_delays_ms: Vec<u32>,
    pub duration_sec: f64,
    pub fps: f64,
    pub loop_count: Option<u16>,
    pub animated: bool,
    pub size_bytes: usize,
}

/// 解析 RIFF/WebP 容器（同时返回帧时长写入偏移，供 patch_delays 使用）。
pub fn parse(bytes: &[u8]) -> Result<ParsedWebp, WebpError> {
    if bytes.len() < 16 {
        return Err(webp_error("不是有效的 WebP 文件（文件过短）"));
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(webp_error("不是有效的 WebP 文件（缺少 RIFF/WEBP 标识）"));
    }
    let riff_size = read_u32(bytes, 4)? as usize;
    if riff_size.saturating_add(8) > bytes.len() + 1 {
        return Err(webp_error("WebP 文件不完整（RIFF 长度超出文件大小）"));
    }

    let mut width = 0_u32;
    let mut height = 0_u32;
    let mut bitmap_width = 0_u32;
    let mut bitmap_height = 0_u32;
    let mut loop_count = None;
    let mut animated = false;
    let mut saw_anim_chunk = false;
    let mut frames: Vec<AnmfFrame> = Vec::new();
    let mut offset = 12_usize;
    while offset + 8 <= bytes.len() {
        let fourcc = &bytes[offset..offset + 4];
        let size = read_u32(bytes, offset + 4)? as usize;
        let payload = offset + 8;
        if payload + size > bytes.len() {
            return Err(webp_error(format!(
                "WebP 数据块不完整（{}）",
                String::from_utf8_lossy(fourcc)
            )));
        }
        if fourcc == b"VP8X" {
            if size < 10 {
                return Err(webp_error("WebP 的 VP8X 块不完整"));
            }
            let flags = bytes[payload];
            animated = flags & ANIMATION_FLAG != 0;
            width = 1 + read_u24(bytes, payload + 4)?;
            height = 1 + read_u24(bytes, payload + 7)?;
        } else if fourcc == b"ANIM" {
            if size < 6 {
                return Err(webp_error("WebP 的 ANIM 块不完整"));
            }
            saw_anim_chunk = true;
            loop_count = Some(read_u16(bytes, payload + 4)?);
        } else if fourcc == b"ANMF" {
            if size < 16 {
                return Err(webp_error("WebP 的 ANMF 帧块不完整"));
            }
            frames.push(AnmfFrame {
                duration_ms: read_u24(bytes, payload + 12)?,
                duration_offset: payload + 12,
                width: 1 + read_u24(bytes, payload + 6)?,
                height: 1 + read_u24(bytes, payload + 9)?,
            });
        } else if fourcc == b"VP8 " {
            // 静态有损 WebP 的位流：3 字节帧标签 + 起始码 9D 01 2A + 14 位宽高。
            if size >= 10
                && bytes[payload + 3] == 0x9d
                && bytes[payload + 4] == 0x01
                && bytes[payload + 5] == 0x2a
            {
                bitmap_width = (read_u16(bytes, payload + 6)? as u32) & 0x3fff;
                bitmap_height = (read_u16(bytes, payload + 8)? as u32) & 0x3fff;
            }
        } else if fourcc == b"VP8L" {
            // 静态无损 WebP：0x2F 签名 + 14 位宽高（各减 1）。
            if size >= 5 && bytes[payload] == 0x2f {
                let bits = read_u32(bytes, payload + 1)?;
                bitmap_width = (bits & 0x3fff) + 1;
                bitmap_height = ((bits >> 14) & 0x3fff) + 1;
            }
        }
        offset = payload + size + (size % 2);
    }

    if width == 0 || height == 0 {
        if let Some(first) = frames.first() {
            width = first.width;
            height = first.height;
        } else if bitmap_width > 0 && bitmap_height > 0 {
            width = bitmap_width;
            height = bitmap_height;
        } else {
            return Err(webp_error("无法从 WebP 中读取画布尺寸"));
        }
    }
    let is_animation = saw_anim_chunk || frames.len() > 1 || animated;
    Ok(ParsedWebp {
        width,
        height,
        loop_count,
        frames,
        animated: is_animation,
    })
}

/// 把解析结果整理为探测数据。
pub fn summarize(parsed: &ParsedWebp, size_bytes: usize) -> WebpInfo {
    let frame_delays_ms: Vec<u32> = if parsed.frames.is_empty() {
        vec![0]
    } else {
        parsed.frames.iter().map(|frame| frame.duration_ms).collect()
    };
    let total_ms: u64 = frame_delays_ms.iter().map(|ms| u64::from(*ms)).sum();
    let duration_sec = total_ms as f64 / 1000.0;
    let frame_count = if parsed.frames.is_empty() {
        1
    } else {
        parsed.frames.len()
    };
    let fps = if duration_sec > 0.0 {
        frame_count as f64 / duration_sec
    } else {
        0.0
    };
    WebpInfo {
        width: parsed.width,
        height: parsed.height,
        frame_count,
        frame_delays_ms,
        duration_sec: round3(duration_sec),
        fps: round3(fps),
        loop_count: if parsed.animated {
            parsed.loop_count
        } else {
            None
        },
        animated: parsed.animated,
        size_bytes,
    }
}

/// 探测动画 WebP 文件。
pub fn probe_file(path: &Path) -> Result<WebpInfo, WebpError> {
    let bytes = std::fs::read(path)
        .map_err(|_| webp_error(format!("WebP 文件不存在或无法读取：{}", path.display())))?;
    probe_bytes(&bytes)
}

/// 从内存字节探测 WebP。
pub fn probe_bytes(bytes: &[u8]) -> Result<WebpInfo, WebpError> {
    let parsed = parse(bytes)?;
    Ok(summarize(&parsed, bytes.len()))
}

/// 把动画 WebP 的逐帧时长改写为指定毫秒数组，并读回校验。
pub fn patch_delays(src: &Path, dst: &Path, delays_ms: &[u32]) -> Result<WebpInfo, WebpError> {
    if delays_ms.is_empty() {
        return Err(webp_error("缺少要写入的逐帧延时数组"));
    }
    let buffer = std::fs::read(src)
        .map_err(|_| webp_error(format!("WebP 文件不存在或无法读取：{}", src.display())))?;
    let parsed = parse(&buffer)?;
    if !parsed.animated || parsed.frames.is_empty() {
        return Err(webp_error("不是动画 WebP，无法写入逐帧延时"));
    }
    if parsed.frames.len() != delays_ms.len() {
        return Err(webp_error(format!(
            "帧延时数量（{}）与 WebP 帧数（{}）不一致；这通常说明编码器输出帧数与抽帧数不同，请重试或更换参数",
            delays_ms.len(),
            parsed.frames.len()
        )));
    }
    let mut normalized = Vec::with_capacity(delays_ms.len());
    for (index, value) in delays_ms.iter().enumerate() {
        if *value > MAX_DURATION_MS {
            return Err(webp_error(format!(
                "第 {} 帧延时超出 WebP 允许范围（0-16777215ms）",
                index + 1
            )));
        }
        normalized.push(*value);
    }
    let mut output = buffer.clone();
    for (index, frame) in parsed.frames.iter().enumerate() {
        if frame.duration_offset + 3 > output.len() {
            return Err(webp_error("WebP 帧时长写入位置越界"));
        }
        write_u24(&mut output, frame.duration_offset, normalized[index]);
    }
    crate::fsutil::write_atomically(dst, &output)
        .map_err(|error| webp_error(format!("写入 WebP 失败：{}", error)))?;

    let verification = probe_file(dst)?;
    if let Some((index, _)) = verification
        .frame_delays_ms
        .iter()
        .zip(normalized.iter())
        .enumerate()
        .find(|(_, (actual, expected))| *actual != *expected)
    {
        return Err(webp_error(format!(
            "写入 WebP 帧延时后校验失败：第 {} 帧不正确",
            index + 1
        )));
    }
    Ok(verification)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, WebpError> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| webp_error("WebP 数据块不完整"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u24(bytes: &[u8], offset: usize) -> Result<u32, WebpError> {
    let slice = bytes
        .get(offset..offset + 3)
        .ok_or_else(|| webp_error("WebP 数据块不完整"))?;
    Ok(u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, WebpError> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| webp_error("WebP 数据块不完整"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn write_u24(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset] = (value & 0xff) as u8;
    bytes[offset + 1] = ((value >> 8) & 0xff) as u8;
    bytes[offset + 2] = ((value >> 16) & 0xff) as u8;
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(fourcc);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            bytes.push(0);
        }
        bytes
    }

    fn tiny_webp() -> Vec<u8> {
        let mut vp8x = vec![0x02, 0, 0, 0];
        vp8x.extend_from_slice(&1_u32.to_le_bytes()[..3]);
        vp8x.extend_from_slice(&1_u32.to_le_bytes()[..3]);
        let anim = [0_u8, 0, 0, 0, 0, 0];
        let mut frame = Vec::new();
        frame.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        frame.extend_from_slice(&1_u32.to_le_bytes()[..3]);
        frame.extend_from_slice(&1_u32.to_le_bytes()[..3]);
        frame.extend_from_slice(&[40, 0, 0, 0]);
        let mut body = Vec::new();
        body.extend_from_slice(b"WEBP");
        body.extend_from_slice(&chunk(b"VP8X", &vp8x));
        body.extend_from_slice(&chunk(b"ANIM", &anim));
        body.extend_from_slice(&chunk(b"ANMF", &frame));
        let mut riff = Vec::new();
        riff.extend_from_slice(b"RIFF");
        riff.extend_from_slice(&(body.len() as u32).to_le_bytes());
        riff.extend_from_slice(&body);
        riff
    }

    #[test]
    fn probe_animation() {
        let info = probe_bytes(&tiny_webp()).expect("probe");
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.frame_count, 1);
        assert_eq!(info.frame_delays_ms, vec![40]);
        assert_eq!(info.loop_count, Some(0));
        assert!(info.animated);
    }

    #[test]
    fn patch_delay_round_trip() {
        // 用 crate 内的 target/test-tmp，避免 CI / 受限环境对系统临时目录的写入限制。
        let dir = std::env::current_dir()
            .expect("cwd")
            .join("target")
            .join("test-tmp")
            .join(format!(
                "webp-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0)
            ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.webp");
        let dst = dir.join("dst.webp");
        std::fs::write(&src, tiny_webp()).unwrap();
        let info = patch_delays(&src, &dst, &[33]).expect("patch");
        assert_eq!(info.frame_delays_ms, vec![33]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
