// Tauri 构建脚本：读取 tauri.conf.json，生成应用上下文所需资源与 Windows 图标。
// 保持默认行为即可；图标路径由 tauri.conf.json 的 bundle.icon 指定。
fn main() {
    tauri_build::build()
}
