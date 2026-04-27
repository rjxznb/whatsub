use std::env;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Copy whisper.cpp DLL dependencies next to the built exe so whisper-cli.exe
    // can resolve them at runtime. Tauri's `externalBin` only ships the .exe;
    // companion DLLs need to be alongside it on Windows.
    if cfg!(target_os = "windows") {
        copy_whisper_dlls();
    }
}

fn copy_whisper_dlls() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");

    // OUT_DIR is target/{profile}/build/<crate>-<hash>/out — climb to target/{profile}/
    let profile_dir = match PathBuf::from(&out_dir).ancestors().nth(3) {
        Some(p) => p.to_path_buf(),
        None => return,
    };

    let dll_names = [
        "ggml.dll",
        "ggml-base.dll",
        "ggml-blas.dll",
        "ggml-cpu.dll",
        "libopenblas.dll",
        "whisper.dll",
    ];

    let src_dir = PathBuf::from(&manifest_dir).join("binaries");

    for dll in dll_names {
        let src = src_dir.join(dll);
        let dst = profile_dir.join(dll);
        if src.exists() {
            // Best-effort copy; ignore failures (e.g., file in use) so cargo doesn't bail.
            let _ = std::fs::copy(&src, &dst);
            println!("cargo:rerun-if-changed={}", src.display());
        } else {
            println!(
                "cargo:warning=missing whisper DLL: {} (whisper-cli.exe may fail at runtime)",
                src.display()
            );
        }
    }
}
