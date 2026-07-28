use crate::core::paths;
use crate::core::progress::{emit, PipelineEvent};
use crate::error::{AppError, AppResult};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

static ANALYSIS_SAVE_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const ANALYSIS_GENERATION_STATE_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveAnalysisStatus {
    Applied,
    AlreadyCurrent,
    Rejected,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAnalysisOutcome {
    pub(crate) status: SaveAnalysisStatus,
    pub(crate) generation: Option<String>,
    pub(crate) revision: Option<u64>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisGenerationState {
    version: u8,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    previous_generation: Option<u64>,
    deleted: bool,
    revision: Option<u64>,
    #[serde(default)]
    content_hash: Option<String>,
}

impl AnalysisGenerationState {
    fn active(
        generation: u64,
        previous_generation: Option<u64>,
        revision: Option<u64>,
        content_hash: String,
    ) -> Self {
        Self {
            version: ANALYSIS_GENERATION_STATE_VERSION,
            generation,
            previous_generation,
            deleted: false,
            revision,
            content_hash: Some(content_hash),
        }
    }

    fn tombstone(generation: u64, revision: Option<u64>) -> Self {
        Self {
            version: ANALYSIS_GENERATION_STATE_VERSION,
            generation,
            previous_generation: None,
            deleted: true,
            revision,
            content_hash: None,
        }
    }
}

#[tauri::command]
/// Save contract:
/// - normal mutation: `generation` is the current opaque epoch;
/// - generation CAS: `expected_generation` is current and Rust advances it;
/// - neither: initialize an absent state or prove exact idempotent content.
/// Supplying both identities, a stale identity, or changed content without an
/// identity returns `Rejected` without replacing user-visible analysis.
pub async fn save_analysis(
    video_id: String,
    analysis: Value,
    generation: Option<String>,
    expected_generation: Option<String>,
) -> AppResult<SaveAnalysisOutcome> {
    let path = paths::video_dir(&video_id)?.join("analysis.json");
    save_analysis_path_for_generation(
        &path,
        analysis,
        generation.as_deref(),
        expected_generation.as_deref(),
    )
    .await
}

#[cfg(test)]
async fn save_analysis_path(path: &Path, analysis: Value) -> AppResult<SaveAnalysisOutcome> {
    let generation = current_generation_token(path)?;
    save_analysis_path_for_generation(path, analysis, generation.as_deref(), None).await
}

async fn save_analysis_path_for_generation(
    path: &Path,
    analysis: Value,
    generation: Option<&str>,
    expected_generation: Option<&str>,
) -> AppResult<SaveAnalysisOutcome> {
    let _guard = ANALYSIS_SAVE_GATE.lock().await;
    save_analysis_value_for_generation(path, analysis, generation, expected_generation)
}

#[derive(Clone, Copy)]
struct AnalysisVersion<'a> {
    fingerprint: &'a str,
    revision: u64,
}

fn analysis_version(analysis: &Value) -> Option<AnalysisVersion<'_>> {
    let checkpoint = analysis.get("checkpoint")?;
    Some(AnalysisVersion {
        fingerprint: checkpoint.get("transcriptFingerprint")?.as_str()?,
        revision: checkpoint.get("revision")?.as_u64()?,
    })
}

#[cfg(test)]
fn save_analysis_value(path: &Path, analysis: Value) -> AppResult<SaveAnalysisOutcome> {
    let generation = current_generation_token(path)?;
    save_analysis_value_for_generation(path, analysis, generation.as_deref(), None)
}

fn save_analysis_value_for_generation(
    path: &Path,
    analysis: Value,
    generation: Option<&str>,
    expected_generation: Option<&str>,
) -> AppResult<SaveAnalysisOutcome> {
    save_analysis_value_for_generation_with_replacer(
        path,
        analysis,
        generation,
        expected_generation,
        replace_analysis_file,
    )
}

#[cfg(test)]
fn save_analysis_value_with_replacer<F>(
    path: &Path,
    analysis: Value,
    replacer: F,
) -> AppResult<SaveAnalysisOutcome>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let generation = current_generation_token(path)?;
    save_analysis_value_for_generation_with_replacer(
        path,
        analysis,
        generation.as_deref(),
        None,
        replacer,
    )
}

