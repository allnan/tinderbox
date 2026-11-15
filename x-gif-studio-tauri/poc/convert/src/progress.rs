//! 进度事件与回调接口。
//!
//! 设计目标：不依赖 Tauri / 前端类型，主 Tauri 后端可把事件直接转发到
//! `tauri::ipc::Channel` 或 window.emit，Electron 版 `JobProgress` 的字段映射见
//! `docs/PORT-convert.md` 第 5 节。

/// 阶段名（与 Electron 版 job.progress 的 phase 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Queued,
    Probe,
    Extract,
    Encode,
    Optimize,
    Finalize,
    Done,
    Cancelled,
    Error,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Queued => "queued",
            Phase::Probe => "probe",
            Phase::Extract => "extract",
            Phase::Encode => "encode",
            Phase::Optimize => "optimize",
            Phase::Finalize => "finalize",
            Phase::Done => "done",
            Phase::Cancelled => "cancelled",
            Phase::Error => "error",
        }
    }
}

/// 一条进度事件。`percent` 已经换算成整条流水线的 0-100 百分比。
#[derive(Debug, Clone)]
pub struct ProgressEvent {
    pub phase: Phase,
    pub percent: f64,
    pub message: String,
    /// 当前阶段已处理的帧序号（从 1 开始）；没有逐帧进度时为 None。
    pub frame: Option<u64>,
    /// 当前阶段预计总帧数；未知时为 None。
    pub total_frames: Option<u64>,
}

/// 进度回调接口。实现方负责节流、跨线程投递或写入 UI；流水线内部只做必要的去重。
///
/// - 主 Tauri 后端可实现为把事件转发到 `Channel<JobProgress>` 的适配器；
/// - 单测 / CLI 可直接传 `&mut ()` 丢弃进度；
/// - 闭包 `FnMut(&ProgressEvent)` 已提供 blanket 实现，可直接传 `|event| {...}`。
pub trait ProgressSink {
    fn progress(&mut self, event: &ProgressEvent);
}

impl ProgressSink for () {
    fn progress(&mut self, _event: &ProgressEvent) {}
}

impl<F: FnMut(&ProgressEvent)> ProgressSink for F {
    fn progress(&mut self, event: &ProgressEvent) {
        self(event);
    }
}

/// 便捷函数：构造事件并派发。
pub fn emit(
    sink: &mut dyn ProgressSink,
    phase: Phase,
    percent: f64,
    message: impl Into<String>,
    frame: Option<u64>,
    total_frames: Option<u64>,
) {
    sink.progress(&ProgressEvent {
        phase,
        percent: clamp_percent(percent),
        message: message.into(),
        frame,
        total_frames,
    });
}

fn clamp_percent(percent: f64) -> f64 {
    if percent.is_finite() {
        percent.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn closure_receives_events() {
        let seen: RefCell<Vec<Phase>> = RefCell::new(Vec::new());
        {
            let mut sink = |event: &ProgressEvent| seen.borrow_mut().push(event.phase);
            emit(&mut sink, Phase::Probe, 4.0, "探测", None, None);
            emit(&mut sink, Phase::Extract, 20.0, "抽帧", Some(10), Some(90));
        }
        assert_eq!(seen.borrow().as_slice(), &[Phase::Probe, Phase::Extract]);
    }

    #[test]
    fn percent_is_clamped() {
        let mut events = Vec::new();
        let mut sink = |event: &ProgressEvent| events.push(event.clone());
        emit(&mut sink, Phase::Encode, 150.0, "越界", None, None);
        assert_eq!(events[0].percent, 100.0);
    }
}
