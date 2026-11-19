fn main() {
    // 前端资源在编译期嵌入二进制，必须显式声明依赖，避免只改前端时跳过重编译。
    println!("cargo:rerun-if-changed=../dist/index.html");
    println!("cargo:rerun-if-changed=../dist/assets/app.js");
    println!("cargo:rerun-if-changed=../dist/assets/app.css");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