fn save_analysis_value_for_generation_with_replacer<F>(
    path: &Path,
    analysis: Value,
    generation: Option<&str>,
    expected_generation: Option<&str>,
    replacer: F,
) -> AppResult<SaveAnalysisOutcome>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    recover_interrupted_replacement(path, &temporary, &backup)?;
    let incoming_version = analysis_version(&analysis);
    let incoming_revision = incoming_version.map(|version| version.revision);
    let incoming_hash = analysis_content_hash(&analysis)?;
    let current_analysis = if path.exists() {
        let current: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
        Some(current)
    } else {
        None
    };
    let mut state = ensure_generation_state(
        path,
        read_generation_state_for_mutation(path)?,
        current_analysis.as_ref(),
    )?;

    if state.is_none() {
        if generation.is_some_and(|token| parse_generation_token(token) != Some(1))
            || expected_generation.is_some()
        {
            return Ok(save_outcome(SaveAnalysisStatus::Rejected, None, None));
        }
        let initial =
            AnalysisGenerationState::active(1, None, incoming_revision, incoming_hash.clone());
        write_generation_state(path, &initial)?;
        state = Some(initial);
    }

    let mut state = state.expect("generation state initialized");
    let reject = |state: &AnalysisGenerationState| {
        Ok(save_outcome(
            SaveAnalysisStatus::Rejected,
            Some(state.generation),
            state.revision,
        ))
    };

    if generation.is_some() && expected_generation.is_some() {
        return reject(&state);
    }

    if let Some(expected) = expected_generation {
        let Some(expected) = parse_generation_token(expected) else {
            return reject(&state);
        };
        if incoming_version.is_some_and(|version| version.revision != 0) {
            return reject(&state);
        }

        let started_generation = expected == state.generation;
        if started_generation {
            let next_generation = state.generation.checked_add(1).ok_or_else(|| {
                AppError::Other("analysis generation epoch exhausted".to_string())
            })?;
            state = AnalysisGenerationState::active(
                next_generation,
                Some(expected),
                incoming_revision,
                incoming_hash.clone(),
            );
            write_generation_state(path, &state)?;
        } else if state.previous_generation != Some(expected)
            || state.deleted
            || state.content_hash.as_deref() != Some(incoming_hash.as_str())
        {
            return reject(&state);
        }

        if current_analysis.as_ref() == Some(&analysis) {
            return Ok(save_outcome(
                if started_generation {
                    SaveAnalysisStatus::Applied
                } else {
                    SaveAnalysisStatus::AlreadyCurrent
                },
                Some(state.generation),
                incoming_revision,
            ));
        }
        write_json_atomically_with_replacer(path, &analysis, replacer)?;
        return Ok(save_outcome(
            SaveAnalysisStatus::Applied,
            Some(state.generation),
            incoming_revision,
        ));
    }

    if state.deleted {
        return reject(&state);
    }

    let current_hash = current_analysis
        .as_ref()
        .map(analysis_content_hash)
        .transpose()?;
    let current_is_authoritative = current_hash.as_deref() == state.content_hash.as_deref();

    let Some(generation) = generation else {
        if current_is_authoritative && current_analysis.as_ref() == Some(&analysis) {
            return Ok(save_outcome(
                SaveAnalysisStatus::AlreadyCurrent,
                Some(state.generation),
                state.revision,
            ));
        }
        if current_analysis.is_none()
            && state.content_hash.as_deref() == Some(incoming_hash.as_str())
        {
            write_json_atomically_with_replacer(path, &analysis, replacer)?;
            return Ok(save_outcome(
                SaveAnalysisStatus::Applied,
                Some(state.generation),
                incoming_revision,
            ));
        }
        return reject(&state);
    };

    if parse_generation_token(generation) != Some(state.generation) {
        return reject(&state);
    }

    if !current_is_authoritative {
        if state.content_hash.as_deref() == Some(incoming_hash.as_str()) {
            if current_analysis.as_ref() != Some(&analysis) {
                write_json_atomically_with_replacer(path, &analysis, replacer)?;
            }
            return Ok(save_outcome(
                SaveAnalysisStatus::Applied,
                Some(state.generation),
                incoming_revision,
            ));
        }
        if current_analysis.as_ref() == Some(&analysis) {
            state.revision = incoming_revision;
            state.content_hash = Some(incoming_hash);
            write_generation_state(path, &state)?;
            return Ok(save_outcome(
                SaveAnalysisStatus::AlreadyCurrent,
                Some(state.generation),
                incoming_revision,
            ));
        }
        return reject(&state);
    }

    if current_analysis.as_ref() == Some(&analysis) {
        return Ok(save_outcome(
            SaveAnalysisStatus::AlreadyCurrent,
            Some(state.generation),
            state.revision,
        ));
    }

    let current_version = current_analysis.as_ref().and_then(analysis_version);
    if let Some(current) = current_version {
        let Some(incoming) = incoming_version else {
            return reject(&state);
        };
        if incoming.fingerprint != current.fingerprint || incoming.revision <= current.revision {
            return reject(&state);
        }
    }

    write_json_atomically_with_replacer(path, &analysis, replacer)?;
    state.revision = incoming_revision;
    state.content_hash = Some(incoming_hash);
    write_generation_state(path, &state)?;
    Ok(save_outcome(
        SaveAnalysisStatus::Applied,
        Some(state.generation),
        incoming_revision,
    ))
}

fn save_outcome(
    status: SaveAnalysisStatus,
    generation: Option<u64>,
    revision: Option<u64>,
) -> SaveAnalysisOutcome {
    SaveAnalysisOutcome {
        status,
        generation: generation.map(generation_token),
        revision,
    }
}

fn generation_token(generation: u64) -> String {
    format!("generation-{generation}")
}

fn parse_generation_token(token: &str) -> Option<u64> {
    let generation = token.strip_prefix("generation-")?.parse().ok()?;
    (generation_token(generation) == token).then_some(generation)
}

fn analysis_content_hash(analysis: &Value) -> AppResult<String> {
    let bytes = serde_json::to_vec(analysis)?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

#[cfg(test)]
fn current_generation_token(path: &Path) -> AppResult<Option<String>> {
    Ok(read_generation_state_for_mutation(path)?
        .filter(|state| state.generation > 0)
        .map(|state| generation_token(state.generation)))
}

fn ensure_generation_state(
    path: &Path,
    state: Option<AnalysisGenerationState>,
    current_analysis: Option<&Value>,
) -> AppResult<Option<AnalysisGenerationState>> {
    let Some(mut state) = state else {
        if let Some(analysis) = current_analysis {
            let state = AnalysisGenerationState::active(
                1,
                None,
                analysis_version(analysis).map(|version| version.revision),
                analysis_content_hash(analysis)?,
            );
            write_generation_state(path, &state)?;
            return Ok(Some(state));
        }
        return Ok(None);
    };

    if state.version < ANALYSIS_GENERATION_STATE_VERSION || state.generation == 0 {
        state.version = ANALYSIS_GENERATION_STATE_VERSION;
        if state.generation == 0 {
            state.generation = 1;
            state.previous_generation = None;
        }
        if state.deleted {
            state.content_hash = None;
        } else if state.content_hash.is_none() {
            state.content_hash = current_analysis.map(analysis_content_hash).transpose()?;
        }
        write_generation_state(path, &state)?;
    } else if !state.deleted && state.content_hash.is_none() {
        state.content_hash = current_analysis.map(analysis_content_hash).transpose()?;
        write_generation_state(path, &state)?;
    }
    Ok(Some(state))
}

fn generation_state_path(analysis_path: &Path) -> PathBuf {
    analysis_path.with_file_name("analysis.generation.json")
}

fn read_generation_state_for_mutation(
    analysis_path: &Path,
) -> AppResult<Option<AnalysisGenerationState>> {
    let state_path = generation_state_path(analysis_path);
    recover_interrupted_replacement(
        &state_path,
        &state_path.with_extension("json.tmp"),
        &state_path.with_extension("json.bak"),
    )?;
    read_generation_state_file(&state_path)
}

#[cfg(test)]
fn read_generation_state_snapshot(
    analysis_path: &Path,
) -> AppResult<Option<AnalysisGenerationState>> {
    let state_path = generation_state_path(analysis_path);
    for candidate in [state_path.clone(), state_path.with_extension("json.bak")] {
        if candidate.exists() {
            return read_generation_state_file(&candidate);
        }
    }
    Ok(None)
}

fn read_generation_state_file(path: &Path) -> AppResult<Option<AnalysisGenerationState>> {
    if !path.exists() {
        return Ok(None);
    }
    let state: AnalysisGenerationState = serde_json::from_str(&fs::read_to_string(path)?)?;
    if state.version != 1 && state.version != ANALYSIS_GENERATION_STATE_VERSION {
        return Err(AppError::InvalidInput(format!(
            "unsupported analysis generation state version {}",
            state.version
        )));
    }
    Ok(Some(state))
}

fn write_generation_state(analysis_path: &Path, state: &AnalysisGenerationState) -> AppResult<()> {
    let value = serde_json::to_value(state)?;
    write_json_atomically_with_replacer(
        &generation_state_path(analysis_path),
        &value,
        replace_analysis_file,
    )
}

fn write_json_atomically_with_replacer<F>(path: &Path, value: &Value, replacer: F) -> AppResult<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    recover_interrupted_replacement(path, &temporary, &backup)?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let write_result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }

    if let Err(error) = replacer(&temporary, path) {
        recover_failed_replacement(path, &temporary, &backup)?;
        return Err(error.into());
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn recover_interrupted_replacement(
    destination: &Path,
    temporary: &Path,
    backup: &Path,
) -> std::io::Result<()> {
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(backup)?;
        }
        if temporary.exists() {
            fs::remove_file(temporary)?;
        }
    } else if backup.exists() {
        fs::rename(backup, destination)?;
        if temporary.exists() {
            fs::remove_file(temporary)?;
        }
    } else if temporary.exists() {
        let bytes = fs::read(temporary)?;
        if serde_json::from_slice::<Value>(&bytes).is_ok() {
            fs::rename(temporary, destination)?;
        } else {
            fs::remove_file(temporary)?;
        }
    }
    Ok(())
}

