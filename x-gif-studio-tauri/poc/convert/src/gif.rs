//! 纯 Rust GIF 解析与逐帧延时修补（移植 Electron 版 `electron/lib/gifprobe.cjs`）。
//!
//! - `probe_file` / `probe_bytes`：逻辑屏幕宽高、帧数、逐帧延时（GCE）、循环次数、体积；
//! - `patch_delays`：把每帧延时重写为指定厘秒值，并按需写入 / 移除 NETSCAPE2.0 循环扩展，
//!   写完后读回校验，不一致直接报错。
//!
//! GIF 延时单位为 1/100 秒；最小 2cs 的业务规则由调用方（流水线）保证。

use std::path::Path;

const HEADER_LENGTH: usize = 13;
const EXTENSION: u8 = 0x21;
const IMAGE: u8 = 0x2c;
const TRAILER: u8 = 0x3b;
const GCE_LABEL: u8 = 0xf9;
const APP_LABEL: u8 = 0xff;
const NETSCAPE: &[u8] = b"NETSCAPE2.0";

#[derive(Debug, Clone)]
pub struct GifError {
    pub message: String,
}

impl std::fmt::Display for GifError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GifError {}

fn gif_error(message: impl Into<String>) -> GifError {
    GifError {
        message: message.into(),
    }
}

/// 单帧的 GCE 延时信息（保留完整解析结果，供主后端做调试 / 扩展）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct GifFrameInfo {
    pub delay_cs: Option<u16>,
    pub delay_offset: Option<usize>,
    pub image_start: usize,
}

/// GIF 结构（保留完整解析结果，供主后端做调试 / 扩展）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ParsedGif {
    pub version: String,
    pub width: u16,
    pub height: u16,
    pub packed: u8,
    pub global_color_table_end: usize,
    pub loop_count: i32,
    pub netscape_offset: Option<usize>,
    pub frames: Vec<GifFrameInfo>,
}

/// GIF 探测结果（字段与 Electron gifprobe.probe 对齐）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct GifInfo {
    pub version: String,
    pub width: u32,
    pub height: u32,
    pub frame_count: usize,
    pub frame_delays_cs: Vec<u32>,
    pub frame_delays_ms: Vec<u32>,
    pub duration_sec: f64,
    pub fps: f64,
    pub loop_count: i32,
    pub has_global_color_table: bool,
    pub size_bytes: usize,
}

/// 延时修补选项。
#[derive(Debug, Clone, Default)]
pub struct PatchGifOptions {
    /// 最小厘秒延时（Electron 流水线传 2）。
    pub min_cs: Option<u32>,
    /// Some(-1) 表示移除循环扩展；Some(n>=0) 写入 n 次循环；None 表示不修改循环。
    pub loop_count: Option<i32>,
}

/// 解析 GIF 结构（不做像素解码）。
pub fn parse(bytes: &[u8]) -> Result<ParsedGif, GifError> {
    if bytes.len() < HEADER_LENGTH {
        return Err(gif_error("不是有效的 GIF 文件（文件过短）"));
    }
    let version = String::from_utf8_lossy(&bytes[..6]).into_owned();
    if version != "GIF87a" && version != "GIF89a" {
        return Err(gif_error("不是有效的 GIF 文件（文件头不是 GIF87a/GIF89a）"));
    }
    let width = read_u16(bytes, 6)?;
    let height = read_u16(bytes, 8)?;
    let packed = bytes[10];
    if width == 0 || height == 0 {
        return Err(gif_error("GIF 尺寸无效"));
    }
    let mut offset = HEADER_LENGTH;
    if packed & 0x80 != 0 {
        offset += 3 * (1_usize << ((packed & 0x07) + 1));
    }
    if offset > bytes.len() {
        return Err(gif_error("GIF 全局调色板不完整"));
    }

    let mut frames = Vec::new();
    let mut loop_count = -1_i32;
    let mut netscape_offset = None;
    let mut pending_gce: Option<(u16, usize)> = None;
    let mut saw_trailer = false;

    while offset < bytes.len() {
        let marker = bytes[offset];
        if marker == EXTENSION {
            let extension = read_extension(bytes, offset)?;
            if extension.label == GCE_LABEL {
                // 0x21 0xF9 0x04 <packed> <delayLo> <delayHi> <transparent> 0x00
                if extension.data_start + 4 > extension.end {
                    return Err(gif_error("GIF 图形控制扩展不完整"));
                }
                let delay_cs = read_u16(bytes, extension.data_start + 2)?;
                pending_gce = Some((delay_cs, extension.data_start + 2));
            } else if extension.label == APP_LABEL {
                let (blocks, _) = read_sub_blocks(bytes, extension.data_start)?;
                if blocks.len() >= 2 {
                    let first = &bytes[blocks[0].0..blocks[0].1];
                    if first == NETSCAPE {
                        netscape_offset = Some(offset);
                        let second = &bytes[blocks[1].0..blocks[1].1];
                        if second.len() >= 3 {
                            loop_count = read_u16(bytes, blocks[1].0 + 1)? as i32;
                        }
                    }
                }
            }
            offset = extension.end;
            continue;
        }
        if marker == IMAGE {
            let image_start = offset;
            if offset + 10 > bytes.len() {
                return Err(gif_error("GIF 图像块不完整"));
            }
            let local_packed = bytes[offset + 9];
            offset += 10;
            if local_packed & 0x80 != 0 {
                offset += 3 * (1_usize << ((local_packed & 0x07) + 1));
            }
            if offset >= bytes.len() {
                return Err(gif_error("GIF 图像数据缺失"));
            }
            offset = skip_sub_blocks(bytes, offset + 1)?;
            frames.push(GifFrameInfo {
                delay_cs: pending_gce.map(|(delay, _)| delay),
                delay_offset: pending_gce.map(|(_, delay_offset)| delay_offset),
                image_start,
            });
            pending_gce = None;
            continue;
        }
        if marker == TRAILER {
            saw_trailer = true;
            break;
        }
        // 未知字节：继续前进，避免死循环（与 JS 版一致）。
        offset += 1;
    }
    if !saw_trailer {
        return Err(gif_error("GIF 文件缺少结束标记（文件可能被截断）"));
    }
    if frames.is_empty() {
        return Err(gif_error("GIF 文件里没有图像帧"));
    }
    Ok(ParsedGif {
        version,
        width,
        height,
        packed,
        global_color_table_end: HEADER_LENGTH
            + if packed & 0x80 != 0 {
                3 * (1_usize << ((packed & 0x07) + 1))
            } else {
                0
            },
        loop_count,
        netscape_offset,
        frames,
    })
}

