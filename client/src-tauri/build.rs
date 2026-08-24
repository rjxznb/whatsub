use std::env;
use std::path::PathBuf;

fn main() {
    tauri_build::build();
    println!("cargo:rerun-if-env-changed=WHATSUB_API_ORIGIN");
    let origin = env::var("WHATSUB_API_ORIGIN")
        .unwrap_or_else(|_| "https://whatsub.eversay.cc".to_string());
    let license_api_base = if origin.starts_with("http://127.0.0.1")
        || origin.starts_with("http://localhost")
    {
        format!("{origin}/api")
    } else {
        format!("{origin}/api/license")
    };
    println!("cargo:rustc-env=WHATSUB_API_ORIGIN={origin}");
    println!("cargo:rustc-env=WHATSUB_LICENSE_API_BASE={license_api_base}");

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
        // whisper-cli @rpath references the major-version names — these are
        // what dyld looks up. Metal shader bytecode is embedded directly into
        // libggml-metal.0.dylib (whisper.cpp builds with
        // GGML_METAL_EMBED_LIBRARY=ON since v1.7+), no separate .metallib.
        copy_companion_files(&[
            "libwhisper.1.dylib",
            "libggml.0.dylib",
            "libggml-base.0.dylib",
            "libggml-blas.0.dylib",
            "libggml-cpu.0.dylib",
            "libggml-metal.0.dylib",
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