fn recover_failed_replacement(
    destination: &Path,
    temporary: &Path,
    backup: &Path,
) -> std::io::Result<()> {
    if destination.exists() {
        if temporary.exists() {
            fs::remove_file(temporary)?;
        }
        if backup.exists() {
            fs::remove_file(backup)?;
        }
    } else if backup.exists() {
        fs::rename(backup, destination)?;
        if temporary.exists() {
            fs::remove_file(temporary)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn replace_analysis_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    if !destination.exists() {
        return fs::rename(temporary, destination);
    }

    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let temporary_wide: Vec<u16> = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let backup = destination.with_extension("json.bak");
    let backup_wide: Vec<u16> = backup
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let replaced = unsafe {
        ReplaceFileW(
            destination_wide.as_ptr(),
            temporary_wide.as_ptr(),
            backup_wide.as_ptr(),
            0,
            ptr::null(),
            ptr::null(),
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_analysis_file(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(temporary, destination)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadAnalysisOutcome {
    analysis: Option<Value>,
    generation: Option<String>,
}

#[tauri::command]
pub async fn load_analysis(video_id: String) -> AppResult<Option<Value>> {
    Ok(load_analysis_state(video_id).await?.analysis)
}

#[tauri::command]
pub async fn load_analysis_state(video_id: String) -> AppResult<LoadAnalysisOutcome> {
    let path = paths::video_dir(&video_id)?.join("analysis.json");
    load_analysis_state_path(&path).await
}

async fn load_analysis_state_path(path: &Path) -> AppResult<LoadAnalysisOutcome> {
    let _guard = ANALYSIS_SAVE_GATE.lock().await;
    recover_interrupted_replacement(
        path,
        &path.with_extension("json.tmp"),
        &path.with_extension("json.bak"),
    )?;
    let analysis = if path.exists() {
        Some(serde_json::from_str::<Value>(&fs::read_to_string(path)?)?)
    } else {
        None
    };
    let state = ensure_generation_state(
        path,
        read_generation_state_for_mutation(path)?,
        analysis.as_ref(),
    )?;
    let generation = state
        .as_ref()
        .map(|state| generation_token(state.generation));
    if state.as_ref().is_some_and(|state| state.deleted) {
        return Ok(LoadAnalysisOutcome {
            analysis: None,
            generation,
        });
    }
    let analysis = match (state.as_ref(), analysis) {
        (Some(state), Some(analysis))
            if state.content_hash.as_deref()
                == Some(analysis_content_hash(&analysis)?.as_str()) =>
        {
            Some(analysis)
        }
        (None, analysis) => analysis,
        _ => None,
    };
    Ok(LoadAnalysisOutcome {
        analysis,
        generation,
    })
}

#[cfg(test)]
fn load_analysis_path(path: &Path) -> AppResult<Option<Value>> {
    let state = read_generation_state_snapshot(path)?;
    if state.as_ref().is_some_and(|state| state.deleted) {
        return Ok(None);
    }
    if !path.exists() {
        return Ok(None);
    }
    let analysis: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    if let Some(state) = state {
        if state.content_hash.as_deref() != Some(analysis_content_hash(&analysis)?.as_str()) {
            return Ok(None);
        }
    }
    Ok(Some(analysis))
}

/// Remove a video's analysis.json. Used by the "重新解析" flow so a
/// re-transcribe re-runs the LLM from scratch instead of the loader
/// short-circuiting to the (now stale) cached analysis. Best-effort:
/// a missing file is success.
#[tauri::command]
pub async fn delete_analysis(video_id: String) -> AppResult<SaveAnalysisOutcome> {
    let path = paths::video_dir(&video_id)?.join("analysis.json");
    delete_analysis_path(&path).await
}

async fn delete_analysis_path(path: &Path) -> AppResult<SaveAnalysisOutcome> {
    let _guard = ANALYSIS_SAVE_GATE.lock().await;
    recover_interrupted_replacement(
        path,
        &path.with_extension("json.tmp"),
        &path.with_extension("json.bak"),
    )?;
    let current_analysis = if path.exists() {
        Some(serde_json::from_str::<Value>(&fs::read_to_string(path)?)?)
    } else {
        None
    };
    let state = ensure_generation_state(
        path,
        read_generation_state_for_mutation(path)?,
        current_analysis.as_ref(),
    )?;
    let revision = current_analysis
        .as_ref()
        .and_then(analysis_version)
        .map(|version| version.revision)
        .or_else(|| state.as_ref().and_then(|state| state.revision));

    if let Some(state) = state.as_ref() {
        // Persist the retirement before removing the user-visible file. Loads
        // treat this record as authoritative, including after process restart.
        write_generation_state(
            path,
            &AnalysisGenerationState::tombstone(state.generation, revision),
        )?;
    }

    for candidate in [
        path.to_path_buf(),
        path.with_extension("json.tmp"),
        path.with_extension("json.bak"),
    ] {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(save_outcome(
        SaveAnalysisStatus::Applied,
        state.as_ref().map(|state| state.generation),
        revision,
    ))
}

#[tauri::command]
pub fn load_transcript(video_id: String) -> AppResult<Option<String>> {
    let path = paths::video_dir(&video_id)?.join("transcript.srt");
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&path)?))
}

#[tauri::command]
pub fn video_source_path(video_id: String) -> AppResult<String> {
    let path = paths::video_dir(&video_id)?.join("source.mp4");
    // Only report a path that actually exists. After a video is deleted the
    // dir is gone, but callers (e.g. the corpus PhrasePlayer) would otherwise
    // get a stale path and try to play a missing file → a black/broken player.
    // Returning NotFound lets them show a proper "源视频已删除" placeholder.
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "source video not found for {video_id}"
        )));
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> AppResult<()> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, content)?;
    Ok(())
}

