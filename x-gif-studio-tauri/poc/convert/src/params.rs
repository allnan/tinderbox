//! 转换参数与取值范围。
//!
//! 与 Electron 版 `electron/lib/defaults.cjs` 的 `DEFAULT_PARAMS` / `PARAM_LIMITS`
//! 保持一致；改动时两边需要同步。

/// 输出动图格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnimFormat {
    Gif,
    Webp,
}

impl AnimFormat {
    /// 文件扩展名（不含点）。
    pub fn extension(self) -> &'static str {
        match self {
            AnimFormat::Gif => "gif",
            AnimFormat::Webp => "webp",
        }
    }

    /// 文案名：GIF / WebP。
    pub fn label(self) -> &'static str {
        match self {
            AnimFormat::Gif => "GIF",
            AnimFormat::Webp => "WebP",
        }
    }
}

/// GIF 编码器：默认 gifski，可切换 ffmpeg 两遍调色板法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    Gifski,
    Ffmpeg,
}

impl Encoder {
    pub fn as_str(self) -> &'static str {
        match self {
            Encoder::Gifski => "gifski",
            Encoder::Ffmpeg => "ffmpeg",
        }
    }
}

/// 抽帧帧率模式：`source` 表示按源视频逐帧时间轴 passthrough（不重采样、不抽帧）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FpsMode {
    Source,
    Numeric(u32),
}

impl FpsMode {
    /// 计算 gifski 的名义帧率 / ffmpeg 的 `-framerate` 时用到的数值；`Source` 由调用方换算。
    /// 主 Tauri 后端做参数序列化 / 回显时会用到，POC 内部暂未调用。
    #[allow(dead_code)]
    pub fn numeric(self) -> Option<u32> {
        match self {
            FpsMode::Source => None,
            FpsMode::Numeric(value) => Some(value),
        }
    }

    /// 参数展示文本：`source` 或数字。主 Tauri 后端做参数回显时会用到。
    #[allow(dead_code)]
    pub fn as_string(self) -> String {
        match self {
            FpsMode::Source => "source".to_string(),
            FpsMode::Numeric(value) => value.to_string(),
        }
    }
}

/// GIF 抖动模式，仅 ffmpeg 两遍编码使用。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dither {
    Sierra2_4a,
    Bayer,
    None,
}

impl Dither {
    pub fn as_str(self) -> &'static str {
        match self {
            Dither::Sierra2_4a => "sierra2_4a",
            Dither::Bayer => "bayer",
            Dither::None => "none",
        }
    }

}

/// 参数上限（与 defaults.cjs 的 PARAM_LIMITS 一致）。
pub const WIDTH_MIN: u32 = 64;
pub const WIDTH_MAX: u32 = 1920;
pub const FPS_MIN: u32 = 4;
pub const FPS_MAX: u32 = 60;
pub const COLORS_MIN: u32 = 16;
pub const COLORS_MAX: u32 = 256;
pub const QUALITY_MIN: u32 = 1;
pub const QUALITY_MAX: u32 = 100;
pub const LOSSY_MIN: u32 = 0;
pub const LOSSY_MAX: u32 = 200;
pub const SPEED_MIN: f64 = 0.25;
pub const SPEED_MAX: f64 = 4.0;
/// -1 表示不循环（不写/移除 NETSCAPE2.0 扩展），0 表示无限循环。
pub const LOOP_MIN: i32 = -1;
pub const LOOP_MAX: i32 = 100;

/// GIF 规范：<2cs 的延时会被很多查看器按 10cs 处理，因此统一夹到 2cs。
pub const MIN_DELAY_CS: u32 = 2;

/// 转换参数（对应 Electron 版 `GifParams`）。
#[derive(Debug, Clone, PartialEq)]
pub struct GifParams {
    pub encoder: Encoder,
    /// 目标宽度；None 表示保持源宽度。
    pub width: Option<u32>,
    pub fps: FpsMode,
    pub colors: u32,
    pub quality: u32,
    pub dither: Dither,
    pub preserve_timing: bool,
    pub optimize: bool,
    pub lossy: u32,
    pub speed: f64,
    pub loop_count: i32,
}

impl Default for GifParams {
    fn default() -> Self {
        GifParams {
            encoder: Encoder::Gifski,
            width: None,
            fps: FpsMode::Source,
            colors: 256,
            quality: 92,
            dither: Dither::Sierra2_4a,
            preserve_timing: true,
            optimize: false,
            lossy: 0,
            speed: 1.0,
            loop_count: 0,
        }
    }
}

impl GifParams {
    /// 收敛到安全范围（与 Electron 的 `normalizeParams` 等价），用于接收前端任意输入。
    pub fn normalized(mut self) -> GifParams {
        self.width = self.width.map(|value| value.clamp(WIDTH_MIN, WIDTH_MAX));
        self.fps = match self.fps {
            FpsMode::Source => FpsMode::Source,
            FpsMode::Numeric(value) => FpsMode::Numeric(value.clamp(FPS_MIN, FPS_MAX)),
        };
        self.colors = self.colors.clamp(COLORS_MIN, COLORS_MAX);
        self.quality = self.quality.clamp(QUALITY_MIN, QUALITY_MAX);
        self.lossy = self.lossy.clamp(LOSSY_MIN, LOSSY_MAX);
        self.loop_count = self.loop_count.clamp(LOOP_MIN, LOOP_MAX);
        self.speed = if self.speed.is_finite() {
            self.speed.clamp(SPEED_MIN, SPEED_MAX)
        } else {
            1.0
        };
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_electron() {
        let params = GifParams::default();
        assert_eq!(params.encoder, Encoder::Gifski);
        assert_eq!(params.fps, FpsMode::Source);
        assert_eq!(params.colors, 256);
        assert_eq!(params.quality, 92);
        assert!(params.preserve_timing);
        assert!(!params.optimize);
        assert_eq!(params.loop_count, 0);
    }

    #[test]
    fn normalize_clamps_out_of_range() {
        let params = GifParams {
            width: Some(8),
            colors: 999,
            quality: 0,
            lossy: 999,
            speed: 99.0,
            loop_count: 500,
            ..GifParams::default()
        }
        .normalized();
        assert_eq!(params.width, Some(WIDTH_MIN));
        assert_eq!(params.colors, COLORS_MAX);
        assert_eq!(params.quality, QUALITY_MIN);
        assert_eq!(params.lossy, LOSSY_MAX);
        assert_eq!(params.speed, SPEED_MAX);
        assert_eq!(params.loop_count, LOOP_MAX);
    }
}
