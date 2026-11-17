// 纯 Rust GIF 解析与逐帧延时修补（NETSCAPE 循环扩展一并处理）。
#![allow(dead_code)]

const EXTENSION: u8 = 0x21;
const IMAGE: u8 = 0x2c;
const TRAILER: u8 = 0x3b;
const GCE_LABEL: u8 = 0xf9;
const APP_LABEL: u8 = 0xff;
const NETSCAPE: &[u8] = b"NETSCAPE2.0";
const MIN_DELAY_CS: u16 = 2;

#[derive(Clone, Debug)]
pub struct GifFrame {
    pub delay_cs: Option<u16>,
    pub delay_pos: Option<usize>,
    pub image_start: usize,
}

#[derive(Clone, Debug)]
pub struct GifParsed {
    pub width: u32,
    pub height: u32,
    pub global_table_end: usize,
    pub loop_count: Option<u16>,
    pub netscape_offset: Option<usize>,
    pub loop_value_pos: Option<usize>,
    pub frames: Vec<GifFrame>,
}

#[derive(Clone, Debug)]
pub struct GifProbe {
    pub width: u32,
    pub height: u32,
    pub frame_count: usize,
    pub frame_delays_ms: Vec<u32>,
    pub loop_count: i32,
    pub size_bytes: u64,
}

fn read_u16_le(buffer: &[u8], offset: usize) -> Option<u16> {
    if offset + 2 > buffer.len() {
        return None;
    }
    Some(u16::from_le_bytes([buffer[offset], buffer[offset + 1]]))
}

fn skip_sub_blocks(buffer: &[u8], start: usize) -> Result<usize, String> {
    let mut offset = start;
    loop {
        if offset >= buffer.len() {
            return Err("GIF 数据块不完整，文件可能已损坏".into());
        }
        let size = buffer[offset] as usize;
        offset += 1;
        if size == 0 {
            return Ok(offset);
        }
        if offset + size > buffer.len() {
            return Err("GIF 数据块不完整，文件可能已损坏".into());
        }
        offset += size;
    }
}

/// 返回 (end, label, data_start)；data_start 指向块长度字节。
fn read_extension(buffer: &[u8], offset: usize) -> Result<(usize, u8, usize), String> {
    if offset + 2 > buffer.len() {
        return Err("GIF 扩展块不完整".into());
    }
    let label = buffer[offset + 1];
    let data_start = offset + 2;
    let end = skip_sub_blocks(buffer, data_start)?;
    Ok((end, label, data_start))
}

/// 返回子块列表（每个元素为 (起始偏移, 长度)）与结束偏移。
fn read_sub_blocks(buffer: &[u8], start: usize) -> Result<(Vec<(usize, usize)>, usize), String> {
    let mut blocks = Vec::new();
    let mut offset = start;
    loop {
        if offset >= buffer.len() {
            return Err("GIF 数据块不完整".into());
        }
        let size = buffer[offset] as usize;
        offset += 1;
        if size == 0 {
            return Ok((blocks, offset));
        }
        if offset + size > buffer.len() {
            return Err("GIF 数据块不完整".into());
        }
        blocks.push((offset, size));
        offset += size;
    }
}

fn image_block_end(buffer: &[u8], offset: usize) -> Result<usize, String> {
    if offset + 10 > buffer.len() {
        return Err("GIF 图像块不完整".into());
    }
    let packed = buffer[offset + 9];
    let mut cursor = offset + 10;
    if packed & 0x80 != 0 {
        cursor += 3 * (1usize << ((packed & 0x07) + 1));
    }
    if cursor >= buffer.len() {
        return Err("GIF 图像数据缺失".into());
    }
    cursor += 1;
    skip_sub_blocks(buffer, cursor)
}