/// Shared state used by the burn-in export command so a separate `cancel_export`
/// invocation can SIGTERM the running ffmpeg process. There's only ever at most
/// one export running at a time (UI prevents starting another).
#[derive(Default)]
pub struct ExportState {
    child: Mutex<Option<CommandChild>>,
    cancel_requested: AtomicBool,
}

/// Escape a path for use inside ffmpeg's `-vf subtitles='...'` filter argument.
/// Filter syntax uses `:` to separate options and `\` for escapes, so colons
/// in Windows drive letters and any backslashes need handling.
fn escape_for_subtitles_filter(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\:")
}

/// Burn an ASS subtitle into the video, re-encoding video with libx264 and
/// audio with AAC. Audio is ALWAYS transcoded (not -c:a copy) so the output
/// MP4 is universally playable — Opus-in-MP4 from yt-dlp downloads silently
/// fails on a lot of Windows/phone players.
#[tauri::command]
/// `quality`: one of `"high"` / `"standard"` / `"smooth"` (or omitted → default
/// "standard"). Maps to libx264 CRF + preset:
///   "high"     → CRF 18, preset slow    (visually lossless, ~2× file size)
///   "standard" → CRF 22, preset medium  (default, decent balance)
///   "smooth"   → CRF 26, preset fast    (smaller file, fastest encode)
/// Ignored when ass_content is empty (stream copy is always lossless).
pub async fn export_burned_video(
    app: AppHandle,
    state: State<'_, ExportState>,
    video_id: String,
    ass_content: String,
    output_path: String,
    duration_sec: f64,
    quality: Option<String>,
) -> AppResult<()> {
    // Reject overlapping exports — UI should prevent this but guard anyway.
    if state.child.lock().unwrap().is_some() {
        return Err(AppError::Other("已有导出任务正在进行".into()));
    }
    state.cancel_requested.store(false, Ordering::Relaxed);

    let video_dir = paths::video_dir(&video_id)?;
    let source = video_dir.join("source.mp4");
    if !source.exists() {
        return Err(AppError::NotFound(format!(
            "source.mp4 not found for {video_id}"
        )));
    }

    // Empty ass_content → user wants the original video copy without
    // any subtitle burn-in. Skip the subtitles filter entirely and use
    // stream copy (`-c copy`) — no re-encoding, runs in seconds instead
    // of minutes-to-hours.
    let burn_subtitles = !ass_content.is_empty();
    let ass_path = video_dir.join("_export.ass");
    let vf;
    if burn_subtitles {
        // Write the ASS to a sibling temp file. We delete it on both success
        // and failure so the library dir doesn't accumulate junk.
        fs::write(&ass_path, &ass_content)?;
        let escaped = escape_for_subtitles_filter(&ass_path.to_string_lossy());
        vf = format!("subtitles='{}'", escaped);
    } else {
        vf = String::new();
    }

    let source_str = source.to_string_lossy().to_string();
    // Progress comes from ffmpeg's standard stderr "time=HH:MM:SS.cs" line —
    // more reliable than `-progress pipe:1` (which gets block-buffered through
    // Tauri's shell pipe on Windows). `-stats_period 0.5` makes ffmpeg print
    // progress twice a second instead of the default 0.5s..2s heuristic.
    // Map user-facing quality preset → libx264 CRF + preset.
    // CRF: lower = higher quality, exponentially larger files
    //   18 ≈ visually lossless; 23 = libx264 default; 28 = noticeably soft
    let (crf, preset) = match quality.as_deref() {
        Some("high") => ("18", "slow"),
        Some("smooth") => ("26", "fast"),
        _ => ("22", "medium"),
    };

    let args: Vec<&str> = if burn_subtitles {
        vec![
            "-y",
            "-i", &source_str,
            "-vf", &vf,
            "-c:v", "libx264",
            "-crf", crf,
            "-preset", preset,
            // Audio: always transcode to AAC so the output MP4 plays on every
            // platform regardless of source codec (yt-dlp often delivers Opus).
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
            "-stats_period", "0.5",
            &output_path,
        ]
    } else {
        // Stream copy — no re-encoding. Both video and audio bytes are
        // copied as-is; container is rewritten to MP4 (`-f mp4` is
        // implicit from .mp4 output). 5-50× faster than the burn-in
        // path because ffmpeg never decodes or re-encodes a single
        // frame.
        vec![
            "-y",
            "-i", &source_str,
            "-c", "copy",
            "-stats_period", "0.5",
            &output_path,
        ]
    };

    let cmd = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Subprocess(format!("sidecar ffmpeg: {e}")))?
        .args(&args);

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| AppError::Subprocess(format!("spawn ffmpeg: {e}")))?;

    *state.child.lock().unwrap() = Some(child);

    // Track last emitted percent to avoid flooding the event bus.
    let mut last_percent: u8 = 255;
    let mut stderr_tail: VecDeque<String> = VecDeque::new();
    let mut exit_code: Option<i32> = None;
    // ffmpeg's per-frame progress line is one long line (with \r between
    // updates, not \n) — buffer the active line and parse on each refresh.
    let mut stderr_buf = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                // ffmpeg may write to stdout if we ever wire `-progress pipe:1`;
                // tee whatever shows up to the log channel for diagnostics.
                let chunk = String::from_utf8_lossy(&bytes).to_string();
                for line in chunk.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    emit(
                        &app,
                        PipelineEvent::Log {
                            video_id: video_id.clone(),
                            source: "ffmpeg-stdout".into(),
                            line: trimmed.into(),
                        },
                    );
                }
            }
            CommandEvent::Stderr(bytes) => {
                let chunk = String::from_utf8_lossy(&bytes).to_string();
                stderr_buf.push_str(&chunk);
                // ffmpeg uses '\r' to overwrite the live progress line. We
                // split on both '\n' and '\r' so each refresh is a complete
                // unit we can parse / log.
                let pieces: Vec<&str> = stderr_buf.split(|c: char| c == '\n' || c == '\r').collect();
                let last = pieces.last().copied().unwrap_or("").to_string();
                for piece in &pieces[..pieces.len().saturating_sub(1)] {
                    let trimmed = piece.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if stderr_tail.len() >= 30 {
                        stderr_tail.pop_front();
                    }
                    stderr_tail.push_back(trimmed.to_string());
                    // Surface every stderr line as a Log event so the UI can
                    // show ffmpeg's banner + per-frame status. The frontend
                    // can throttle / filter as it sees fit.
                    emit(
                        &app,
                        PipelineEvent::Log {
                            video_id: video_id.clone(),
                            source: "ffmpeg".into(),
                            line: trimmed.into(),
                        },
                    );
                    if let Some(secs) = extract_time_field(trimmed) {
                        if duration_sec > 0.0 {
                            let pct = ((secs / duration_sec) * 100.0)
                                .clamp(0.0, 99.0) as u8;
                            if pct != last_percent {
                                last_percent = pct;
                                emit(
                                    &app,
                                    PipelineEvent::Exporting {
                                        video_id: video_id.clone(),
                                        percent: pct,
                                    },
                                );
                            }
                        }
                    }
                }
                stderr_buf = last;
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    *state.child.lock().unwrap() = None;
    let cancelled = state.cancel_requested.swap(false, Ordering::Relaxed);

    // Best-effort cleanup of the temp ASS, regardless of outcome.
    let _ = fs::remove_file(&ass_path);

    if cancelled {
        // User pressed cancel → kill produced a non-zero exit; treat as
        // success-with-no-output and remove any partial output file.
        let _ = fs::remove_file(&output_path);
        return Err(AppError::Other("用户已取消导出".into()));
    }

    match exit_code {
        Some(0) => {
            emit(
                &app,
                PipelineEvent::Exported {
                    video_id,
                    output_path,
                },
            );
            Ok(())
        }
        Some(c) => {
            let tail = stderr_tail
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let _ = fs::remove_file(&output_path);
            Err(AppError::Subprocess(format!(
                "ffmpeg exit {c}\n--- ffmpeg stderr (last {} lines) ---\n{}",
                stderr_tail.len(),
                tail
            )))
        }
        None => Err(AppError::Subprocess(
            "ffmpeg terminated abnormally".into(),
        )),
    }
}