/// 把解析结果整理为探测数据。
pub fn summarize(parsed: &ParsedGif, size_bytes: usize) -> GifInfo {
    let frame_delays_cs: Vec<u32> = parsed
        .frames
        .iter()
        .map(|frame| frame.delay_cs.map(u32::from).unwrap_or(0))
        .collect();
    let frame_delays_ms: Vec<u32> = frame_delays_cs.iter().map(|cs| cs * 10).collect();
    let duration_ms: u64 = frame_delays_ms.iter().map(|ms| u64::from(*ms)).sum();
    let duration_sec = duration_ms as f64 / 1000.0;
    let frame_count = parsed.frames.len();
    let fps = if duration_sec > 0.0 {
        frame_count as f64 / duration_sec
    } else {
        0.0
    };
    GifInfo {
        version: parsed.version.clone(),
        width: parsed.width as u32,
        height: parsed.height as u32,
        frame_count,
        frame_delays_cs,
        frame_delays_ms,
        duration_sec: round3(duration_sec),
        fps: round3(fps),
        loop_count: parsed.loop_count,
        has_global_color_table: parsed.packed & 0x80 != 0,
        size_bytes,
    }
}

/// 探测 GIF 文件。
pub fn probe_file(path: &Path) -> Result<GifInfo, GifError> {
    let bytes = std::fs::read(path)
        .map_err(|_| gif_error(format!("GIF 文件不存在或无法读取：{}", path.display())))?;
    probe_bytes(&bytes)
}

/// 从内存字节探测 GIF。
pub fn probe_bytes(bytes: &[u8]) -> Result<GifInfo, GifError> {
    let parsed = parse(bytes)?;
    Ok(summarize(&parsed, bytes.len()))
}

