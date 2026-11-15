//! 子进程执行：逐行 / 逐块回调、超时与取消（对应 Electron 的 tools.runProcess）。
//!
//! 只依赖 std：父线程轮询 child 状态并消费 reader 线程通过 channel 投递的输出，
//! 回调始终在调用线程执行，避免跨线程借用问题。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// 读取输出时保留的最大字符数（超出后只保留尾部，与 Electron runProcess 一致）。
const MAX_CAPTURE_CHARS: usize = 400_000;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// 子进程回调。默认实现为空，调用方按需覆写。
pub trait ProcessCallbacks {
    fn stdout_line(&mut self, _line: &str) {}
    fn stderr_line(&mut self, _line: &str) {}
    fn stdout_chunk(&mut self, _chunk: &str) {}
    fn stderr_chunk(&mut self, _chunk: &str) {}
}

impl ProcessCallbacks for () {}

/// 一次子进程执行的参数。
pub struct RunSpec<'a> {
    pub bin: &'a Path,
    pub args: &'a [String],
    pub cwd: Option<&'a Path>,
    pub timeout: Option<Duration>,
    pub cancel: Option<&'a AtomicBool>,
}

/// 子进程执行结果。
#[derive(Debug, Default)]
pub struct RunResult {
    pub code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub stdout: String,
    pub stderr: String,
}

impl RunResult {
    /// 退出码是否为 0。
    pub fn success(&self) -> bool {
        self.code == Some(0) && !self.timed_out && !self.cancelled
    }

    /// 取 stderr / stdout 的尾部若干行，用于错误摘要。
    pub fn tail(&self, lines: usize) -> String {
        let text = if self.stderr.trim().is_empty() {
            self.stdout.trim()
        } else {
            self.stderr.trim()
        };
        if text.is_empty() {
            return String::new();
        }
        let all: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
        let start = all.len().saturating_sub(lines);
        all[start..].join(" / ")
    }
}

/// 执行子进程并消费输出。
pub fn run_process(
    spec: &RunSpec<'_>,
    callbacks: &mut dyn ProcessCallbacks,
) -> std::io::Result<RunResult> {
    let mut command = Command::new(spec.bin);
    command
        .args(spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = spec.cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：避免每调用一次工具就闪一个控制台窗口。
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("无法获取子进程 stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("无法获取子进程 stderr"))?;

    let (sender, receiver) = channel::<(bool, String)>();
    let stdout_sender = sender.clone();
    let stderr_sender = sender.clone();
    let stdout_handle = thread::spawn(move || read_stream(stdout, true, stdout_sender));
    let stderr_handle = thread::spawn(move || read_stream(stderr, false, stderr_sender));
    drop(sender);

    let mut state = OutputState::new();
    let mut status: Option<std::process::ExitStatus> = None;
    let mut timed_out = false;
    let mut cancelled = false;
    let start = Instant::now();

    while status.is_none() {
        drain(&receiver, &mut state, callbacks);
        match child.try_wait()? {
            Some(exit) => status = Some(exit),
            None => {
                if let Some(cancel) = spec.cancel {
                    if cancel.load(Ordering::Relaxed) && !cancelled {
                        cancelled = true;
                        let _ = child.kill();
                    }
                }
                if let Some(timeout) = spec.timeout {
                    if !timed_out && start.elapsed() >= timeout {
                        timed_out = true;
                        let _ = child.kill();
                    }
                }
                thread::sleep(POLL_INTERVAL);
            }
        }
    }

    // 子进程退出后管道会很快 EOF；阻塞消费到 reader 线程关闭 channel。
    loop {
        match receiver.recv() {
            Ok((is_stdout, text)) => state.feed(is_stdout, &text, callbacks),
            Err(_) => break,
        }
    }
    let _ = stdout_handle.join();
    let _ = stderr_handle.join();
    state.flush(callbacks);

    let code = status.and_then(|exit| exit.code());
    Ok(RunResult {
        code,
        timed_out,
        cancelled,
        stdout: state.stdout,
        stderr: state.stderr,
    })
}

fn read_stream(mut stream: impl Read, is_stdout: bool, sender: std::sync::mpsc::Sender<(bool, String)>) {
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                let text = String::from_utf8_lossy(&buffer[..size]).into_owned();
                if sender.send((is_stdout, text)).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn drain(
    receiver: &Receiver<(bool, String)>,
    state: &mut OutputState,
    callbacks: &mut dyn ProcessCallbacks,
) {
    loop {
        match receiver.try_recv() {
            Ok((is_stdout, text)) => state.feed(is_stdout, &text, callbacks),
            Err(std::sync::mpsc::TryRecvError::Empty) => break,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
}

struct OutputState {
    stdout: String,
    stderr: String,
    stdout_line: String,
    stderr_line: String,
}

impl OutputState {
    fn new() -> Self {
        OutputState {
            stdout: String::new(),
            stderr: String::new(),
            stdout_line: String::new(),
            stderr_line: String::new(),
        }
    }

    fn feed(&mut self, is_stdout: bool, text: &str, callbacks: &mut dyn ProcessCallbacks) {
        if is_stdout {
            if !text.is_empty() {
                callbacks.stdout_chunk(text);
            }
            push_capped(&mut self.stdout, text);
            split_lines(text, &mut self.stdout_line, &mut |line| callbacks.stdout_line(line));
        } else {
            if !text.is_empty() {
                callbacks.stderr_chunk(text);
            }
            push_capped(&mut self.stderr, text);
            split_lines(text, &mut self.stderr_line, &mut |line| callbacks.stderr_line(line));
        }
    }

    fn flush(&mut self, callbacks: &mut dyn ProcessCallbacks) {
        if !self.stdout_line.is_empty() {
            let line = std::mem::take(&mut self.stdout_line);
            callbacks.stdout_line(&line);
        }
        if !self.stderr_line.is_empty() {
            let line = std::mem::take(&mut self.stderr_line);
            callbacks.stderr_line(&line);
        }
    }
}

/// 按 \r / \n 切分完整行，残留部分留在 buffer。
fn split_lines(text: &str, buffer: &mut String, on_line: &mut dyn FnMut(&str)) {
    for character in text.chars() {
        if character == '\r' || character == '\n' {
            let line = std::mem::take(buffer);
            on_line(&line);
        } else {
            buffer.push(character);
        }
    }
}

fn push_capped(target: &mut String, text: &str) {
    target.push_str(text);
    let length = target.chars().count();
    if length > MAX_CAPTURE_CHARS {
        let skip = length - MAX_CAPTURE_CHARS;
        *target = target.chars().skip(skip).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn split_lines_handles_carriage_return() {
        let mut buffer = String::new();
        let mut lines = Vec::new();
        split_lines("Frame 1/90\rFrame 2/90\nrest", &mut buffer, &mut |line| {
            lines.push(line.to_string())
        });
        assert_eq!(lines, vec!["Frame 1/90", "Frame 2/90"]);
        assert_eq!(buffer, "rest");
    }

    #[test]
    fn runs_simple_process() {
        // 用当前测试可执行文件自身跑 --help 之外的场景不可控，这里仅在 Windows 上调用 cmd /c echo。
        #[cfg(windows)]
        {
            let bin = PathBuf::from("cmd.exe");
            let args = vec!["/c".to_string(), "echo hello".to_string()];
            let result = run_process(
                &RunSpec {
                    bin: &bin,
                    args: &args,
                    cwd: None,
                    timeout: Some(Duration::from_secs(10)),
                    cancel: None,
                },
                &mut (),
            )
            .expect("spawn cmd");
            assert!(result.success());
            assert!(result.stdout.contains("hello"));
        }
    }
}
