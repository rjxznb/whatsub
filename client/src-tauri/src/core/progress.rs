use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage")]
pub enum PipelineEvent {
    Started {
        video_id: String,
    },
    Downloading {
        video_id: String,
        percent: u8,
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
}

pub fn emit(app: &AppHandle, event: PipelineEvent) {
    let _ = app.emit("pipeline-event", event);
}