pub fn parse_gif(buffer: &[u8]) -> Result<GifParsed, String> {
    if buffer.len() < 13 {
        return Err("不是有效的 GIF 文件（文件过短）".into());
    }
    let version = &buffer[0..6];
    if version != b"GIF87a" && version != b"GIF89a" {
        return Err("不是有效的 GIF 文件（文件头不是 GIF87a/GIF89a）".into());
    }
    let width = read_u16_le(buffer, 6).ok_or("GIF 尺寸无效")? as u32;
    let height = read_u16_le(buffer, 8).ok_or("GIF 尺寸无效")? as u32;
    if width == 0 || height == 0 {
        return Err("GIF 尺寸无效".into());
    }
    let packed = buffer[10];
    let mut offset = 13usize;
    if packed & 0x80 != 0 {
        offset += 3 * (1usize << ((packed & 0x07) + 1));
    }
    if offset > buffer.len() {
        return Err("GIF 全局调色板不完整".into());
    }
    let global_table_end = offset;
    let mut frames: Vec<GifFrame> = Vec::new();
    let mut loop_count: Option<u16> = None;
    let mut netscape_offset: Option<usize> = None;
    let mut loop_value_pos: Option<usize> = None;
    let mut pending_gce: Option<(Option<u16>, Option<usize>)> = None;
    let mut saw_trailer = false;

    while offset < buffer.len() {
        let marker = buffer[offset];
        if marker == EXTENSION {
            let (end, label, data_start) = read_extension(buffer, offset)?;
            if label == GCE_LABEL {
                if data_start + 4 > end {
                    return Err("GIF 图形控制扩展不完整".into());
                }
                let delay = read_u16_le(buffer, data_start + 2).unwrap_or(0);
                pending_gce = Some((Some(delay), Some(data_start + 2)));
            } else if label == APP_LABEL {
                let (blocks, _) = read_sub_blocks(buffer, data_start)?;
                if blocks.len() >= 2 {
                    let (first_start, first_len) = blocks[0];
                    if first_len >= 11 && &buffer[first_start..first_start + 11] == NETSCAPE {
                        netscape_offset = Some(offset);
                        let (second_start, second_len) = blocks[1];
                        if second_len >= 3 {
                            loop_count = read_u16_le(buffer, second_start + 1);
                            loop_value_pos = Some(second_start + 1);
                        }
                    }
                }
            }
            offset = end;
            continue;
        }
        if marker == IMAGE {
            let image_start = offset;
            let end = image_block_end(buffer, image_start)?;
            frames.push(GifFrame {
                delay_cs: pending_gce.as_ref().and_then(|(delay, _)| *delay),
                delay_pos: pending_gce.as_ref().and_then(|(_, pos)| *pos),
                image_start,
            });
            pending_gce = None;
            offset = end;
            continue;
        }
        if marker == TRAILER {
            saw_trailer = true;
            offset += 1;
            break;
        }
        offset += 1;
    }
    if !saw_trailer {
        return Err("GIF 文件缺少结束标记（文件可能被截断）".into());
    }
    if frames.is_empty() {
        return Err("GIF 文件里没有图像帧".into());
    }
    Ok(GifParsed {
        width,
        height,
        global_table_end,
        loop_count,
        netscape_offset,
        loop_value_pos,
        frames,
    })
}

pub fn summarize(parsed: &GifParsed, size_bytes: u64) -> GifProbe {
    let delays: Vec<u32> = parsed
        .frames
        .iter()
        .map(|frame| frame.delay_cs.unwrap_or(0) as u32 * 10)
        .collect();
    let frame_count = parsed.frames.len();
    let total_ms: u32 = delays.iter().sum();
    GifProbe {
        width: parsed.width,
        height: parsed.height,
        frame_count,
        frame_delays_ms: delays,
        loop_count: parsed.loop_count.map(|value| value as i32).unwrap_or(-1),
        size_bytes: size_bytes.max(0),
    }
}

pub fn probe(path: &str) -> Result<GifProbe, String> {
    let buffer = std::fs::read(path).map_err(|_| format!("GIF 文件不存在或无法读取：{path}"))?;
    let parsed = parse_gif(&buffer)?;
    Ok(summarize(&parsed, buffer.len() as u64))
}

