use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// One Vulkan compute device as reported by whisper-cli's startup log.
/// `discrete` is derived from the `uma:` flag (integrated GPUs share system
/// memory → `uma: 1`; discrete cards → `uma: 0`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuDevice {
    pub index: u32,
    pub name: String,
    pub discrete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage")]
pub enum PipelineEvent {
    Started {
        video_id: String,
        /// Source kind ("url" / "local") + raw value, threaded through so
        /// the download queue widget can label an entry the moment it
        /// appears (before yt-dlp has resolved a real title).
        #[serde(skip_serializing_if = "Option::is_none")]
        source_kind: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_value: Option<String>,
        /// True when the import was started in background mode. The
        /// download queue widget filters on this so foreground imports
        /// (which are already shown live inside ImportModal) don't get
        /// duplicated in the queue panel.
        #[serde(skip_serializing_if = "std::ops::Not::not", default)]
        background: bool,
    },
    /// Fine-grained "准备中" sub-step. Emitted by the yt-dlp stderr
    /// scanner when it detects known patterns (resolving URL / fetching
    /// player JS / solving signature / fetching manifest / etc.) so the
    /// UI can show *what specifically* is being slow during the
    /// preparation window between `Started` and the first `Downloading`.
    Preparing {
        video_id: String,
        /// Stable identifier the UI maps to a Chinese label. Known values:
        /// "fetching-webpage", "fetching-player", "solving-signature",
        /// "fetching-manifest", "format-selected". UI shows a fallback
        /// label for unrecognised values so adding new ones is safe.
        step: String,
    },
    Downloading {
        video_id: String,
        percent: u8,
        /// Pretty-printed download speed from yt-dlp (e.g. "1.2MiB/s"). May be
        /// missing during the very first packets before yt-dlp has a sample.
        #[serde(skip_serializing_if = "Option::is_none")]
        speed: Option<String>,
        /// Pretty-printed ETA (e.g. "00:42"). Missing while size is unknown.
        #[serde(skip_serializing_if = "Option::is_none")]
        eta: Option<String>,
        /// Pretty-printed total size (e.g. "458.3MiB"). Missing for live
        /// streams or before the manifest is fully resolved.
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<String>,
    },
    ExtractingAudio {
        video_id: String,
    },
    Transcribing {
        video_id: String,
        percent: u8,
    },
    Transcribed {
        video_id: String,
        srt_path: String,
        duration_sec: f64,
    },
    Failed {
        video_id: String,
        error: String,
    },
    ModelDownload {
        progress: u8,
        total_mb: u64,
        downloaded_mb: u64,
    },
    /// Raw stderr line from a sidecar — shown in the UI's expandable detail
    /// view so the user can see what's happening during phases that don't
    /// emit percent progress (e.g. yt-dlp resolving URLs).
    Log {
        video_id: String,
        source: String,
        line: String,
    },
    /// Emitted once per transcribe call when whisper-cli reports which compute
    /// backend it picked. Frontend persists this in settings.json so the
    /// Settings page can show the user how their machine is accelerating.
    BackendDetected {
        /// Human-readable backend name, e.g. "Vulkan / NVIDIA GeForce RTX 4090"
        /// or "CPU".
        name: String,
    },
    /// Emitted once after an *unfiltered* transcribe run, listing every Vulkan
    /// device whisper-cli enumerated. The frontend persists this inventory to
    /// settings.json (`whisperGpus`) so the Settings page can show the user
    /// which cards exist, and so the next run can pin the discrete GPU via
    /// `GGML_VK_VISIBLE_DEVICES`. Only emitted when the run did NOT already pin
    /// a device (a pinned run only sees 1 device, so the full list would be
    /// lost) and at least one device was found.
    GpuDevices {
        devices: Vec<GpuDevice>,
    },
    /// Burn-in subtitle export progress (ffmpeg re-encode).
    Exporting {
        video_id: String,
        percent: u8,
    },
    /// Burn-in subtitle export finished successfully.
    Exported {
        video_id: String,
        output_path: String,
    },
    /// OSS upload progress for library cloud-sync. `percent` = 720p transcode
    /// 0–99; once transcode is done we emit percent=100 to mean "transcode
    /// finished, PUT in flight" (frontend shows an indeterminate spinner).
    /// `note` lets us break the post-transcode indeterminate phase into
    /// visible sub-steps — added 2026-05-29 because the audio sidecar
    /// extract+upload adds noticeable silent time after the video PUT.
    Uploading {
        video_id: String,
        percent: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

pub fn emit(app: &AppHandle, event: PipelineEvent) {
    let _ = app.emit("pipeline-event", event);
}
