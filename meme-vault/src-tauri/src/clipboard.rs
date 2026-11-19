use std::path::Path;

use crate::models::{ApiResult, AppError};

pub fn copy_image_to_clipboard(app: &tauri::AppHandle, path: &Path) -> ApiResult<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let image = image::open(path)
        .map_err(|error| AppError::new("image", format!("无法读取图片：{}", error)))?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();
    let tauri_image = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
    app.clipboard()
        .write_image(&tauri_image)
        .map_err(|error| AppError::new("clipboard", format!("复制图片失败：{}", error)))
}

#[cfg(windows)]
pub fn copy_file_to_clipboard(path: &Path) -> ApiResult<()> {
    win::set_file_drop_list(path).map_err(|message| AppError::new("clipboard", message))
}

#[cfg(not(windows))]
pub fn copy_file_to_clipboard(_path: &Path) -> ApiResult<()> {
    Err(AppError::new(
        "clipboard",
        "复制文件到剪贴板目前仅支持 Windows，可以改用“复制图片”",
    ))
}

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_HDROP: u32 = 15;

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        pt_x: i32,
        pt_y: i32,
        f_nc: i32,
        f_wide: i32,
    }

    /// 构造 CF_HDROP 需要的 DROPFILES 结构 + 双 null 结尾的宽字符路径。
    fn build_drop_files(path: &Path) -> Vec<u8> {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let struct_size = std::mem::size_of::<DropFiles>();
        let mut buffer = vec![0u8; struct_size + wide.len() * 2];
        unsafe {
            let drop = buffer.as_mut_ptr() as *mut DropFiles;
            (*drop).p_files = struct_size as u32;
            (*drop).pt_x = 0;
            (*drop).pt_y = 0;
            (*drop).f_nc = 0;
            (*drop).f_wide = 1;
            let data = buffer.as_mut_ptr().add(struct_size);
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, data, wide.len() * 2);
        }
        buffer
    }

    pub fn set_file_drop_list(path: &Path) -> Result<(), String> {
        let buffer = build_drop_files(path);

        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, buffer.len());
            if handle.is_null() {
                return Err("无法分配剪贴板内存".to_string());
            }
            let pointer = GlobalLock(handle) as *mut u8;
            if pointer.is_null() {
                return Err("无法锁定剪贴板内存".to_string());
            }
            std::ptr::copy_nonoverlapping(buffer.as_ptr(), pointer, buffer.len());
            GlobalUnlock(handle);

            let mut opened = false;
            for _ in 0..6 {
                if OpenClipboard(std::ptr::null_mut()) != 0 {
                    opened = true;
                    break;
                }
                thread::sleep(Duration::from_millis(30));
            }
            if !opened {
                return Err("系统剪贴板正被其他程序占用，请稍后再试".to_string());
            }
            EmptyClipboard();
            let result = SetClipboardData(CF_HDROP, handle);
            CloseClipboard();
            if result.is_null() {
                return Err("写入文件到剪贴板失败".to_string());
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn builds_file_drop_payload() {
            let path = Path::new("C:\\表情包\\猫猫头.gif");
            let buffer = build_drop_files(path);
            let struct_size = std::mem::size_of::<DropFiles>();
            assert_eq!(u32::from_ne_bytes(buffer[0..4].try_into().unwrap()) as usize, struct_size);
            assert_eq!(i32::from_ne_bytes(buffer[16..20].try_into().unwrap()), 1);
            let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            let payload: Vec<u16> = buffer[struct_size..]
                .chunks_exact(2)
                .map(|chunk| u16::from_ne_bytes([chunk[0], chunk[1]]))
                .collect();
            assert_eq!(&payload[..wide.len()], wide.as_slice());
            assert_eq!(payload[wide.len()], 0);
            assert_eq!(payload.len(), wide.len() + 1);
        }
    }
}