/// Cancel an in-flight export. Sets the cancel flag (so the export command
/// reports cancellation rather than treating the kill as a generic failure)
/// and SIGTERMs the ffmpeg child.
#[tauri::command]
pub fn cancel_export(state: State<'_, ExportState>) -> AppResult<()> {
    state.cancel_requested.store(true, Ordering::Relaxed);
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    Ok(())
}

/// Extract the `time=HH:MM:SS.cs` field from a single ffmpeg stderr status
/// line and return it as seconds. Status lines look like:
/// `frame=  123 fps=45 q=28.0 size=    256kB time=00:00:04.10 bitrate=...`
pub(crate) fn extract_time_field(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let token = rest
        .split_whitespace()
        .next()?
        .trim_end_matches(',');
    if token == "N/A" {
        return None;
    }
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "whatsub-analysis-{name}-{}-{sequence}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn analysis_path(&self) -> PathBuf {
            self.0.join("analysis.json")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn checkpointed(revision: u64, marker: &str) -> Value {
        checkpointed_generation("sha256:current", revision, marker)
    }

    fn checkpointed_generation(fingerprint: &str, revision: u64, marker: &str) -> Value {
        json!({
            "marker": marker,
            "checkpoint": {
                "version": 1,
                "transcriptFingerprint": fingerprint,
                "revision": revision
            }
        })
    }

    fn legacy(marker: &str) -> Value {
        json!({ "marker": marker })
    }

    fn read_analysis(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn read_revision(path: &Path) -> Option<u64> {
        read_analysis(path)
            .get("checkpoint")
            .and_then(|checkpoint| checkpoint.get("revision"))
            .and_then(Value::as_u64)
    }

    #[test]
    fn parses_ffmpeg_progress_line() {
        let line = "frame=  123 fps=45 q=28.0 size=    256kB time=00:00:04.10 bitrate=512.0kbits/s speed=1.2x";
        assert_eq!(extract_time_field(line), Some(4.10));
    }

    #[test]
    fn handles_na_time() {
        assert_eq!(extract_time_field("frame=0 time=N/A bitrate=N/A"), None);
    }

    #[test]
    fn rejects_lines_without_time() {
        assert_eq!(extract_time_field("ffmpeg version 6.0 Copyright (c) ..."), None);
    }

    #[test]
    fn save_outcome_serializes_the_generation_ipc_contract() {
        let outcome = save_outcome(
            SaveAnalysisStatus::AlreadyCurrent,
            Some(7),
            Some(4),
        );

        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            json!({
                "status": "alreadyCurrent",
                "generation": "generation-7",
                "revision": 4
            })
        );
    }

    #[test]
    fn newer_revision_wins_and_stale_revision_leaves_no_temp_file() {
        let dir = TestDir::new("stale");
        let path = dir.analysis_path();

        let newer = save_analysis_value(&path, checkpointed(2, "newer")).unwrap();
        let stale = save_analysis_value(&path, checkpointed(1, "stale")).unwrap();

        assert_eq!(newer.status, SaveAnalysisStatus::Applied);
        assert_eq!(newer.revision, Some(2));
        assert_eq!(stale.status, SaveAnalysisStatus::Rejected);
        assert_eq!(stale.revision, Some(2));
        assert_eq!(read_revision(&path), Some(2));
        assert_eq!(read_analysis(&path)["marker"], "newer");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn equal_revision_is_rejected_without_replacing_content() {
        let dir = TestDir::new("equal");
        let path = dir.analysis_path();
        save_analysis_value(&path, checkpointed(4, "first")).unwrap();

        let outcome = save_analysis_value(&path, checkpointed(4, "equal")).unwrap();

        assert_eq!(outcome.status, SaveAnalysisStatus::Rejected);
        assert_eq!(outcome.revision, Some(4));
        assert_eq!(read_analysis(&path)["marker"], "first");
    }

    #[test]
    fn explicit_generation_reset_accepts_revision_zero_for_a_new_fingerprint() {
        let dir = TestDir::new("generation-reset");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:old", 8, "old-generation"),
        )
        .unwrap();

        let outcome = save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:new", 0, "new-generation"),
            None,
            Some("generation-1"),
        )
        .unwrap();

        assert_eq!(outcome.status, SaveAnalysisStatus::Applied);
        assert_eq!(outcome.generation.as_deref(), Some("generation-2"));
        assert_eq!(outcome.revision, Some(0));
        assert_eq!(read_analysis(&path)["marker"], "new-generation");

        let newer = save_analysis_value(
            &path,
            checkpointed_generation("sha256:new", 2, "new-generation-revision-2"),
        )
        .unwrap();
        let stale = save_analysis_value(
            &path,
            checkpointed_generation("sha256:new", 1, "new-generation-stale"),
        )
        .unwrap();
        assert_eq!(newer.status, SaveAnalysisStatus::Applied);
        assert_eq!(stale.status, SaveAnalysisStatus::Rejected);
        assert_eq!(read_analysis(&path)["marker"], "new-generation-revision-2");
    }

    #[test]
    fn same_transcript_can_start_a_fresh_generation() {
        let dir = TestDir::new("same-transcript-new-generation");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:same", 8, "first-generation"),
        )
        .unwrap();

        let reset = save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:same", 0, "second-generation"),
            None,
            Some("generation-1"),
        )
        .unwrap();

        assert_eq!(reset.status, SaveAnalysisStatus::Applied);
        assert_eq!(reset.generation.as_deref(), Some("generation-2"));
        assert_eq!(read_analysis(&path)["marker"], "second-generation");
    }

    #[test]
    fn byte_identical_cas_still_reports_a_new_generation_applied() {
        let dir = TestDir::new("identical-content-new-generation");
        let path = dir.analysis_path();
        let analysis = checkpointed_generation("sha256:same", 0, "same-content");
        save_analysis_value(&path, analysis.clone()).unwrap();

        let reset = save_analysis_value_for_generation(&path, analysis, None, Some("generation-1"))
            .unwrap();

        assert_eq!(reset.status, SaveAnalysisStatus::Applied);
        assert_eq!(reset.generation.as_deref(), Some("generation-2"));
    }

    #[test]
    fn a_to_b_to_a_rejects_delayed_work_from_the_original_a() {
        let dir = TestDir::new("generation-aba");
        let path = dir.analysis_path();
        save_analysis_value(&path, checkpointed_generation("sha256:a", 8, "original-a")).unwrap();
        save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:b", 0, "generation-b"),
            None,
            Some("generation-1"),
        )
        .unwrap();
        save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:a", 0, "new-a"),
            None,
            Some("generation-2"),
        )
        .unwrap();

        let delayed = save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:a", 9, "delayed-original-a"),
            Some("generation-1"),
            None,
        )
        .unwrap();

        assert_eq!(delayed.status, SaveAnalysisStatus::Rejected);
        assert_eq!(read_analysis(&path)["marker"], "new-a");
    }

    #[test]
    fn generation_tokens_are_compared_in_canonical_form() {
        let dir = TestDir::new("generation-token-canonical");
        let path = dir.analysis_path();
        save_analysis_value(&path, checkpointed(1, "current")).unwrap();

        let aliased = save_analysis_value_for_generation(
            &path,
            checkpointed(2, "aliased-token"),
            Some("generation-01"),
            None,
        )
        .unwrap();

        assert_eq!(aliased.status, SaveAnalysisStatus::Rejected);
        assert_eq!(read_analysis(&path)["marker"], "current");
    }

    #[test]
    fn identical_equal_revision_is_an_idempotent_success() {
        let dir = TestDir::new("equal-idempotent");
        let path = dir.analysis_path();
        let analysis = checkpointed(4, "same-content");
        save_analysis_value(&path, analysis.clone()).unwrap();

        let retry = save_analysis_value(&path, analysis).unwrap();

        assert_eq!(retry.status, SaveAnalysisStatus::AlreadyCurrent);
        assert_eq!(read_analysis(&path)["marker"], "same-content");
    }

    #[test]
    fn cloud_retry_after_a_later_materialization_failure_is_already_current() {
        let dir = TestDir::new("cloud-materialization-retry");
        let path = dir.analysis_path();
        let analysis = checkpointed(4, "cloud-content");

        let first =
            save_analysis_value_for_generation(&path, analysis.clone(), None, None).unwrap();
        assert_eq!(first.status, SaveAnalysisStatus::Applied);
        let later_step: Result<(), &str> = Err("injected transcript write failure");
        assert!(later_step.is_err());

        let retry = save_analysis_value_for_generation(&path, analysis, None, None).unwrap();
        assert_eq!(retry.status, SaveAnalysisStatus::AlreadyCurrent);
        assert_eq!(retry.generation.as_deref(), Some("generation-1"));

        let different = save_analysis_value_for_generation(
            &path,
            checkpointed(4, "different-cloud-content"),
            None,
            None,
        )
        .unwrap();
        assert_eq!(different.status, SaveAnalysisStatus::Rejected);
        assert_eq!(read_analysis(&path)["marker"], "cloud-content");
    }

    #[test]
    fn generation_transition_hides_old_analysis_until_new_save_arrives() {
        let dir = TestDir::new("generation-transition-interrupted");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:old", 8, "old-generation"),
        )
        .unwrap();

        let retry_analysis = checkpointed_generation("sha256:new", 0, "new-generation-retry");
        write_generation_state(
            &path,
            &AnalysisGenerationState::active(
                2,
                Some(1),
                Some(0),
                analysis_content_hash(&retry_analysis).unwrap(),
            ),
        )
        .unwrap();

        assert!(load_analysis_path(&path).unwrap().is_none());
        let retry = save_analysis_value(&path, retry_analysis).unwrap();
        assert_eq!(retry.status, SaveAnalysisStatus::Applied);
        assert_eq!(read_analysis(&path)["marker"], "new-generation-retry");
    }

    #[test]
    fn late_save_from_reset_generation_cannot_reclaim_analysis() {
        let dir = TestDir::new("generation-late-save");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:old", 8, "old-generation"),
        )
        .unwrap();
        save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:new", 0, "new-generation"),
            None,
            Some("generation-1"),
        )
        .unwrap();

        let stale = save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:old", 9, "late-old-generation"),
            Some("generation-1"),
            None,
        )
        .unwrap();

        assert_eq!(stale.status, SaveAnalysisStatus::Rejected);
        assert_eq!(stale.revision, Some(0));
        assert_eq!(read_analysis(&path)["marker"], "new-generation");
    }

    #[test]
    fn delayed_reset_cannot_overwrite_a_later_generation() {
        let dir = TestDir::new("generation-delayed-reset");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:a", 8, "generation-a"),
        )
        .unwrap();
        save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:b", 0, "generation-b"),
            None,
            Some("generation-1"),
        )
        .unwrap();
        save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:c", 0, "generation-c"),
            None,
            Some("generation-2"),
        )
        .unwrap();

        let delayed = save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:b", 0, "delayed-generation-b"),
            None,
            Some("generation-1"),
        )
        .unwrap();

        assert_eq!(delayed.status, SaveAnalysisStatus::Rejected);
        assert_eq!(read_analysis(&path)["marker"], "generation-c");
    }

    #[test]
    fn normal_save_cannot_change_transcript_fingerprint() {
        let dir = TestDir::new("generation-implicit-reset");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:old", 8, "old-generation"),
        )
        .unwrap();

        let rejected = save_analysis_value(
            &path,
            checkpointed_generation("sha256:new", 0, "implicit-reset"),
        )
        .unwrap();

        assert_eq!(rejected.status, SaveAnalysisStatus::Rejected);
        assert_eq!(rejected.revision, Some(8));
        assert_eq!(read_analysis(&path)["marker"], "old-generation");
    }

    #[test]
    fn checkpoint_migrates_legacy_analysis() {
        let dir = TestDir::new("migration");
        let path = dir.analysis_path();
        save_analysis_value(&path, legacy("legacy")).unwrap();

        let outcome = save_analysis_value(&path, checkpointed(0, "checkpointed")).unwrap();

        assert_eq!(outcome.status, SaveAnalysisStatus::Applied);
        assert_eq!(outcome.revision, Some(0));
        assert_eq!(read_analysis(&path)["marker"], "checkpointed");
    }

    #[test]
    fn legacy_writes_work_until_a_checkpoint_exists() {
        let dir = TestDir::new("legacy");
        let path = dir.analysis_path();

        assert_eq!(
            save_analysis_value(&path, legacy("first")).unwrap().status,
            SaveAnalysisStatus::Applied
        );
        assert_eq!(
            save_analysis_value(&path, legacy("second")).unwrap().status,
            SaveAnalysisStatus::Applied
        );
        save_analysis_value(&path, checkpointed(3, "checkpointed")).unwrap();
        let rejected = save_analysis_value(&path, legacy("late-legacy")).unwrap();

        assert_eq!(rejected.status, SaveAnalysisStatus::Rejected);
        assert_eq!(rejected.revision, Some(3));
        assert_eq!(read_analysis(&path)["marker"], "checkpointed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_revisions_finish_at_the_maximum() {
        let dir = TestDir::new("concurrent");
        let path = dir.analysis_path();
        let mut tasks = Vec::new();
        save_analysis_value(&path, checkpointed(0, "initial")).unwrap();

        for revision in [7, 2, 9, 1, 6, 10, 4, 8, 3, 5] {
            let path = path.clone();
            tasks.push(tokio::spawn(async move {
                save_analysis_path(&path, checkpointed(revision, "concurrent")).await
            }));
        }

        for task in tasks {
            task.await.unwrap().unwrap();
        }

        assert_eq!(read_revision(&path), Some(10));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_waits_for_the_shared_analysis_mutation_gate() {
        let dir = TestDir::new("delete-gate");
        let path = dir.analysis_path();
        save_analysis_value(&path, checkpointed(1, "original")).unwrap();
        let guard = ANALYSIS_SAVE_GATE.lock().await;
        let delete_path = path.clone();
        let delete = tokio::spawn(async move { delete_analysis_path(&delete_path).await });

        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(!delete.is_finished());
        assert!(path.exists());

        drop(guard);
        delete.await.unwrap().unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn late_save_after_delete_cannot_resurrect_retired_generation() {
        let dir = TestDir::new("delete-generation-tombstone");
        let path = dir.analysis_path();
        save_analysis_value(
            &path,
            checkpointed_generation("sha256:retired", 4, "before-delete"),
        )
        .unwrap();

        delete_analysis_path(&path).await.unwrap();
        let tombstone = read_analysis(&generation_state_path(&path));
        assert_eq!(tombstone["generation"], 1);
        assert_eq!(tombstone["deleted"], true);
        assert!(load_analysis_path(&path).unwrap().is_none());

        let late = save_analysis_value(
            &path,
            checkpointed_generation("sha256:retired", 5, "late-after-delete"),
        )
        .unwrap();

        assert_eq!(late.status, SaveAnalysisStatus::Rejected);
        assert!(!path.exists());

        let reset = save_analysis_value_for_generation(
            &path,
            checkpointed_generation("sha256:future", 0, "after-delete-reset"),
            None,
            Some("generation-1"),
        )
        .unwrap();
        assert_eq!(reset.status, SaveAnalysisStatus::Applied);
        assert_eq!(read_analysis(&path)["marker"], "after-delete-reset");
    }

    #[tokio::test]
    async fn deleting_legacy_analysis_persists_a_restart_safe_tombstone() {
        let dir = TestDir::new("delete-legacy-generation-tombstone");
        let path = dir.analysis_path();
        save_analysis_value(&path, legacy("before-delete")).unwrap();

        let deleted = delete_analysis_path(&path).await.unwrap();
        assert_eq!(deleted.status, SaveAnalysisStatus::Applied);
        assert_eq!(deleted.generation.as_deref(), Some("generation-1"));
        assert!(generation_state_path(&path).exists());

        // The next helper call re-reads disk state, as a restarted process
        // would; no in-memory generation registry participates in the check.
        let late = save_analysis_value(&path, legacy("late-after-delete")).unwrap();

        assert_eq!(late.status, SaveAnalysisStatus::Rejected);
        assert!(!path.exists());
        assert!(load_analysis_path(&path).unwrap().is_none());
    }

    #[tokio::test]
    async fn loading_a_round_two_state_migrates_it_to_epoch_schema() {
        let dir = TestDir::new("generation-state-v1-migration");
        let path = dir.analysis_path();
        fs::write(
            &path,
            serde_json::to_vec_pretty(&checkpointed_generation(
                "sha256:legacy-state",
                3,
                "existing-analysis",
            ))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            generation_state_path(&path),
            br#"{
                "version": 1,
                "transcriptFingerprint": "sha256:legacy-state",
                "deleted": false,
                "revision": 3
            }"#,
        )
        .unwrap();

        let loaded = load_analysis_state_path(&path).await.unwrap();

        assert_eq!(loaded.generation.as_deref(), Some("generation-1"));
        assert_eq!(loaded.analysis.unwrap()["marker"], "existing-analysis");
        let migrated = read_analysis(&generation_state_path(&path));
        assert_eq!(migrated["version"], 2);
        assert_eq!(migrated["generation"], 1);
        assert!(migrated.get("transcriptFingerprint").is_none());
    }

    #[tokio::test]
    async fn loading_legacy_analysis_assigns_a_durable_generation() {
        let dir = TestDir::new("legacy-load-generation");
        let path = dir.analysis_path();
        fs::write(&path, serde_json::to_vec_pretty(&legacy("legacy")).unwrap()).unwrap();

        let loaded = load_analysis_state_path(&path).await.unwrap();

        assert_eq!(loaded.generation.as_deref(), Some("generation-1"));
        assert_eq!(loaded.analysis.unwrap()["marker"], "legacy");
        let state = read_analysis(&generation_state_path(&path));
        assert_eq!(state["version"], 2);
        assert_eq!(state["generation"], 1);
        assert_eq!(state["deleted"], false);
        assert!(state["contentHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn replacement_failure_preserves_original_and_removes_temp_file() {
        let dir = TestDir::new("replace-failure");
        let path = dir.analysis_path();
        save_analysis_value(&path, checkpointed(1, "original")).unwrap();

        let result = save_analysis_value_with_replacer(
            &path,
            checkpointed(2, "replacement"),
            |_temporary, _destination| Err(io::Error::other("injected replacement failure")),
        );

        assert!(result.is_err());
        assert_eq!(read_revision(&path), Some(1));
        assert_eq!(read_analysis(&path)["marker"], "original");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn cas_retry_finishes_after_state_advanced_but_analysis_replace_failed() {
        let dir = TestDir::new("generation-cas-retry-after-replace-failure");
        let path = dir.analysis_path();
        save_analysis_value(&path, checkpointed(4, "generation-one")).unwrap();
        let generation_two = checkpointed(0, "generation-two");

        let first = save_analysis_value_for_generation_with_replacer(
            &path,
            generation_two.clone(),
            None,
            Some("generation-1"),
            |_temporary, _destination| Err(io::Error::other("injected analysis failure")),
        );
        assert!(first.is_err());
        assert_eq!(read_analysis(&path)["marker"], "generation-one");

        let retry =
            save_analysis_value_for_generation(&path, generation_two, None, Some("generation-1"))
                .unwrap();
        assert_eq!(retry.status, SaveAnalysisStatus::Applied);
        assert_eq!(retry.generation.as_deref(), Some("generation-2"));
        assert_eq!(read_analysis(&path)["marker"], "generation-two");
    }

    #[test]
    fn partial_replacement_failure_restores_backup_before_removing_temp() {
        let dir = TestDir::new("replace-partial-backup");
        let path = dir.analysis_path();
        let backup = path.with_extension("json.bak");
        save_analysis_value(&path, checkpointed(1, "original")).unwrap();

        let result = save_analysis_value_with_replacer(
            &path,
            checkpointed(2, "replacement"),
            |_temporary, destination| {
                fs::rename(destination, &backup)?;
                Err(io::Error::other("injected partial replacement failure"))
            },
        );

        assert!(result.is_err());
        assert_eq!(read_revision(&path), Some(1));
        assert_eq!(read_analysis(&path)["marker"], "original");
        assert!(!backup.exists());
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn partial_replacement_failure_keeps_temp_when_no_other_copy_survives() {
        let dir = TestDir::new("replace-partial-temp");
        let path = dir.analysis_path();
        let temporary = path.with_extension("json.tmp");
        save_analysis_value(&path, checkpointed(1, "original")).unwrap();

        let result = save_analysis_value_with_replacer(
            &path,
            checkpointed(2, "replacement"),
            |_temporary, destination| {
                fs::remove_file(destination)?;
                Err(io::Error::other("injected loss of destination"))
            },
        );

        assert!(result.is_err());
        assert!(!path.exists());
        assert_eq!(read_revision(&temporary), Some(2));
        assert_eq!(read_analysis(&temporary)["marker"], "replacement");
    }

    #[test]
    fn interrupted_partial_temp_is_discarded_instead_of_becoming_analysis() {
        let dir = TestDir::new("replace-partial-write");
        let path = dir.analysis_path();
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, br#"{"checkpoint":{"revision":2"#).unwrap();

        let outcome = save_analysis_value(&path, checkpointed(3, "complete")).unwrap();

        assert_eq!(outcome.status, SaveAnalysisStatus::Applied);
        assert_eq!(read_revision(&path), Some(3));
        assert_eq!(read_analysis(&path)["marker"], "complete");
        assert!(!temporary.exists());
    }
}

