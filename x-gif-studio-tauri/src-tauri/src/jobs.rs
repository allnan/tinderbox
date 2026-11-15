// 任务进度与取消：前端通过 jobs_poll 轮询，进度集中登记在这里。
#![allow(dead_code)]

use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::model::{JobProgress, ToolDownloadProgress};
use crate::paths::now_ms;

pub struct JobEntry {
    pub progress: JobProgress,
    pub cancel: Arc<AtomicBool>,
    pub child_pid: Option<u32>,
    pub updated_ms: u128,
}

static JOBS: OnceLock<Mutex<HashMap<String, JobEntry>>> = OnceLock::new();
static TOOL_PROGRESS: OnceLock<Mutex<Option<(ToolDownloadProgress, u128)>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, JobEntry>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn tool_slot() -> &'static Mutex<Option<(ToolDownloadProgress, u128)>> {
    TOOL_PROGRESS.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Debug)]
pub struct JobCtx {
    pub id: String,
    pub scope: String,
    pub cancel: Arc<AtomicBool>,
}

impl JobCtx {
    pub fn start(job_id: &str, scope: &str) -> Self {
        let ctx = Self {
            id: job_id.to_string(),
            scope: scope.to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
        };
        let entry = JobEntry {
            progress: JobProgress {
                job_id: ctx.id.clone(),
                scope: ctx.scope.clone(),
                phase: "queued".into(),
                percent: 0.0,
                message: "等待执行…".into(),
                done: false,
            },
            cancel: ctx.cancel.clone(),
            child_pid: None,
            updated_ms: now_ms(),
        };
        jobs().lock().unwrap().insert(ctx.id.clone(), entry);
        ctx
    }

    pub fn progress(&self, phase: &str, percent: f64, message: &str) {
        let percent = if percent.is_finite() {
            percent.clamp(0.0, 100.0).round()
        } else {
            -1.0
        };
        let mut guard = jobs().lock().unwrap();
        if let Some(entry) = guard.get_mut(&self.id) {
            entry.progress.phase = phase.to_string();
            entry.progress.percent = percent;
            entry.progress.message = message.to_string();
            entry.updated_ms = now_ms();
        }
    }

    pub fn set_child(&self, pid: Option<u32>) {
        let mut guard = jobs().lock().unwrap();
        if let Some(entry) = guard.get_mut(&self.id) {
            entry.child_pid = pid;
            entry.updated_ms = now_ms();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn throw_if_cancelled(&self) -> Result<(), String> {
        if self.is_cancelled() {
            return Err("CANCELLED: 任务已取消".into());
        }
        Ok(())
    }

    pub fn finish(&self) {
        let mut guard = jobs().lock().unwrap();
        if let Some(entry) = guard.get_mut(&self.id) {
            entry.progress.done = true;
            entry.updated_ms = now_ms();
        }
    }
}

pub fn cancel(job_id: &str) -> bool {
    let mut guard = jobs().lock().unwrap();
    if let Some(entry) = guard.get_mut(job_id) {
        entry.cancel.store(true, Ordering::Relaxed);
        let pid = entry.child_pid;
        if let Some(pid) = pid {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .output();
        }
        entry.progress.message = "正在取消…".into();
        entry.updated_ms = now_ms();
        return true;
    }
    false
}

/// 前端轮询：返回所有未过期任务的进度快照。
pub fn poll() -> Vec<JobProgress> {
    let mut guard = jobs().lock().unwrap();
    let now = now_ms();
    let mut result = Vec::new();
    let mut expired = Vec::new();
    for (id, entry) in guard.iter() {
        if entry.progress.done && now.saturating_sub(entry.updated_ms) > 10_000 {
            expired.push(id.clone());
            continue;
        }
        result.push(entry.progress.clone());
    }
    for id in expired {
        guard.remove(&id);
    }
    result
}

// ---------------- 外部工具下载进度 ----------------

pub fn tool_progress(progress: ToolDownloadProgress) {
    *tool_slot().lock().unwrap() = Some((progress, now_ms()));
}

pub fn tool_poll() -> Option<ToolDownloadProgress> {
    let mut guard = tool_slot().lock().unwrap();
    if let Some((progress, updated)) = guard.as_ref() {
        let done = progress.done && now_ms().saturating_sub(*updated) > 10_000;
        let result = progress.clone();
        if done {
            *guard = None;
        }
        return Some(result);
    }
    None
}

pub fn tool_clear() {
    *tool_slot().lock().unwrap() = None;
}

#[cfg(windows)]
trait CreationFlags {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(windows)]
impl CreationFlags for Command {
    fn creation_flags(&mut self, flags: u32) -> &mut Self {
        use std::os::windows::process::CommandExt;
        CommandExt::creation_flags(self, flags)
    }
}