/// 修补 GIF 每帧延时并（可选）写入循环次数；写完后读回校验。
pub fn patch_delays(
    src: &Path,
    dst: &Path,
    delays_cs: &[u32],
    options: &PatchGifOptions,
) -> Result<GifInfo, GifError> {
    let source = std::fs::read(src)
        .map_err(|_| gif_error(format!("GIF 文件不存在或无法读取：{}", src.display())))?;
    let parsed = parse(&source)?;
    if delays_cs.is_empty() {
        return Err(gif_error("缺少要写入的帧延时数组"));
    }
    if delays_cs.len() != parsed.frames.len() {
        return Err(gif_error(format!(
            "帧延时数量（{}）与 GIF 帧数（{}）不一致；这通常说明编码器输出帧数与抽帧数不同，请重试或更换预设",
            delays_cs.len(),
            parsed.frames.len()
        )));
    }
    let min_cs = options.min_cs.unwrap_or(0);
    let mut target: Vec<u16> = Vec::with_capacity(delays_cs.len());
    for (index, value) in delays_cs.iter().enumerate() {
        let mut cs = *value;
        if min_cs > 0 && cs < min_cs {
            cs = min_cs;
        }
        if cs > u16::MAX as u32 {
            return Err(gif_error(format!("第 {} 帧延时超出 GIF 允许范围", index + 1)));
        }
        target.push(cs as u16);
    }
    if let Some(loop_count) = options.loop_count {
        if loop_count < -1 {
            return Err(gif_error("GIF 循环次数超出范围"));
        }
    }

    let mut output: Vec<u8> = Vec::with_capacity(source.len() + 64);
    let mut patches: Vec<(usize, u16)> = Vec::new();
    output.extend_from_slice(&source[..parsed.global_color_table_end]);
    if let Some(loop_count) = options.loop_count {
        if loop_count >= 0 && parsed.netscape_offset.is_none() {
            output.extend_from_slice(&build_netscape_block(loop_count as u16));
        }
    }

    let mut offset = parsed.global_color_table_end;
    let mut pending_gce: Option<(usize, usize, usize)> = None;
    let mut frame_index = 0_usize;
    while offset < source.len() {
        let marker = source[offset];
        if marker == EXTENSION {
            let extension = read_extension(&source, offset)?;
            if extension.label == GCE_LABEL {
                if extension.data_start + 4 > extension.end {
                    return Err(gif_error("GIF 图形控制扩展不完整"));
                }
                pending_gce = Some((offset, extension.end, extension.data_start + 2 - offset));
                offset = extension.end;
                continue;
            }
            if extension.label == APP_LABEL {
                let (blocks, _) = read_sub_blocks(&source, extension.data_start)?;
                if blocks.len() >= 2 && &source[blocks[0].0..blocks[0].1] == NETSCAPE {
                    if let Some(loop_count) = options.loop_count {
                        if loop_count == -1 {
                            // 不循环：整个 NETSCAPE 扩展移除。
                            offset = extension.end;
                            continue;
                        }
                        let value_offset = blocks[1].0 + 1;
                        let local = output.len();
                        output.extend_from_slice(&source[offset..extension.end]);
                        patches.push((local + (value_offset - offset), loop_count as u16));
                        offset = extension.end;
                        continue;
                    }
                }
            }
            output.extend_from_slice(&source[offset..extension.end]);
            offset = extension.end;
            continue;
        }
        if marker == IMAGE {
            if let Some((start, end, delay_offset_in_block)) = pending_gce.take() {
                let local = output.len();
                output.extend_from_slice(&source[start..end]);
                patches.push((local + delay_offset_in_block, target[frame_index]));
            } else {
                // 原文件该帧没有 GCE：插入一个无透明色、无处置的 GCE。
                let local = output.len();
                output.extend_from_slice(&[EXTENSION, GCE_LABEL, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
                patches.push((local + 4, target[frame_index]));
            }
            let image_start = offset;
            if offset + 10 > source.len() {
                return Err(gif_error("GIF 图像块不完整"));
            }
            let local_packed = source[offset + 9];
            offset += 10;
            if local_packed & 0x80 != 0 {
                offset += 3 * (1_usize << ((local_packed & 0x07) + 1));
            }
            if offset >= source.len() {
                return Err(gif_error("GIF 图像数据缺失"));
            }
            offset += 1;
            offset = skip_sub_blocks(&source, offset)?;
            output.extend_from_slice(&source[image_start..offset]);
            frame_index += 1;
            continue;
        }
        if marker == TRAILER {
            if let Some((start, end, _)) = pending_gce.take() {
                output.extend_from_slice(&source[start..end]);
            }
            output.push(TRAILER);
            break;
        }
        output.push(source[offset]);
        offset += 1;
    }
    for (position, value) in patches {
        if position + 2 > output.len() {
            return Err(gif_error("GIF 延时写入位置越界"));
        }
        output[position..position + 2].copy_from_slice(&value.to_le_bytes());
    }

    crate::fsutil::write_atomically(dst, &output)
        .map_err(|error| gif_error(format!("写入 GIF 失败：{}", error)))?;

    // 读回校验：延时与帧数必须与期望一致。
    let verification = probe_file(dst)?;
    if verification.frame_count != target.len() {
        return Err(gif_error("写入 GIF 延时后校验失败：帧数不一致"));
    }
    if let Some((index, _)) = verification
        .frame_delays_cs
        .iter()
        .zip(target.iter())
        .enumerate()
        .find(|(_, (actual, expected))| **actual != u32::from(**expected))
    {
        return Err(gif_error(format!(
            "写入 GIF 延时后校验失败：第 {} 帧延时不正确",
            index + 1
        )));
    }
    if let Some(loop_count) = options.loop_count {
        if verification.loop_count != loop_count {
            return Err(gif_error("写入 GIF 循环次数后校验失败"));
        }
    }
    Ok(verification)
}

fn build_netscape_block(loop_count: u16) -> Vec<u8> {
    let mut block = Vec::with_capacity(19);
    block.push(EXTENSION);
    block.push(APP_LABEL);
    block.push(0x0b);
    block.extend_from_slice(NETSCAPE);
    block.extend_from_slice(&[0x03, 0x01, 0x00, 0x00, 0x00]);
    block[16..18].copy_from_slice(&loop_count.to_le_bytes());
    block
}

struct ExtensionInfo {
    label: u8,
    data_start: usize,
    end: usize,
}

fn read_extension(bytes: &[u8], offset: usize) -> Result<ExtensionInfo, GifError> {
    if offset + 2 > bytes.len() {
        return Err(gif_error("GIF 扩展块不完整"));
    }
    let label = bytes[offset + 1];
    let end = skip_sub_blocks(bytes, offset + 2)?;
    Ok(ExtensionInfo {
        label,
        data_start: offset + 2,
        end,
    })
}

fn skip_sub_blocks(bytes: &[u8], offset: usize) -> Result<usize, GifError> {
    let mut cursor = offset;
    while cursor < bytes.len() {
        let size = bytes[cursor] as usize;
        cursor += 1;
        if size == 0 {
            return Ok(cursor);
        }
        if cursor + size > bytes.len() {
            return Err(gif_error("GIF 数据块不完整，文件可能已损坏"));
        }
        cursor += size;
    }
    Err(gif_error("GIF 数据块不完整，文件可能已损坏"))
}

/// 返回每个子块的数据区间（不含长度字节）与实际结束位置。
fn read_sub_blocks(bytes: &[u8], start: usize) -> Result<(Vec<(usize, usize)>, usize), GifError> {
    let mut blocks = Vec::new();
    let mut cursor = start;
    while cursor < bytes.len() {
        let size = bytes[cursor] as usize;
        cursor += 1;
        if size == 0 {
            return Ok((blocks, cursor));
        }
        if cursor + size > bytes.len() {
            return Err(gif_error("GIF 数据块不完整"));
        }
        blocks.push((cursor, cursor + size));
        cursor += size;
    }
    Err(gif_error("GIF 数据块不完整"))
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, GifError> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| gif_error("GIF 数据块不完整"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x2、2 帧的最小 GIF：每帧一个 GCE（10cs）+ 图像块。
    fn tiny_gif() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"GIF89a");
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.push(0x80); // 有全局调色板，2 色
        bytes.push(0);
        bytes.push(0);
        bytes.extend_from_slice(&[0, 0, 0, 255, 255, 255]);
        for _ in 0..2 {
            bytes.extend_from_slice(&[EXTENSION, GCE_LABEL, 0x04, 0x00, 10, 0, 0x00, 0x00]);
            bytes.extend_from_slice(&[IMAGE, 0, 0, 0, 0, 2, 0, 2, 0, 0x00]);
            bytes.push(0x02); // LZW 最小码长
            bytes.push(0x02); // 子块长度
            bytes.extend_from_slice(&[0x44, 0x01]);
            bytes.push(0x00);
        }
        bytes.push(TRAILER);
        bytes
    }

    fn temp_dir() -> std::path::PathBuf {
        // 用 crate 内的 target/test-tmp，避免 CI / 受限环境对系统临时目录的写入限制。
        let dir = std::env::current_dir()
            .expect("cwd")
            .join("target")
            .join("test-tmp")
            .join(format!(
                "gif-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or(0)
            ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_and_probe_tiny_gif() {
        let info = probe_bytes(&tiny_gif()).expect("probe");
        assert_eq!(info.width, 2);
        assert_eq!(info.height, 2);
        assert_eq!(info.frame_count, 2);
        assert_eq!(info.frame_delays_cs, vec![10, 10]);
        assert_eq!(info.loop_count, -1);
        assert_eq!(info.duration_sec, 0.2);
    }

    #[test]
    fn patch_adds_loop_and_updates_delays() {
        let dir = temp_dir();
        let src = dir.join("src.gif");
        let dst = dir.join("dst.gif");
        std::fs::write(&src, tiny_gif()).unwrap();
        let info = patch_delays(
            &src,
            &dst,
            &[3, 7],
            &PatchGifOptions {
                min_cs: Some(2),
                loop_count: Some(0),
            },
        )
        .expect("patch");
        assert_eq!(info.frame_delays_cs, vec![3, 7]);
        assert_eq!(info.loop_count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn patch_min_clamps_and_removes_loop() {
        let dir = temp_dir();
        let src = dir.join("src.gif");
        let dst = dir.join("dst.gif");
        std::fs::write(&src, tiny_gif()).unwrap();
        let info = patch_delays(
            &src,
            &dst,
            &[0, 1],
            &PatchGifOptions {
                min_cs: Some(2),
                loop_count: Some(-1),
            },
        )
        .expect("patch");
        assert_eq!(info.frame_delays_cs, vec![2, 2]);
        assert_eq!(info.loop_count, -1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
