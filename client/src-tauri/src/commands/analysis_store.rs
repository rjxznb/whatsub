use crate::core::paths;
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

static STORE_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);
static ANALYSIS_STORE: LazyLock<Mutex<AnalysisStore>> =
    LazyLock::new(|| Mutex::new(AnalysisStore::default()));

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionSaveStatus {
    Applied,
    AlreadyCurrent,
    Rejected,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSaveOutcome {
    pub status: SessionSaveStatus,
    pub revision: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSessionStart {
    pub lease: String,
    pub analysis: Option<Value>,
}

#[derive(Clone, Debug)]
struct ActiveLease {
    token: String,
    fingerprint: Option<String>,
    revision: Option<u64>,
    analysis: Option<Value>,
}

#[derive(Debug)]
pub(crate) struct AnalysisStore {
    instance_id: u64,
    next_lease: u64,
    active: HashMap<String, ActiveLease>,
}

impl Default for AnalysisStore {
    fn default() -> Self {
        Self {
            instance_id: STORE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed) + 1,
            next_lease: 0,
            active: HashMap::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct CheckpointMeta {
    fingerprint: String,
    revision: u64,
}

impl AnalysisStore {
    fn issue_lease(&mut self, video_id: &str, analysis: Option<Value>) -> AppResult<String> {
        self.next_lease = self
            .next_lease
            .checked_add(1)
            .ok_or_else(|| AppError::Other("analysis lease counter exhausted".to_string()))?;
        let token = format!("analysis-lease-{}-{}", self.instance_id, self.next_lease);
        let meta = analysis
            .as_ref()
            .map(validate_analysis)
            .transpose()?
            .flatten();
        self.active.insert(
            video_id.to_owned(),
            ActiveLease {
                token: token.clone(),
                fingerprint: meta.as_ref().map(|meta| meta.fingerprint.clone()),
                revision: meta.as_ref().map(|meta| meta.revision),
                analysis,
            },
        );
        Ok(token)
    }

    pub(crate) fn begin_at(
        &mut self,
        video_id: &str,
        path: &Path,
        reset: bool,
    ) -> AppResult<AnalysisSessionStart> {
        if !reset && self.active.contains_key(video_id) {
            return Err(AppError::Other(format!(
                "analysis session already active for {video_id}"
            )));
        }

        self.active.remove(video_id);
        let analysis = if reset {
            remove_snapshot_artifacts(path)?;
            None
        } else {
            migrate_and_load_snapshot(path)?
        };
        let lease = self.issue_lease(video_id, analysis.clone())?;
        Ok(AnalysisSessionStart { lease, analysis })
    }

    pub(crate) fn save_at(
        &mut self,
        video_id: &str,
        path: &Path,
        lease: &str,
        analysis: Value,
    ) -> AppResult<SessionSaveOutcome> {
        self.save_at_with_replacer(video_id, path, lease, analysis, replace_analysis_file)
    }

    fn save_at_with_replacer<F>(
        &mut self,
        video_id: &str,
        path: &Path,
        lease: &str,
        analysis: Value,
        replacer: F,
    ) -> AppResult<SessionSaveOutcome>
    where
        F: FnOnce(&Path, &Path) -> std::io::Result<()>,
    {
        let incoming = validate_analysis(&analysis)?.ok_or_else(|| {
            AppError::InvalidInput("analysis checkpoint is required for session saves".to_string())
        })?;
        let Some(active) = self.active.get(video_id) else {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::Rejected,
                revision: None,
            });
        };
        if active.token != lease {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::Rejected,
                revision: active.revision,
            });
        }

        if let Some(fingerprint) = active.fingerprint.as_deref() {
            if fingerprint != incoming.fingerprint {
                return Ok(SessionSaveOutcome {
                    status: SessionSaveStatus::Rejected,
                    revision: active.revision,
                });
            }
        } else if incoming.revision != 0 {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::Rejected,
                revision: active.revision,
            });
        }

        if let Some(revision) = active.revision {
            if incoming.revision < revision {
                return Ok(SessionSaveOutcome {
                    status: SessionSaveStatus::Rejected,
                    revision: Some(revision),
                });
            }
            if incoming.revision == revision {
                return Ok(SessionSaveOutcome {
                    status: if active.analysis.as_ref() == Some(&analysis) {
                        SessionSaveStatus::AlreadyCurrent
                    } else {
                        SessionSaveStatus::Rejected
                    },
                    revision: Some(revision),
                });
            }
        }

        write_json_atomically_with_replacer(path, &analysis, replacer)?;
        let active = self
            .active
            .get_mut(video_id)
            .expect("lease checked before atomic save");
        active.fingerprint = Some(incoming.fingerprint);
        active.revision = Some(incoming.revision);
        active.analysis = Some(analysis);
        Ok(SessionSaveOutcome {
            status: SessionSaveStatus::Applied,
            revision: active.revision,
        })
    }

    pub(crate) fn end(&mut self, video_id: &str, lease: &str) {
        if self
            .active
            .get(video_id)
            .is_some_and(|active| active.token == lease)
        {
            self.active.remove(video_id);
        }
    }

    pub(crate) fn revoke(&mut self, video_id: &str) {
        self.active.remove(video_id);
    }

    fn replace_snapshot_at(
        &mut self,
        video_id: &str,
        path: &Path,
        analysis: Value,
    ) -> AppResult<()> {
        validate_analysis(&analysis)?;
        self.revoke(video_id);
        write_json_atomically_with_replacer(path, &analysis, replace_analysis_file)?;
        remove_obsolete_artifacts(path)
    }

    fn delete_snapshot_at_with<F>(
        &mut self,
        video_id: &str,
        path: &Path,
        mut remove: F,
    ) -> AppResult<()>
    where
        F: FnMut(&Path) -> std::io::Result<()>,
    {
        // Revocation is the destructive boundary. Even if the filesystem
        // operation fails, the retired producer must never write again.
        self.revoke(video_id);
        for candidate in snapshot_artifacts(path) {
            match remove(&candidate) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

pub(crate) fn begin_session(video_id: &str, reset: bool) -> AppResult<AnalysisSessionStart> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .begin_at(video_id, &path, reset)
}

pub(crate) fn save_session(
    video_id: &str,
    lease: &str,
    analysis: Value,
) -> AppResult<SessionSaveOutcome> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .save_at(video_id, &path, lease, analysis)
}

