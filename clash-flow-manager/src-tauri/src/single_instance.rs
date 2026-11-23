#[cfg(windows)]
use std::ffi::c_void;

#[cfg(windows)]
const ERROR_ALREADY_EXISTS: u32 = 183;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attributes: *mut c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
    fn GetLastError() -> u32;
    fn SetLastError(error: u32);
    fn CloseHandle(handle: *mut c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class_name: *const u16, window_name: *const u16) -> *mut c_void;
    fn ShowWindow(window: *mut c_void, command: i32) -> i32;
    fn SetForegroundWindow(window: *mut c_void) -> i32;
    fn MessageBoxW(window: *mut c_void, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

#[cfg(windows)]
pub(super) struct Guard(*mut c_void);

#[cfg(windows)]
impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
pub(super) fn try_acquire() -> Result<Option<Guard>, u32> {
    let name: Vec<u16> = "Local\\Tinderbox.ClashFlowManager.SingleInstance"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe { SetLastError(0) };
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(unsafe { GetLastError() });
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        focus_existing_window();
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Ok(None);
    }

    Ok(Some(Guard(handle)))
}

#[cfg(windows)]
fn focus_existing_window() {
    let title: Vec<u16> = "Clash 订阅与流量管理\0".encode_utf16().collect();
    let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if !window.is_null() {
        unsafe {
            let _ = ShowWindow(window, 9);
            let _ = SetForegroundWindow(window);
        }
    }
}

#[cfg(windows)]
pub(super) fn show_lock_error(error: u32) {
    let text = format!("无法确认程序是否已运行（Windows 错误 {error}）。程序已停止启动，请重试。");
    let text: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = "Clash 订阅与流量管理\0".encode_utf16().collect();
    unsafe {
        let _ = MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}
