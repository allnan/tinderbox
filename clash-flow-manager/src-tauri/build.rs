fn main() {
    // `tauri-build` watches tauri.conf.json, but the Windows icon is loaded as a
    // build-time resource. Track it explicitly so changing icon.ico relinks the exe.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