pub(crate) fn end_session(video_id: &str, lease: &str) -> AppResult<()> {
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .end(video_id, lease);
    Ok(())
}

pub(crate) fn revoke_analysis_sessions(video_id: &str) -> AppResult<()> {
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .revoke(video_id);
    Ok(())
}

pub(crate) fn load_snapshot(video_id: &str) -> AppResult<Option<Value>> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    let _guard = ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?;
    migrate_and_load_snapshot(&path)
}

pub(crate) fn replace_analysis_snapshot(video_id: &str, analysis: Value) -> AppResult<()> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .replace_snapshot_at(video_id, &path, analysis)
}

pub(crate) fn delete_analysis_snapshot(video_id: &str) -> AppResult<()> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .delete_snapshot_at_with(video_id, &path, |candidate| fs::remove_file(candidate))
}

fn validate_analysis(analysis: &Value) -> AppResult<Option<CheckpointMeta>> {
    let object = analysis
        .as_object()
        .ok_or_else(|| AppError::InvalidInput("analysis must be a JSON object".to_string()))?;
    if !object.get("subtitles").is_some_and(Value::is_array)
        || !object.get("keyPhrases").is_some_and(Value::is_array)
    {
        return Err(AppError::InvalidInput(
            "analysis subtitles and keyPhrases must be arrays".to_string(),
        ));
    }
    let Some(checkpoint) = object.get("checkpoint") else {
        return Ok(None);
    };
    let checkpoint = checkpoint.as_object().ok_or_else(|| {
        AppError::InvalidInput("analysis checkpoint must be an object".to_string())
    })?;
    if checkpoint.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(AppError::InvalidInput(
            "analysis checkpoint version must be 1".to_string(),
        ));
    }
    let fingerprint = checkpoint
        .get("transcriptFingerprint")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::InvalidInput(
                "analysis checkpoint transcriptFingerprint is invalid".to_string(),
            )
        })?;
    checkpoint
        .get("nextCueOffset")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AppError::InvalidInput("analysis checkpoint nextCueOffset is invalid".to_string())
        })?;
    let phase = checkpoint.get("phase").and_then(Value::as_str);
    if !matches!(phase, Some("cues" | "summary" | "complete")) {
        return Err(AppError::InvalidInput(
            "analysis checkpoint phase is invalid".to_string(),
        ));
    }
    let revision = checkpoint
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            AppError::InvalidInput("analysis checkpoint revision is invalid".to_string())
        })?;
    Ok(Some(CheckpointMeta {
        fingerprint: fingerprint.to_string(),
        revision,
    }))
}

fn migrate_and_load_snapshot(path: &Path) -> AppResult<Option<Value>> {
    let visible = read_valid_snapshot(path);
    if let Ok(Some(value)) = visible {
        remove_obsolete_artifacts(path)?;
        return Ok(Some(value));
    }

    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    let candidates: Vec<Value> = [&temporary, &backup]
        .into_iter()
        .filter_map(|candidate| read_valid_snapshot(candidate).ok().flatten())
        .collect();
    let selected = match candidates.as_slice() {
        [] => {
            if path.exists() {
                return visible.map(|_| None);
            }
            remove_obsolete_artifacts(path)?;
            return Ok(None);
        }
        [only] => only.clone(),
        [first, second] if first == second => first.clone(),
        _ => {
            return Err(AppError::InvalidInput(
                "ambiguous analysis recovery candidates".to_string(),
            ))
        }
    };
    write_json_atomically_with_replacer(path, &selected, replace_analysis_file)?;
    remove_obsolete_artifacts(path)?;
    Ok(Some(selected))
}

