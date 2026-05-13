use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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
}

pub fn emit(app: &AppHandle, event: PipelineEvent) {
    let _ = app.emit("pipeline-event", event);
}
