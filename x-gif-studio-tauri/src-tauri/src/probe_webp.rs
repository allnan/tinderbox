// 纯 Rust 动画 WebP 探测与 ANMF 逐帧延时修补。
#![allow(dead_code)]

#[derive(Clone, Debug)]
pub struct WebpProbe {
    pub width: u32,
    pub height: u32,
    pub frame_count: usize,
    pub frame_delays_ms: Vec<u32>,
    pub loop_count: Option<u16>,
    pub size_bytes: u64,
}

#[derive(Clone, Debug)]
struct WebpFrame {
    duration_offset: usize,
    duration_ms: u32,
}

fn read_u16_le(buffer: &[u8], offset: usize) -> Option<u16> {
    if offset + 2 > buffer.len() {
        return None;
    }
    Some(u16::from_le_bytes([buffer[offset], buffer[offset + 1]]))
}

fn read_u24_le(buffer: &[u8], offset: usize) -> Option<u32> {
    if offset + 3 > buffer.len() {
        return None;
    }
    Some(buffer[offset] as u32 | ((buffer[offset + 1] as u32) << 8) | ((buffer[offset + 2] as u32) << 16))
}

fn read_u32_le(buffer: &[u8], offset: usize) -> Option<u32> {
    if offset + 4 > buffer.len() {
        return None;
    }
    Some(u32::from_le_bytes([
        buffer[offset],
        buffer[offset + 1],
        buffer[offset + 2],
        buffer[offset + 3],
    ]))
}

struct ParsedWebp {
    width: u32,
    height: u32,
    loop_count: Option<u16>,
    frames: Vec<WebpFrame>,
}

fn parse_webp(buffer: &[u8]) -> Result<ParsedWebp, String> {
    if buffer.len() < 16 {
        return Err("不是有效的 WebP 文件（文件过短）".into());
    }
    if &buffer[0..4] != b"RIFF" || &buffer[8..12] != b"WEBP" {
        return Err("不是有效的 WebP 文件（缺少 RIFF/WEBP 标识）".into());
    }
    let mut width = 0u32;
    let mut height = 0u32;
    let mut loop_count: Option<u16> = None;
    let mut frames: Vec<WebpFrame> = Vec::new();
    let mut offset = 12usize;
    while offset + 8 <= buffer.len() {
        let fourcc = &buffer[offset..offset + 4];
        let size = read_u32_le(buffer, offset + 4).unwrap_or(0) as usize;
        let payload = offset + 8;
        if payload + size > buffer.len() {
            return Err("WebP 数据块不完整".into());
        }
        match fourcc {
            b"VP8X" => {
                width = 1 + read_u24_le(buffer, payload + 4).unwrap_or(0);
                height = 1 + read_u24_le(buffer, payload + 7).unwrap_or(0);
            }
            b"ANIM" => {
                loop_count = read_u16_le(buffer, payload + 4);
            }
            b"ANMF" => {
                let duration = read_u24_le(buffer, payload + 12).unwrap_or(0);
                frames.push(WebpFrame {
                    duration_offset: payload + 12,
                    duration_ms: duration,
                });
            }
            _ => {}
        }
        offset = payload + size + (size % 2);
    }
    if width == 0 || height == 0 {
        return Err("无法从 WebP 中读取画布尺寸".into());
    }
    Ok(ParsedWebp {
        width,
        height,
        loop_count,
        frames,
    })
}

pub fn probe(path: &str) -> Result<WebpProbe, String> {
    let buffer = std::fs::read(path).map_err(|_| format!("WebP 文件不存在或无法读取：{path}"))?;
    let parsed = parse_webp(&buffer)?;
    let delays: Vec<u32> = parsed.frames.iter().map(|frame| frame.duration_ms).collect();
    Ok(WebpProbe {
        width: parsed.width,
        height: parsed.height,
        frame_count: delays.len(),
        frame_delays_ms: delays,
        loop_count: parsed.loop_count,
        size_bytes: buffer.len() as u64,
    })
}

pub fn patch_delays(source: &[u8], delays_ms: &[u32]) -> Result<Vec<u8>, String> {
    if delays_ms.is_empty() {
        return Err("缺少要写入的逐帧延时数组".into());
    }
    let parsed = parse_webp(source)?;
    if parsed.frames.len() != delays_ms.len() {
        return Err(format!(
            "帧延时数量（{}）与 WebP 帧数（{}）不一致",
            delays_ms.len(),
            parsed.frames.len()
        ));
    }
    let mut output = source.to_vec();
    for (index, frame) in parsed.frames.iter().enumerate() {
        let value = delays_ms[index].min(0xffffff);
        output[frame.duration_offset] = (value & 0xff) as u8;
        output[frame.duration_offset + 1] = ((value >> 8) & 0xff) as u8;
        output[frame.duration_offset + 2] = ((value >> 16) & 0xff) as u8;
    }
    // 校验：延时写回后帧数/延时一致
    let verify = parse_webp(&output)?;
    if verify.frames.len() != delays_ms.len() {
        return Err("写入 WebP 帧延时后校验失败：帧数不一致".into());
    }
    for (index, frame) in verify.frames.iter().enumerate() {
        if frame.duration_ms != delays_ms[index].min(0xffffff) {
            return Err(format!("写入 WebP 帧延时后校验失败：第 {} 帧不正确", index + 1));
        }
    }
    Ok(output)
}