fn read_valid_snapshot(path: &Path) -> AppResult<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    validate_analysis(&value)?;
    Ok(Some(value))
}

fn remove_snapshot_artifacts(path: &Path) -> AppResult<()> {
    for candidate in snapshot_artifacts(path) {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn remove_obsolete_artifacts(path: &Path) -> AppResult<()> {
    for candidate in snapshot_artifacts(path).into_iter().skip(1) {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn snapshot_artifacts(path: &Path) -> Vec<PathBuf> {
    let generation = path.with_file_name("analysis.generation.json");
    vec![
        path.to_path_buf(),
        path.with_extension("json.tmp"),
        path.with_extension("json.bak"),
        generation.clone(),
        generation.with_extension("json.tmp"),
        generation.with_extension("json.bak"),
    ]
}

fn write_json_atomically_with_replacer<F>(path: &Path, value: &Value, replacer: F) -> AppResult<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
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
        if !path.exists() && backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        if path.exists() {
            let _ = fs::remove_file(&temporary);
        }
        return Err(error.into());
    }
    let _ = fs::remove_file(backup);
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
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let destination_wide = wide(destination);
    let temporary_wide = wide(temporary);
    let backup = destination.with_extension("json.bak");
    let backup_wide = wide(&backup);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "whatsub-analysis-lease-{name}-{}-{nonce}",
                std::process::id()
            ));
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

    fn checkpointed(fingerprint: &str, revision: u64, marker: &str) -> Value {
        json!({
            "subtitles": [],
            "keyPhrases": [],
            "marker": marker,
            "checkpoint": {
                "version": 1,
                "transcriptFingerprint": fingerprint,
                "nextCueOffset": 0,
                "phase": "cues",
                "revision": revision
            }
        })
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn revoked_lease_cannot_write_after_an_explicit_reset() {
        let dir = TestDir::new("revoked-after-reset");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();

        let old = store.begin_at("v1", &path, false).unwrap();
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &old.lease,
                    checkpointed("sha256:old", 0, "old")
                )
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );

        let fresh = store.begin_at("v1", &path, true).unwrap();
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &old.lease,
                    checkpointed("sha256:old", 1, "late")
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &fresh.lease,
                    checkpointed("sha256:fresh", 0, "fresh"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );
        assert_eq!(read(&path)["marker"], "fresh");
    }

    #[test]
    fn a_non_reset_begin_cannot_steal_an_active_video() {
        let dir = TestDir::new("active-conflict");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        store.begin_at("v1", &path, false).unwrap();

        let error = store.begin_at("v1", &path, false).unwrap_err();
        assert!(error.to_string().contains("already active"));
    }

    #[test]
    fn revisions_only_advance_within_one_fingerprint() {
        let dir = TestDir::new("revision-order");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let session = store.begin_at("v1", &path, false).unwrap();

        let revision_zero = checkpointed("sha256:same", 0, "zero");
        assert_eq!(
            store
                .save_at("v1", &path, &session.lease, revision_zero.clone())
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );
        assert_eq!(
            store
                .save_at("v1", &path, &session.lease, revision_zero)
                .unwrap()
                .status,
            SessionSaveStatus::AlreadyCurrent
        );
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &session.lease,
                    checkpointed("sha256:same", 0, "conflict"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &session.lease,
                    checkpointed("sha256:other", 1, "wrong transcript"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &session.lease,
                    checkpointed("sha256:same", 1, "one")
                )
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );
        assert_eq!(read(&path)["marker"], "one");
    }

    #[test]
    fn replacement_failure_preserves_the_previous_analysis() {
        let dir = TestDir::new("replacement-failure");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let session = store.begin_at("v1", &path, false).unwrap();
        store
            .save_at(
                "v1",
                &path,
                &session.lease,
                checkpointed("sha256:same", 0, "zero"),
            )
            .unwrap();

        let result = store.save_at_with_replacer(
            "v1",
            &path,
            &session.lease,
            checkpointed("sha256:same", 1, "one"),
            |_temporary, _destination| Err(std::io::Error::other("replace failed")),
        );

        assert!(result.is_err());
        assert_eq!(read(&path)["marker"], "zero");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_new_process_store_can_resume_the_complete_file_with_a_new_lease() {
        let dir = TestDir::new("new-process");
        let path = dir.analysis_path();
        let mut first_process = AnalysisStore::default();
        let first = first_process.begin_at("v1", &path, false).unwrap();
        first_process
            .save_at(
                "v1",
                &path,
                &first.lease,
                checkpointed("sha256:same", 0, "initial"),
            )
            .unwrap();
        first_process
            .save_at(
                "v1",
                &path,
                &first.lease,
                checkpointed("sha256:same", 3, "saved"),
            )
            .unwrap();

        let mut restarted_process = AnalysisStore::default();
        let resumed = restarted_process.begin_at("v1", &path, false).unwrap();

        assert_ne!(resumed.lease, first.lease);
        assert_eq!(resumed.analysis.unwrap()["marker"], "saved");
    }

    #[test]
    fn a_valid_visible_analysis_wins_one_time_migration_and_removes_old_artifacts() {
        let dir = TestDir::new("visible-migration");
        let path = dir.analysis_path();
        fs::write(
            &path,
            serde_json::to_vec_pretty(&checkpointed("sha256:same", 3, "visible")).unwrap(),
        )
        .unwrap();
        fs::write(
            path.with_extension("json.tmp"),
            serde_json::to_vec_pretty(&checkpointed("sha256:same", 4, "temporary")).unwrap(),
        )
        .unwrap();
        fs::write(
            path.with_file_name("analysis.generation.json"),
            br#"{"version":2,"generation":7}"#,
        )
        .unwrap();

        let mut store = AnalysisStore::default();
        let started = store.begin_at("v1", &path, false).unwrap();

        assert_eq!(started.analysis.unwrap()["marker"], "visible");
        assert!(!path.with_extension("json.tmp").exists());
        assert!(!path.with_file_name("analysis.generation.json").exists());
    }

    #[test]
    fn one_valid_temporary_candidate_is_recovered_when_visible_analysis_is_absent() {
        let dir = TestDir::new("temporary-migration");
        let path = dir.analysis_path();
        fs::write(
            path.with_extension("json.tmp"),
            serde_json::to_vec_pretty(&checkpointed("sha256:same", 2, "temporary")).unwrap(),
        )
        .unwrap();

        let mut store = AnalysisStore::default();
        let started = store.begin_at("v1", &path, false).unwrap();

        assert_eq!(started.analysis.unwrap()["marker"], "temporary");
        assert_eq!(read(&path)["marker"], "temporary");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn contradictory_recovery_candidates_fail_closed() {
        let dir = TestDir::new("ambiguous-migration");
        let path = dir.analysis_path();
        fs::write(
            path.with_extension("json.tmp"),
            serde_json::to_vec_pretty(&checkpointed("sha256:same", 2, "temporary")).unwrap(),
        )
        .unwrap();
        fs::write(
            path.with_extension("json.bak"),
            serde_json::to_vec_pretty(&checkpointed("sha256:same", 1, "backup")).unwrap(),
        )
        .unwrap();

        let mut store = AnalysisStore::default();
        let error = store.begin_at("v1", &path, false).unwrap_err();

        assert!(error.to_string().contains("ambiguous"));
        assert!(!path.exists());
    }

    #[test]
    fn malformed_checkpoint_payload_is_rejected_before_writing() {
        let dir = TestDir::new("malformed-checkpoint");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let session = store.begin_at("v1", &path, false).unwrap();

        let error = store
            .save_at(
                "v1",
                &path,
                &session.lease,
                json!({ "subtitles": [], "keyPhrases": [], "checkpoint": { "revision": -1 } }),
            )
            .unwrap_err();

        assert!(error.to_string().contains("checkpoint"));
        assert!(!path.exists());
    }

    #[test]
    fn explicit_snapshot_replacement_revokes_the_old_lease() {
        let dir = TestDir::new("snapshot-replace-revokes");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let old = store.begin_at("v1", &path, false).unwrap();
        store
            .save_at(
                "v1",
                &path,
                &old.lease,
                checkpointed("sha256:old", 0, "old"),
            )
            .unwrap();

        store
            .replace_snapshot_at("v1", &path, checkpointed("sha256:cloud", 4, "cloud"))
            .unwrap();

        assert_eq!(read(&path)["marker"], "cloud");
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &old.lease,
                    checkpointed("sha256:old", 1, "late"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
    }

    #[test]
    fn deletion_revokes_before_a_later_filesystem_failure() {
        let dir = TestDir::new("delete-revokes-first");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let old = store.begin_at("v1", &path, false).unwrap();
        store
            .save_at(
                "v1",
                &path,
                &old.lease,
                checkpointed("sha256:old", 0, "old"),
            )
            .unwrap();

        let result = store.delete_snapshot_at_with("v1", &path, |_candidate| {
            Err(std::io::Error::other("remove failed"))
        });

        assert!(result.is_err());
        assert_eq!(read(&path)["marker"], "old");
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &path,
                    &old.lease,
                    checkpointed("sha256:old", 1, "late"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
    }
}
