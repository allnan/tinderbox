//! X 媒体工坊 GIF/WebP 转换流水线 Rust 原型库。
//!
//! 移植自 Electron 版 `x-gif-studio/electron/lib/gif.cjs` 及其依赖的
//! gifprobe / webp / mp4probe 核心逻辑，零第三方依赖（仅 std）。
//!
//! 主 Tauri 后端集成方式（见 `x-gif-studio-tauri/docs/PORT-convert.md`）：
//! - 作为 path 依赖引入本 crate，直接调用 [`pipeline::convert`]；
//! - 或把 `src/` 下模块复制进 `src-tauri` 并去掉 CLI 层。
//!
//! 所有模块都是 `pub`，便于按需复用探测、时间轴、延时修补等纯函数。

pub mod cli;
pub mod ffmpeg;
pub mod fsutil;
pub mod gif;
pub mod mp4;
pub mod params;
pub mod pipeline;
pub mod process;
pub mod progress;
pub mod timeline;
pub mod tools;
pub mod webp;