pub fn patch_delays(
    source: &[u8],
    target_delays_cs: &[u16],
    loop_count: Option<i32>,
) -> Result<Vec<u8>, String> {
    if target_delays_cs.is_empty() {
        return Err("缺少要写入的帧延时数组".into());
    }
    let parsed = parse_gif(source)?;
    if target_delays_cs.len() != parsed.frames.len() {
        return Err(format!(
            "帧延时数量（{}）与 GIF 帧数（{}）不一致",
            target_delays_cs.len(),
            parsed.frames.len()
        ));
    }
    let delays: Vec<u16> = target_delays_cs
        .iter()
        .map(|value| (*value).max(MIN_DELAY_CS))
        .collect();
    let mut output: Vec<u8> = Vec::with_capacity(source.len() + 64);
    output.extend_from_slice(&source[..parsed.global_table_end]);

    // 需要在全局调色板后插入 NETSCAPE 循环扩展
    if let Some(loop_value) = loop_count {
        if loop_value >= 0 && parsed.netscape_offset.is_none() {
            output.extend_from_slice(&[EXTENSION, APP_LABEL, 0x0b]);
            output.extend_from_slice(NETSCAPE);
            output.extend_from_slice(&[
                0x03,
                0x01,
                (loop_value & 0xff) as u8,
                ((loop_value >> 8) & 0xff) as u8,
                0x00,
            ]);
        }
    }

    let mut pending_delay_pos: Option<usize> = None;
    let mut frame_index = 0usize;
    let mut offset = parsed.global_table_end;
    while offset < source.len() {
        let marker = source[offset];
        if marker == EXTENSION {
            let (end, label, data_start) = read_extension(source, offset)?;
            if label == GCE_LABEL {
                let base = output.len();
                output.extend_from_slice(&source[offset..end]);
                pending_delay_pos = Some(base + (data_start + 2 - offset));
            } else if label == APP_LABEL {
                let (blocks, _) = read_sub_blocks(source, data_start)?;
                let is_netscape = blocks
                    .first()
                    .map(|(start, len)| *len >= 11 && &source[*start..*start + 11] == NETSCAPE)
                    .unwrap_or(false);
                if is_netscape {
                    if let Some(loop_value) = loop_count {
                        if loop_value < 0 {
                            // 不写 NETSCAPE：删除该扩展
                            offset = end;
                            continue;
                        }
                        let base = output.len();
                        output.extend_from_slice(&source[offset..end]);
                        if let (Some(pos), Some((value_start, value_len))) =
                            (parsed.loop_value_pos, blocks.get(1).copied())
                        {
                            if value_len >= 3 {
                                let target = base + (value_start - offset);
                                output[target] = (loop_value & 0xff) as u8;
                                output[target + 1] = ((loop_value >> 8) & 0xff) as u8;
                            }
                        }
                    } else {
                        output.extend_from_slice(&source[offset..end]);
                    }
                } else {
                    output.extend_from_slice(&source[offset..end]);
                }
            } else {
                output.extend_from_slice(&source[offset..end]);
            }
            offset = end;
            continue;
        }
        if marker == IMAGE {
            let delay = delays[frame_index];
            match pending_delay_pos.take() {
                Some(position) => {
                    output[position] = (delay & 0xff) as u8;
                    output[position + 1] = ((delay >> 8) & 0xff) as u8;
                }
                None => {
                    output.extend_from_slice(&[
                        EXTENSION,
                        GCE_LABEL,
                        0x04,
                        0x00,
                        (delay & 0xff) as u8,
                        ((delay >> 8) & 0xff) as u8,
                        0x00,
                        0x00,
                    ]);
                }
            }
            let end = image_block_end(source, offset)?;
            output.extend_from_slice(&source[offset..end]);
            frame_index += 1;
            offset = end;
            continue;
        }
        if marker == TRAILER {
            output.push(TRAILER);
            break;
        }
        output.push(marker);
        offset += 1;
    }

    // 写回校验
    let verify = parse_gif(&output)?;
    if verify.frames.len() != delays.len() {
        return Err("写入 GIF 延时后校验失败：帧数不一致".into());
    }
    for (index, frame) in verify.frames.iter().enumerate() {
        let actual = frame.delay_cs.unwrap_or(0);
        if actual != delays[index] {
            return Err(format!("写入 GIF 延时后校验失败：第 {} 帧不正确", index + 1));
        }
    }
    if let Some(loop_value) = loop_count {
        if loop_value >= 0 {
            let actual = verify.loop_count.map(|value| value as i32).unwrap_or(-1);
            if actual != loop_value {
                return Err("写入 GIF 循环次数后校验失败".into());
            }
        }
    }
    Ok(output)
}


/// 读取 GIF 每帧图像数据的压缩字节数（不含帧头/调色板），用于体积预估中
/// 区分「首帧 / 连续段边界帧 / 稳态帧」。解析失败时返回明确错误。
pub fn frame_data_sizes(path: &str) -> Result<Vec<u32>, String> {
    let buffer = std::fs::read(path).map_err(|_| format!("GIF 文件不存在或无法读取：{path}"))?;
    if buffer.len() < 13 {
        return Err("不是有效的 GIF 文件（文件过短）".into());
    }
    if &buffer[0..6] != b"GIF87a" && &buffer[0..6] != b"GIF89a" {
        return Err("不是有效的 GIF 文件（文件头不是 GIF87a/GIF89a）".into());
    }
    let packed = buffer[10];
    let mut offset = 13usize;
    if packed & 0x80 != 0 {
        offset += 3 * (1usize << ((packed & 0x07) + 1));
    }
    if offset > buffer.len() {
        return Err("GIF 全局调色板不完整".into());
    }
    let mut sizes: Vec<u32> = Vec::new();
    while offset < buffer.len() {
        match buffer[offset] {
            EXTENSION => {
                let (end, _, _) = read_extension(&buffer, offset)?;
                offset = end;
            }
            IMAGE => {
                if offset + 10 > buffer.len() {
                    return Err("GIF 图像块不完整".into());
                }
                let image_packed = buffer[offset + 9];
                let mut cursor = offset + 10;
                if image_packed & 0x80 != 0 {
                    cursor += 3 * (1usize << ((image_packed & 0x07) + 1));
                }
                if cursor >= buffer.len() {
                    return Err("GIF 图像数据缺失".into());
                }
                cursor += 1; // LZW 最小码长
                let (blocks, end) = read_sub_blocks(&buffer, cursor)?;
                let total: u32 = blocks.iter().map(|(_, len)| *len as u32).sum();
                sizes.push(total);
                offset = end;
            }
            TRAILER => break,
            _ => offset += 1,
        }
    }
    if sizes.is_empty() {
        return Err("GIF 文件里没有图像帧".into());
    }
    Ok(sizes)
}
