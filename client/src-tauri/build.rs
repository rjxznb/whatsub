use std::env;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Copy whisper.cpp shared-library deps next to the built exe so the
    // whisper-cli sidecar can resolve them at runtime. Tauri's `externalBin`
    // only ships the binary itself; companion DLLs / dylibs need to live
    // alongside it.
    if cfg!(target_os = "windows") {
        copy_companion_files(&[
            "ggml.dll",
            "ggml-base.dll",
            "ggml-cpu.dll",
            "ggml-vulkan.dll",
            "whisper.dll",
        ]);
    } else if cfg!(target_os = "macos") {
        copy_companion_files(&[
            "libwhisper.1.dylib",
            "libggml.dylib",
            "libggml-base.dylib",
            "libggml-cpu.dylib",
            "libggml-metal.dylib",
            // Metal shader bytecode — ggml-metal looks for this next to the
            // executable / in the bundle Resources. In dev mode (running from
            // target/debug/) "next to executable" is what works.
            "ggml-metal.metallib",
        ]);
    }
}

fn copy_companion_files(names: &[&str]) {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR");

    // OUT_DIR is target/{profile}/build/<crate>-<hash>/out — climb to target/{profile}/
    let profile_dir = match PathBuf::from(&out_dir).ancestors().nth(3) {
        Some(p) => p.to_path_buf(),
        None => return,
    };

    let src_dir = PathBuf::from(&manifest_dir).join("binaries");

    for name in names {
        let src = src_dir.join(name);
        let dst = profile_dir.join(name);
        if src.exists() {
            // Best-effort copy; ignore failures (e.g., file in use) so cargo doesn't bail.
            let _ = std::fs::copy(&src, &dst);
            println!("cargo:rerun-if-changed={}", src.display());
        } else {
            println!(
                "cargo:warning=missing whisper companion file: {} (sidecar may fail at runtime)",
                src.display()
            );
        }
    }
}
