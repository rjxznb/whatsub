use crate::core::paths;
use crate::error::{AppError, AppResult};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

static STORE_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(0);
static ANALYSIS_STORE: LazyLock<Mutex<AnalysisStore>> =
    LazyLock::new(|| Mutex::new(AnalysisStore::default()));

const INFLIGHT_VERSION: u8 = 1;
const MAX_INFLIGHT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INFLIGHT_ENTRIES: usize = 50;
const MAX_INFLIGHT_ENTRY_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisInflightEntry {
    pub cue_offset: usize,
    pub subtitle: Value,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisInflightJournal {
    pub version: u8,
    pub journal_id: String,
    pub transcript_generation: String,
    pub transcript_fingerprint: String,
    pub analysis_style: String,
    pub base_revision: u64,
    pub start_cue_offset: usize,
    pub end_cue_offset: usize,
    pub entries: Vec<AnalysisInflightEntry>,
}

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
    pub inflight: Option<AnalysisInflightJournal>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisTranscriptSessionStart {
    pub transcript: String,
    pub transcript_generation: String,
    pub session: AnalysisSessionStart,
}

#[derive(Clone, Debug)]
struct ActiveLease {
    token: String,
    transcript_generation: String,
    verify_transcript_path: bool,
    analysis_style: String,
    fingerprint: Option<String>,
    revision: Option<u64>,
    next_cue_offset: Option<usize>,
    phase: Option<String>,
    analysis: Option<Value>,
    inflight: Option<AnalysisInflightJournal>,
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
    next_cue_offset: usize,
    phase: String,
}

impl AnalysisStore {
    fn issue_lease(
        &mut self,
        video_id: &str,
        analysis: Option<Value>,
        transcript_generation: String,
        verify_transcript_path: bool,
        analysis_style: String,
        inflight: Option<AnalysisInflightJournal>,
    ) -> AppResult<String> {
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
                transcript_generation,
                verify_transcript_path,
                analysis_style,
                fingerprint: meta.as_ref().map(|meta| meta.fingerprint.clone()),
                revision: meta.as_ref().map(|meta| meta.revision),
                next_cue_offset: meta.as_ref().map(|meta| meta.next_cue_offset),
                phase: meta.as_ref().map(|meta| meta.phase.clone()),
                analysis,
                inflight,
            },
        );
        Ok(token)
    }

    pub(crate) fn begin_at(
        &mut self,
        video_id: &str,
        path: &Path,
        reset: bool,
        transcript_generation: &str,
        verify_transcript_path: bool,
        analysis_style: &str,
    ) -> AppResult<AnalysisSessionStart> {
        validate_session_identity(transcript_generation, analysis_style)?;
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
        let inflight = if reset {
            None
        } else {
            load_matching_inflight(
                path,
                analysis.as_ref(),
                transcript_generation,
                analysis_style,
            )?
        };
        let lease = self.issue_lease(
            video_id,
            analysis.clone(),
            transcript_generation.to_string(),
            verify_transcript_path,
            analysis_style.to_string(),
            inflight.clone(),
        )?;
        Ok(AnalysisSessionStart {
            lease,
            analysis,
            inflight,
        })
    }

    fn begin_for_transcript_at(
        &mut self,
        video_id: &str,
        transcript_path: &Path,
        analysis_path: &Path,
        reset: bool,
        expected_generation: Option<&str>,
        analysis_style: &str,
    ) -> AppResult<Option<AnalysisTranscriptSessionStart>> {
        let transcript = match fs::read_to_string(transcript_path) {
            Ok(transcript) => transcript,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let transcript_generation = transcript_generation(&transcript);
        validate_session_identity(&transcript_generation, analysis_style)?;
        if expected_generation.is_some_and(|expected| expected != transcript_generation) {
            return Err(AppError::Other(
                "analysis transcript changed while opening session".to_string(),
            ));
        }

        if !reset && self.active.contains_key(video_id) {
            return Err(AppError::Other(format!(
                "analysis session already active for {video_id}"
            )));
        }
        self.active.remove(video_id);
        let analysis = if reset {
            remove_snapshot_artifacts(analysis_path)?;
            None
        } else {
            migrate_and_load_snapshot(analysis_path)?
        };
        let inflight = if reset {
            None
        } else {
            load_matching_inflight(
                analysis_path,
                analysis.as_ref(),
                &transcript_generation,
                analysis_style,
            )?
        };
        let lease = self.issue_lease(
            video_id,
            analysis.clone(),
            transcript_generation.clone(),
            true,
            analysis_style.to_string(),
            inflight.clone(),
        )?;
        Ok(Some(AnalysisTranscriptSessionStart {
            transcript,
            transcript_generation,
            session: AnalysisSessionStart {
                lease,
                analysis,
                inflight,
            },
        }))
    }

    pub(crate) fn save_at(
        &mut self,
        video_id: &str,
        path: &Path,
        lease: &str,
        analysis: Value,
    ) -> AppResult<SessionSaveOutcome> {
        self.save_at_with_parts(
            video_id,
            path,
            lease,
            analysis,
            replace_analysis_file,
            |candidate| fs::remove_file(candidate),
        )
    }

    #[cfg(test)]
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
        self.save_at_with_parts(video_id, path, lease, analysis, replacer, |candidate| {
            fs::remove_file(candidate)
        })
    }

    #[cfg(test)]
    fn save_at_with_inflight_remover<R>(
        &mut self,
        video_id: &str,
        path: &Path,
        lease: &str,
        analysis: Value,
        remover: R,
    ) -> AppResult<SessionSaveOutcome>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        self.save_at_with_parts(
            video_id,
            path,
            lease,
            analysis,
            replace_analysis_file,
            remover,
        )
    }

    fn save_at_with_parts<F, R>(
        &mut self,
        video_id: &str,
        path: &Path,
        lease: &str,
        analysis: Value,
        replacer: F,
        mut remove_inflight: R,
    ) -> AppResult<SessionSaveOutcome>
    where
        F: FnOnce(&Path, &Path) -> std::io::Result<()>,
        R: FnMut(&Path) -> std::io::Result<()>,
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

        if !active_transcript_is_current(active, path)? {
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
        active.next_cue_offset = Some(incoming.next_cue_offset);
        active.phase = Some(incoming.phase);
        active.analysis = Some(analysis);
        let clear_inflight = active
            .inflight
            .as_ref()
            .is_some_and(|journal| incoming.next_cue_offset >= journal.end_cue_offset);
        if clear_inflight {
            active.inflight = None;
        }
        let revision = active.revision;
        if clear_inflight {
            for candidate in inflight_artifacts(&inflight_path(path)) {
                match remove_inflight(&candidate) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => eprintln!(
                        "analysis inflight cleanup failed for {}: {error}",
                        candidate.display()
                    ),
                }
            }
        }
        Ok(SessionSaveOutcome {
            status: SessionSaveStatus::Applied,
            revision,
        })
    }

    fn save_inflight_at(
        &mut self,
        video_id: &str,
        analysis_path: &Path,
        lease: &str,
        journal: AnalysisInflightJournal,
    ) -> AppResult<SessionSaveOutcome> {
        validate_inflight(&journal)?;
        let Some(active) = self.active.get(video_id) else {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::Rejected,
                revision: None,
            });
        };
        if active.token != lease
            || !active_transcript_is_current(active, analysis_path)?
            || !journal_matches_active(&journal, active)
            || !journal_is_monotonic(active.inflight.as_ref(), &journal)
        {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::Rejected,
                revision: active.revision,
            });
        }
        if active.inflight.as_ref() == Some(&journal) {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::AlreadyCurrent,
                revision: active.revision,
            });
        }

        write_inflight_at_with_replacer(
            &inflight_path(analysis_path),
            &journal,
            replace_analysis_file,
        )?;
        let active = self
            .active
            .get_mut(video_id)
            .expect("lease checked before atomic inflight save");
        active.inflight = Some(journal);
        Ok(SessionSaveOutcome {
            status: SessionSaveStatus::Applied,
            revision: active.revision,
        })
    }

    fn discard_inflight_at(
        &mut self,
        video_id: &str,
        analysis_path: &Path,
        lease: &str,
        journal_id: &str,
    ) -> AppResult<SessionSaveOutcome> {
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
        let Some(current) = active.inflight.as_ref() else {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::AlreadyCurrent,
                revision: active.revision,
            });
        };
        if current.journal_id != journal_id {
            return Ok(SessionSaveOutcome {
                status: SessionSaveStatus::Rejected,
                revision: active.revision,
            });
        }

        remove_inflight_artifacts(&inflight_path(analysis_path))?;
        let active = self
            .active
            .get_mut(video_id)
            .expect("lease checked before inflight discard");
        active.inflight = None;
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
        for candidate in all_analysis_artifacts(path) {
            match remove(&candidate) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}

fn with_store_destructive_boundary<T, F>(
    store: &Mutex<AnalysisStore>,
    video_id: &str,
    operation: F,
) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T>,
{
    let mut guard = store
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?;
    guard.revoke(video_id);
    // Keep the lease mutex held for the complete destructive operation.  A
    // new producer cannot begin between revocation and filesystem cleanup.
    let result = operation();
    drop(guard);
    result
}

pub(crate) fn with_destructive_boundary<T, F>(video_id: &str, operation: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T>,
{
    with_store_destructive_boundary(&ANALYSIS_STORE, video_id, operation)
}

pub(crate) fn begin_session(
    video_id: &str,
    reset: bool,
    transcript_generation: &str,
    analysis_style: &str,
) -> AppResult<AnalysisSessionStart> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .begin_at(
            video_id,
            &path,
            reset,
            transcript_generation,
            false,
            analysis_style,
        )
}

pub(crate) fn begin_transcript_session(
    video_id: &str,
    reset: bool,
    expected_generation: Option<&str>,
    analysis_style: &str,
) -> AppResult<Option<AnalysisTranscriptSessionStart>> {
    let video_dir = paths::video_dir(video_id)?;
    let transcript_path = video_dir.join("transcript.srt");
    let analysis_path = video_dir.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .begin_for_transcript_at(
            video_id,
            &transcript_path,
            &analysis_path,
            reset,
            expected_generation,
            analysis_style,
        )
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

pub(crate) fn save_inflight(
    video_id: &str,
    lease: &str,
    journal: AnalysisInflightJournal,
) -> AppResult<SessionSaveOutcome> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .save_inflight_at(video_id, &path, lease, journal)
}

pub(crate) fn discard_inflight(
    video_id: &str,
    lease: &str,
    journal_id: &str,
) -> AppResult<SessionSaveOutcome> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .discard_inflight_at(video_id, &path, lease, journal_id)
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

pub(crate) fn replace_materialized_snapshot(
    video_id: &str,
    transcript: &str,
    analysis: Value,
) -> AppResult<()> {
    let video_dir = paths::video_dir(video_id)?;
    let transcript_path = video_dir.join("transcript.srt");
    let analysis_path = video_dir.join("analysis.json");
    let mut guard = ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?;
    replace_materialized_snapshot_at(
        &mut guard,
        video_id,
        &transcript_path,
        &analysis_path,
        transcript,
        analysis,
    )
}

pub(crate) fn delete_analysis_snapshot(video_id: &str) -> AppResult<()> {
    let path = paths::video_dir(video_id)?.join("analysis.json");
    ANALYSIS_STORE
        .lock()
        .map_err(|_| AppError::Other("analysis lease store poisoned".to_string()))?
        .delete_snapshot_at_with(video_id, &path, |candidate| fs::remove_file(candidate))
}

fn replace_materialized_snapshot_at(
    store: &mut AnalysisStore,
    video_id: &str,
    transcript_path: &Path,
    analysis_path: &Path,
    transcript: &str,
    analysis: Value,
) -> AppResult<()> {
    replace_materialized_snapshot_at_with(
        store,
        video_id,
        transcript_path,
        analysis_path,
        transcript,
        analysis,
        |from, to| fs::rename(from, to),
    )
}

fn replace_materialized_snapshot_at_with<M>(
    store: &mut AnalysisStore,
    video_id: &str,
    transcript_path: &Path,
    analysis_path: &Path,
    transcript: &str,
    analysis: Value,
    mut rename: M,
) -> AppResult<()>
where
    M: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    validate_analysis(&analysis)?;
    store.revoke(video_id);

    if let Some(parent) = analysis_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = transcript_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // These installation files are intentionally distinct from
    // analysis.json.tmp/.bak.  If the process dies halfway through, normal
    // checkpoint recovery must not mistake a half-installed cloud snapshot
    // for a resumable local checkpoint.  analysis.json is published last,
    // so every visible analysis always belongs to the visible transcript.
    let transcript_temporary = install_artifact(transcript_path, "installing");
    let transcript_backup = install_artifact(transcript_path, "install-backup");
    let analysis_temporary = install_artifact(analysis_path, "installing");
    let analysis_backup = install_artifact(analysis_path, "install-backup");
    for stale in [
        &transcript_temporary,
        &transcript_backup,
        &analysis_temporary,
        &analysis_backup,
    ] {
        remove_file_if_present(stale)?;
    }

    stage_bytes(&transcript_temporary, transcript.as_bytes())?;
    if let Err(error) = stage_json(&analysis_temporary, &analysis) {
        let _ = fs::remove_file(&transcript_temporary);
        return Err(error);
    }

    let had_transcript = transcript_path.exists();
    let had_analysis = analysis_path.exists();
    let mut transcript_backed_up = false;
    let mut analysis_backed_up = false;
    let mut transcript_committed = false;
    let mut analysis_committed = false;

    let install_result = (|| -> AppResult<()> {
        if had_analysis {
            rename(analysis_path, &analysis_backup)?;
            analysis_backed_up = true;
        }
        if had_transcript {
            rename(transcript_path, &transcript_backup)?;
            transcript_backed_up = true;
        }
        rename(&transcript_temporary, transcript_path)?;
        transcript_committed = true;
        rename(&analysis_temporary, analysis_path)?;
        analysis_committed = true;
        Ok(())
    })();

    if let Err(error) = install_result {
        let rollback_errors = rollback_materialized_install_with(
            transcript_path,
            analysis_path,
            &transcript_temporary,
            &analysis_temporary,
            &transcript_backup,
            &analysis_backup,
            MaterializedInstallState {
                had_transcript,
                had_analysis,
                transcript_backed_up,
                analysis_backed_up,
                transcript_committed,
                analysis_committed,
            },
            |path| fs::remove_file(path),
            |from, to| rename(from, to),
        );
        let rollback_detail = if rollback_errors.is_empty() {
            String::new()
        } else {
            format!("; rollback failed: {}", rollback_errors.join("; "))
        };
        return Err(AppError::Other(format!(
            "materialized snapshot install failed: {error}{rollback_detail}"
        )));
    }

    let _ = fs::remove_file(transcript_backup);
    let _ = fs::remove_file(analysis_backup);
    // The new transcript + canonical analysis are now both visible. Only at
    // this point is the old-generation local journal obsolete. Cleanup is
    // best effort so a successful cloud materialization never becomes a
    // user-visible failure after its atomic pair has committed.
    remove_inflight_artifacts_best_effort(&inflight_path(analysis_path));
    remove_obsolete_artifacts(analysis_path)
}

#[derive(Clone, Copy)]
struct MaterializedInstallState {
    had_transcript: bool,
    had_analysis: bool,
    transcript_backed_up: bool,
    analysis_backed_up: bool,
    transcript_committed: bool,
    analysis_committed: bool,
}

#[allow(clippy::too_many_arguments)]
fn rollback_materialized_install_with<R, M>(
    transcript_path: &Path,
    analysis_path: &Path,
    transcript_temporary: &Path,
    analysis_temporary: &Path,
    transcript_backup: &Path,
    analysis_backup: &Path,
    state: MaterializedInstallState,
    mut remove: R,
    mut rename: M,
) -> Vec<String>
where
    R: FnMut(&Path) -> std::io::Result<()>,
    M: FnMut(&Path, &Path) -> std::io::Result<()>,
{
    let mut errors = Vec::new();

    // If a future install step can fail after analysis was published, keep the
    // new transcript in place unless the new analysis can first be hidden.
    // That preserves a same-generation visible pair even during rollback.
    let analysis_hidden = !state.analysis_committed
        || remove_for_rollback(
            &mut remove,
            &mut errors,
            "remove new analysis",
            analysis_path,
        );

    let transcript_restored = if !analysis_hidden {
        false
    } else if state.transcript_backed_up {
        let destination_clear = !state.transcript_committed
            || remove_for_rollback(
                &mut remove,
                &mut errors,
                "remove new transcript",
                transcript_path,
            );
        if destination_clear {
            match rename(transcript_backup, transcript_path) {
                Ok(()) => true,
                Err(error) => {
                    errors.push(format!("restore transcript: {error}"));
                    false
                }
            }
        } else {
            false
        }
    } else if state.had_transcript {
        true
    } else if state.transcript_committed {
        remove_for_rollback(
            &mut remove,
            &mut errors,
            "remove new transcript",
            transcript_path,
        )
    } else {
        true
    };

    if state.analysis_backed_up {
        if transcript_restored && analysis_hidden {
            if let Err(error) = rename(analysis_backup, analysis_path) {
                errors.push(format!("restore analysis: {error}"));
            }
        } else {
            errors.push(
                "old analysis restore skipped because transcript rollback was incomplete"
                    .to_string(),
            );
        }
    } else if state.had_analysis && !transcript_restored {
        // This state is not reachable with today's analysis-first backup
        // order, but fail closed if the order is changed in the future.
        remove_for_rollback(
            &mut remove,
            &mut errors,
            "hide analysis after transcript rollback failure",
            analysis_path,
        );
    }

    remove_for_rollback(
        &mut remove,
        &mut errors,
        "remove staged transcript",
        transcript_temporary,
    );
    remove_for_rollback(
        &mut remove,
        &mut errors,
        "remove staged analysis",
        analysis_temporary,
    );
    errors
}

fn remove_for_rollback<R>(
    remove: &mut R,
    errors: &mut Vec<String>,
    label: &str,
    path: &Path,
) -> bool
where
    R: FnMut(&Path) -> std::io::Result<()>,
{
    match remove(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            errors.push(format!("{label}: {error}"));
            false
        }
    }
}

fn install_artifact(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("snapshot");
    path.with_file_name(format!("{file_name}.{suffix}"))
}

fn remove_file_if_present(path: &Path) -> AppResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn stage_bytes(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

fn stage_json(path: &Path, value: &Value) -> AppResult<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

fn transcript_generation(transcript: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(transcript.as_bytes())))
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
    let next_cue_offset = checkpoint
        .get("nextCueOffset")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
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
        next_cue_offset,
        phase: phase.expect("checkpoint phase validated").to_string(),
    }))
}

fn is_known_analysis_style(style: &str) -> bool {
    matches!(
        style,
        "formal" | "neutral" | "colloquial" | "playful" | "cinematic" | "literary"
    )
}

fn validate_session_identity(transcript_generation: &str, analysis_style: &str) -> AppResult<()> {
    if transcript_generation.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "analysis transcriptGeneration is invalid".to_string(),
        ));
    }
    if !is_known_analysis_style(analysis_style) {
        return Err(AppError::InvalidInput(
            "analysis analysisStyle is invalid".to_string(),
        ));
    }
    Ok(())
}

fn active_transcript_is_current(active: &ActiveLease, analysis_path: &Path) -> AppResult<bool> {
    if !active.verify_transcript_path {
        return Ok(true);
    }
    let transcript_path = analysis_path.with_file_name("transcript.srt");
    let current_generation = match fs::read_to_string(&transcript_path) {
        Ok(transcript) => Some(transcript_generation(&transcript)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    Ok(current_generation.as_deref() == Some(active.transcript_generation.as_str()))
}

fn journal_matches_checkpoint(
    journal: &AnalysisInflightJournal,
    transcript_generation: &str,
    analysis_style: &str,
    checkpoint: &CheckpointMeta,
) -> bool {
    checkpoint.phase == "cues"
        && journal.transcript_generation == transcript_generation
        && journal.analysis_style == analysis_style
        && journal.transcript_fingerprint == checkpoint.fingerprint
        && journal.base_revision == checkpoint.revision
        && journal.start_cue_offset == checkpoint.next_cue_offset
        && checkpoint.next_cue_offset < journal.end_cue_offset
}

fn journal_matches_active(journal: &AnalysisInflightJournal, active: &ActiveLease) -> bool {
    matches!(active.phase.as_deref(), Some("cues"))
        && journal.transcript_generation == active.transcript_generation
        && journal.analysis_style == active.analysis_style
        && active
            .fingerprint
            .as_deref()
            .is_some_and(|value| value == journal.transcript_fingerprint)
        && active.revision == Some(journal.base_revision)
        && active.next_cue_offset == Some(journal.start_cue_offset)
}

fn journal_is_monotonic(
    previous: Option<&AnalysisInflightJournal>,
    incoming: &AnalysisInflightJournal,
) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    if previous.version != incoming.version
        || previous.journal_id != incoming.journal_id
        || previous.transcript_generation != incoming.transcript_generation
        || previous.transcript_fingerprint != incoming.transcript_fingerprint
        || previous.analysis_style != incoming.analysis_style
        || previous.base_revision != incoming.base_revision
        || previous.start_cue_offset != incoming.start_cue_offset
        || previous.end_cue_offset != incoming.end_cue_offset
        || incoming.entries.len() < previous.entries.len()
    {
        return false;
    }
    let incoming_by_offset = incoming
        .entries
        .iter()
        .map(|entry| (entry.cue_offset, &entry.subtitle))
        .collect::<HashMap<_, _>>();
    previous.entries.iter().all(|entry| {
        incoming_by_offset.get(&entry.cue_offset).copied() == Some(&entry.subtitle)
    })
}

fn load_matching_inflight(
    analysis_path: &Path,
    analysis: Option<&Value>,
    transcript_generation: &str,
    analysis_style: &str,
) -> AppResult<Option<AnalysisInflightJournal>> {
    let Some(journal) = load_inflight_best_effort(analysis_path) else {
        return Ok(None);
    };
    let checkpoint = analysis.map(validate_analysis).transpose()?.flatten();
    if checkpoint.as_ref().is_some_and(|checkpoint| {
        journal_matches_checkpoint(
            &journal,
            transcript_generation,
            analysis_style,
            checkpoint,
        )
    }) {
        return Ok(Some(journal));
    }
    remove_inflight_artifacts_best_effort(&inflight_path(analysis_path));
    Ok(None)
}

fn inflight_path(analysis_path: &Path) -> PathBuf {
    analysis_path.with_file_name("analysis.inflight.json")
}

fn inflight_artifacts(path: &Path) -> [PathBuf; 3] {
    [
        path.to_path_buf(),
        path.with_extension("json.tmp"),
        path.with_extension("json.bak"),
    ]
}

fn validate_inflight(journal: &AnalysisInflightJournal) -> AppResult<()> {
    if journal.version != INFLIGHT_VERSION {
        return Err(AppError::InvalidInput(
            "analysis inflight version must be 1".to_string(),
        ));
    }
    for (label, value) in [
        ("journalId", journal.journal_id.as_str()),
        (
            "transcriptGeneration",
            journal.transcript_generation.as_str(),
        ),
        (
            "transcriptFingerprint",
            journal.transcript_fingerprint.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "analysis inflight {label} is invalid"
            )));
        }
    }
    if !is_known_analysis_style(&journal.analysis_style) {
        return Err(AppError::InvalidInput(
            "analysis inflight analysisStyle is invalid".to_string(),
        ));
    }
    let span = journal
        .end_cue_offset
        .checked_sub(journal.start_cue_offset)
        .filter(|span| *span > 0 && *span <= MAX_INFLIGHT_ENTRIES)
        .ok_or_else(|| {
            AppError::InvalidInput("analysis inflight cue range is invalid".to_string())
        })?;
    if journal.entries.len() > MAX_INFLIGHT_ENTRIES || journal.entries.len() > span {
        return Err(AppError::InvalidInput(
            "analysis inflight has too many entries".to_string(),
        ));
    }

    let mut offsets = HashSet::with_capacity(journal.entries.len());
    for entry in &journal.entries {
        if entry.cue_offset < journal.start_cue_offset || entry.cue_offset >= journal.end_cue_offset
        {
            return Err(AppError::InvalidInput(
                "analysis inflight cueOffset is outside the batch".to_string(),
            ));
        }
        if !offsets.insert(entry.cue_offset) {
            return Err(AppError::InvalidInput(
                "analysis inflight cueOffset is duplicated".to_string(),
            ));
        }
        if !entry.subtitle.is_object() {
            return Err(AppError::InvalidInput(
                "analysis inflight subtitle must be an object".to_string(),
            ));
        }
        if serde_json::to_vec(entry)?.len() > MAX_INFLIGHT_ENTRY_BYTES {
            return Err(AppError::InvalidInput(
                "analysis inflight entry is too large".to_string(),
            ));
        }
    }
    Ok(())
}

fn read_inflight_strict(path: &Path) -> AppResult<AnalysisInflightJournal> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > MAX_INFLIGHT_BYTES {
        return Err(AppError::InvalidInput(
            "analysis inflight file is too large".to_string(),
        ));
    }
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > MAX_INFLIGHT_BYTES {
        return Err(AppError::InvalidInput(
            "analysis inflight file is too large".to_string(),
        ));
    }
    let journal: AnalysisInflightJournal = serde_json::from_slice(&bytes)?;
    validate_inflight(&journal)?;
    Ok(journal)
}

fn write_inflight_at_with_replacer<F>(
    path: &Path,
    journal: &AnalysisInflightJournal,
    replacer: F,
) -> AppResult<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    validate_inflight(journal)?;
    let serialized_size = serde_json::to_vec_pretty(journal)?
        .len()
        .checked_add(1)
        .ok_or_else(|| AppError::InvalidInput("analysis inflight file is too large".to_string()))?;
    if serialized_size as u64 > MAX_INFLIGHT_BYTES {
        return Err(AppError::InvalidInput(
            "analysis inflight file is too large".to_string(),
        ));
    }
    let value = serde_json::to_value(journal)?;
    write_json_atomically_with_replacer(path, &value, replacer)
}

fn remove_inflight_artifacts(path: &Path) -> AppResult<()> {
    for candidate in inflight_artifacts(path) {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn remove_inflight_artifacts_best_effort(path: &Path) {
    for candidate in inflight_artifacts(path) {
        match fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "analysis inflight cleanup failed for {}: {error}",
                candidate.display()
            ),
        }
    }
}

fn load_inflight_best_effort(analysis_path: &Path) -> Option<AnalysisInflightJournal> {
    let path = inflight_path(analysis_path);
    if !path.exists() {
        for stale in inflight_artifacts(&path).into_iter().skip(1) {
            let _ = fs::remove_file(stale);
        }
        return None;
    }
    match read_inflight_strict(&path) {
        Ok(journal) => Some(journal),
        Err(error) => {
            eprintln!("analysis inflight ignored for {}: {error}", path.display());
            remove_inflight_artifacts_best_effort(&path);
            None
        }
    }
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
    for candidate in all_analysis_artifacts(path) {
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

fn all_analysis_artifacts(path: &Path) -> Vec<PathBuf> {
    let mut artifacts = snapshot_artifacts(path);
    artifacts.extend(inflight_artifacts(&inflight_path(path)));
    artifacts
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

        fn inflight_path(&self) -> PathBuf {
            self.0.join("analysis.inflight.json")
        }

        fn transcript_path(&self) -> PathBuf {
            self.0.join("transcript.srt")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn checkpointed(fingerprint: &str, revision: u64, marker: &str) -> Value {
        checkpointed_at(fingerprint, revision, 0, marker)
    }

    fn checkpointed_at(
        fingerprint: &str,
        revision: u64,
        next_cue_offset: usize,
        marker: &str,
    ) -> Value {
        json!({
            "subtitles": [],
            "keyPhrases": [],
            "marker": marker,
            "checkpoint": {
                "version": 1,
                "transcriptFingerprint": fingerprint,
                "nextCueOffset": next_cue_offset,
                "phase": "cues",
                "revision": revision
            }
        })
    }

    fn inflight_entry(cue_offset: usize, text: &str) -> AnalysisInflightEntry {
        AnalysisInflightEntry {
            cue_offset,
            subtitle: json!({
                "index": cue_offset + 1,
                "time": cue_offset as f64,
                "endTime": cue_offset as f64 + 1.0,
                "text": text,
                "translation": format!("{text}-translated"),
                "isKeyPoint": false,
                "highlightWords": {},
                "keyNotes": {},
                "highlightTranslations": {}
            }),
        }
    }

    fn inflight_journal(
        journal_id: &str,
        start_cue_offset: usize,
        entries: Vec<AnalysisInflightEntry>,
    ) -> AnalysisInflightJournal {
        AnalysisInflightJournal {
            version: INFLIGHT_VERSION,
            journal_id: journal_id.to_string(),
            transcript_generation: "sha256:raw".to_string(),
            transcript_fingerprint: "sha256:semantic".to_string(),
            analysis_style: "neutral".to_string(),
            base_revision: 0,
            start_cue_offset,
            end_cue_offset: start_cue_offset + 50,
            entries,
        }
    }

    #[test]
    fn inflight_valid_round_trip() {
        let dir = TestDir::new("inflight-round-trip");
        let path = dir.inflight_path();
        let expected = inflight_journal(
            "j1",
            50,
            vec![inflight_entry(50, "first"), inflight_entry(51, "second")],
        );

        write_inflight_at_with_replacer(&path, &expected, replace_analysis_file).unwrap();

        assert_eq!(read_inflight_strict(&path).unwrap(), expected);
        assert_eq!(
            load_inflight_best_effort(&dir.analysis_path()),
            Some(expected)
        );
    }

    #[test]
    fn inflight_rejects_duplicate_and_out_of_range_offsets() {
        let dir = TestDir::new("inflight-invalid-offsets");
        let path = dir.inflight_path();

        let duplicate = inflight_journal(
            "j1",
            0,
            vec![inflight_entry(0, "first"), inflight_entry(0, "again")],
        );
        assert!(write_inflight_at_with_replacer(&path, &duplicate, replace_analysis_file).is_err());

        let out_of_range = inflight_journal("j1", 50, vec![inflight_entry(49, "before")]);
        assert!(
            write_inflight_at_with_replacer(&path, &out_of_range, replace_analysis_file).is_err()
        );
        assert!(!path.exists());
    }

    #[test]
    fn inflight_oversized_file_is_ignored_and_removed() {
        let dir = TestDir::new("inflight-oversized-file");
        let path = dir.inflight_path();
        fs::write(&path, vec![b' '; MAX_INFLIGHT_BYTES as usize + 1]).unwrap();
        fs::write(path.with_extension("json.tmp"), b"temporary").unwrap();
        fs::write(path.with_extension("json.bak"), b"backup").unwrap();

        assert_eq!(load_inflight_best_effort(&dir.analysis_path()), None);
        assert!(!path.exists());
        assert!(!path.with_extension("json.tmp").exists());
        assert!(!path.with_extension("json.bak").exists());
    }

    #[test]
    fn inflight_rejects_oversized_entry() {
        let dir = TestDir::new("inflight-oversized-entry");
        let path = dir.inflight_path();
        let huge = "x".repeat(MAX_INFLIGHT_ENTRY_BYTES + 1);
        let journal = inflight_journal("j1", 0, vec![inflight_entry(0, &huge)]);

        assert!(write_inflight_at_with_replacer(&path, &journal, replace_analysis_file).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn inflight_replacement_failure_preserves_previous_file() {
        let dir = TestDir::new("inflight-replace-failure");
        let path = dir.inflight_path();
        let old = inflight_journal("j1", 0, vec![inflight_entry(0, "old")]);
        write_inflight_at_with_replacer(&path, &old, replace_analysis_file).unwrap();

        let result = write_inflight_at_with_replacer(
            &path,
            &inflight_journal(
                "j1",
                0,
                vec![inflight_entry(0, "old"), inflight_entry(1, "new")],
            ),
            |_temporary, _destination| Err(std::io::Error::other("replace failed")),
        );

        assert!(result.is_err());
        assert_eq!(read_inflight_strict(&path).unwrap(), old);
    }

    fn seed_analysis_and_inflight(path: &Path, journal_id: &str) -> AnalysisSessionStart {
        let mut store = AnalysisStore::default();
        let session = store
            .begin_at("v1", path, false, "sha256:raw", false, "neutral")
            .unwrap();
        store
            .save_at(
                "v1",
                path,
                &session.lease,
                checkpointed_at("sha256:semantic", 0, 0, "base"),
            )
            .unwrap();
        store
            .save_inflight_at(
                "v1",
                path,
                &session.lease,
                inflight_journal(journal_id, 0, vec![inflight_entry(0, "first")]),
            )
            .unwrap();
        session
    }

    fn seeded_store_with_inflight(path: &Path, video_id: &str, journal_id: &str) -> AnalysisStore {
        let mut store = AnalysisStore::default();
        let session = store
            .begin_at(
                video_id,
                path,
                false,
                "sha256:raw",
                false,
                "neutral",
            )
            .unwrap();
        store
            .save_at(
                video_id,
                path,
                &session.lease,
                checkpointed_at("sha256:semantic", 0, 0, "base"),
            )
            .unwrap();
        store
            .save_inflight_at(
                video_id,
                path,
                &session.lease,
                inflight_journal(journal_id, 0, vec![inflight_entry(0, "first")]),
            )
            .unwrap();
        store
    }

    #[test]
    fn inflight_save_requires_current_lease_and_monotonic_entries() {
        let dir = TestDir::new("inflight-lease");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let session = store
            .begin_at("v1", &path, false, "sha256:raw", false, "neutral")
            .unwrap();
        store
            .save_at(
                "v1",
                &path,
                &session.lease,
                checkpointed_at("sha256:semantic", 0, 0, "base"),
            )
            .unwrap();

        let one = inflight_journal("j1", 0, vec![inflight_entry(0, "first")]);
        assert_eq!(
            store
                .save_inflight_at("v1", &path, "wrong", one.clone())
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_eq!(
            store
                .save_inflight_at("v1", &path, &session.lease, one.clone())
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );
        assert_eq!(
            store
                .save_inflight_at("v1", &path, &session.lease, one)
                .unwrap()
                .status,
            SessionSaveStatus::AlreadyCurrent
        );
        assert_eq!(
            store
                .save_inflight_at(
                    "v1",
                    &path,
                    &session.lease,
                    inflight_journal(
                        "j1",
                        0,
                        vec![inflight_entry(0, "first"), inflight_entry(1, "second")],
                    ),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );
        assert_eq!(
            store
                .save_inflight_at(
                    "v1",
                    &path,
                    &session.lease,
                    inflight_journal(
                        "j1",
                        0,
                        vec![inflight_entry(0, "changed"), inflight_entry(1, "second")],
                    ),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
    }

    #[test]
    fn canonical_advance_makes_leftover_inflight_stale() {
        let dir = TestDir::new("inflight-after-commit");
        let path = dir.analysis_path();
        let mut store = seeded_store_with_inflight(&path, "v1", "j1");
        let lease = store.active["v1"].token.clone();
        let outcome = store
            .save_at_with_inflight_remover(
                "v1",
                &path,
                &lease,
                checkpointed_at("sha256:semantic", 1, 50, "committed"),
                |_path| Err(std::io::Error::other("journal busy")),
            )
            .unwrap();
        assert_eq!(outcome.status, SessionSaveStatus::Applied);
        assert!(inflight_path(&path).exists());

        let mut restarted = AnalysisStore::default();
        let opened = restarted
            .begin_at("v1", &path, false, "sha256:raw", false, "neutral")
            .unwrap();
        assert!(opened.inflight.is_none());
        assert!(!inflight_path(&path).exists());
    }

    #[test]
    fn new_store_adopts_matching_inflight_with_a_new_lease() {
        let dir = TestDir::new("inflight-restart");
        let path = dir.analysis_path();
        let original = seed_analysis_and_inflight(&path, "j1");
        let mut restarted = AnalysisStore::default();
        let opened = restarted
            .begin_at("v1", &path, false, "sha256:raw", false, "neutral")
            .unwrap();

        assert_ne!(opened.lease, original.lease);
        assert_eq!(
            opened
                .inflight
                .as_ref()
                .map(|journal| journal.journal_id.as_str()),
            Some("j1")
        );
    }

    #[test]
    fn reset_removes_inflight_and_rejects_the_old_lease() {
        let dir = TestDir::new("inflight-reset");
        let path = dir.analysis_path();
        let mut store = seeded_store_with_inflight(&path, "v1", "j1");
        let old_lease = store.active["v1"].token.clone();
        let fresh = store
            .begin_at("v1", &path, true, "sha256:new", false, "neutral")
            .unwrap();

        assert!(!inflight_path(&path).exists());
        assert_eq!(
            store
                .save_inflight_at(
                    "v1",
                    &path,
                    &old_lease,
                    inflight_journal("late", 0, vec![inflight_entry(0, "late")]),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_ne!(fresh.lease, old_lease);
    }

    #[test]
    fn restart_discards_inflight_for_another_generation_or_style() {
        for (name, generation, style) in [
            ("inflight-wrong-generation", "sha256:other", "neutral"),
            ("inflight-wrong-style", "sha256:raw", "formal"),
        ] {
            let dir = TestDir::new(name);
            let path = dir.analysis_path();
            seed_analysis_and_inflight(&path, "j1");

            let mut restarted = AnalysisStore::default();
            let opened = restarted
                .begin_at("v1", &path, false, generation, false, style)
                .unwrap();

            assert!(opened.inflight.is_none());
            assert!(!inflight_path(&path).exists());
        }
    }

    #[test]
    fn discard_inflight_requires_the_current_lease_and_journal_id() {
        let dir = TestDir::new("inflight-discard");
        let path = dir.analysis_path();
        let mut store = seeded_store_with_inflight(&path, "v1", "j1");
        let lease = store.active["v1"].token.clone();

        assert_eq!(
            store
                .discard_inflight_at("v1", &path, "wrong", "j1")
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_eq!(
            store
                .discard_inflight_at("v1", &path, &lease, "other")
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert!(inflight_path(&path).exists());
        assert_eq!(
            store
                .discard_inflight_at("v1", &path, &lease, "j1")
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );
        assert!(!inflight_path(&path).exists());
        assert_eq!(
            store
                .discard_inflight_at("v1", &path, &lease, "j1")
                .unwrap()
                .status,
            SessionSaveStatus::AlreadyCurrent
        );
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn revoked_lease_cannot_write_after_an_explicit_reset() {
        let dir = TestDir::new("revoked-after-reset");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();

        let old = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();
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

        let fresh = store
            .begin_at("v1", &path, true, "sha256:test", false, "colloquial")
            .unwrap();
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
        store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();

        let error = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap_err();
        assert!(error.to_string().contains("already active"));
    }

    #[test]
    fn revisions_only_advance_within_one_fingerprint() {
        let dir = TestDir::new("revision-order");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let session = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();

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
        let session = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();
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
        let first = first_process
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();
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
        let resumed = restarted_process
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();

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
        let started = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();

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
        let started = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();

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
        let error = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap_err();

        assert!(error.to_string().contains("ambiguous"));
        assert!(!path.exists());
    }

    #[test]
    fn malformed_checkpoint_payload_is_rejected_before_writing() {
        let dir = TestDir::new("malformed-checkpoint");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let session = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();

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
    fn transcript_bound_lease_rejects_saves_after_the_transcript_changes() {
        let dir = TestDir::new("transcript-generation-save");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.transcript_path();
        fs::write(&transcript_path, "old transcript").unwrap();
        let mut store = AnalysisStore::default();
        let started = store
            .begin_for_transcript_at(
                "v1",
                &transcript_path,
                &analysis_path,
                true,
                None,
                "colloquial",
            )
            .unwrap()
            .unwrap();
        assert_eq!(started.transcript, "old transcript");
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &analysis_path,
                    &started.session.lease,
                    checkpointed("sha256:old", 0, "old"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Applied
        );

        fs::write(&transcript_path, "new transcript").unwrap();
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &analysis_path,
                    &started.session.lease,
                    checkpointed("sha256:old", 1, "late"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
        assert_eq!(read(&analysis_path)["marker"], "old");
    }

    #[test]
    fn stale_transcript_generation_cannot_reset_a_new_cloud_snapshot() {
        let dir = TestDir::new("transcript-generation-reset");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.transcript_path();
        fs::write(&transcript_path, "old transcript").unwrap();
        fs::write(
            &analysis_path,
            serde_json::to_vec_pretty(&checkpointed("sha256:old", 0, "old")).unwrap(),
        )
        .unwrap();
        let mut store = AnalysisStore::default();
        let old = store
            .begin_for_transcript_at(
                "v1",
                &transcript_path,
                &analysis_path,
                false,
                None,
                "colloquial",
            )
            .unwrap()
            .unwrap();

        fs::write(&transcript_path, "new transcript").unwrap();
        fs::write(
            &analysis_path,
            serde_json::to_vec_pretty(&checkpointed("sha256:new", 4, "cloud")).unwrap(),
        )
        .unwrap();
        let error = store
            .begin_for_transcript_at(
                "v1",
                &transcript_path,
                &analysis_path,
                true,
                Some(&old.transcript_generation),
                "colloquial",
            )
            .unwrap_err();

        assert!(error.to_string().contains("transcript changed"));
        assert_eq!(read(&analysis_path)["marker"], "cloud");
    }

    #[test]
    fn deletion_revokes_before_a_later_filesystem_failure() {
        let dir = TestDir::new("delete-revokes-first");
        let path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        let old = store
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();
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

    #[test]
    fn delete_snapshot_removes_analysis_and_inflight_artifacts() {
        let dir = TestDir::new("delete-all-analysis-artifacts");
        let analysis_path = dir.analysis_path();
        let mut store = AnalysisStore::default();
        for path in all_analysis_artifacts(&analysis_path) {
            fs::write(&path, b"stale").unwrap();
        }

        store
            .delete_snapshot_at_with("v1", &analysis_path, |path| fs::remove_file(path))
            .unwrap();

        assert!(all_analysis_artifacts(&analysis_path)
            .into_iter()
            .all(|path| !path.exists()));
    }

    #[test]
    fn destructive_boundary_blocks_a_new_begin_until_cleanup_finishes() {
        use std::sync::{mpsc, Arc};
        use std::thread;
        use std::time::Duration;

        let dir = TestDir::new("destructive-boundary");
        let path = dir.analysis_path();
        let store = Arc::new(Mutex::new(AnalysisStore::default()));
        let old = store
            .lock()
            .unwrap()
            .begin_at("v1", &path, false, "sha256:test", false, "colloquial")
            .unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let destructive_store = Arc::clone(&store);
        let destructive = thread::spawn(move || {
            with_store_destructive_boundary(&destructive_store, "v1", || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
        });
        entered_rx.recv().unwrap();

        let (begin_tx, begin_rx) = mpsc::channel();
        let begin_store = Arc::clone(&store);
        let begin_path = path.clone();
        let begin = thread::spawn(move || {
            let result = begin_store
                .lock()
                .unwrap()
                .begin_at(
                    "v1",
                    &begin_path,
                    false,
                    "sha256:test",
                    false,
                    "colloquial",
                );
            begin_tx.send(result).unwrap();
        });

        assert!(begin_rx.recv_timeout(Duration::from_millis(30)).is_err());
        release_tx.send(()).unwrap();
        destructive.join().unwrap();
        assert!(begin_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        begin.join().unwrap();

        assert_eq!(
            store
                .lock()
                .unwrap()
                .save_at(
                    "v1",
                    &path,
                    &old.lease,
                    checkpointed("sha256:old", 0, "late"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
    }

    #[test]
    fn cloud_install_replaces_transcript_and_analysis_and_revokes_old_lease() {
        let dir = TestDir::new("materialized-pair");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.0.join("transcript.srt");
        fs::write(&transcript_path, "old transcript").unwrap();
        let mut store = AnalysisStore::default();
        let old = store
            .begin_at(
                "v1",
                &analysis_path,
                false,
                "sha256:test",
                false,
                "colloquial",
            )
            .unwrap();
        store
            .save_at(
                "v1",
                &analysis_path,
                &old.lease,
                checkpointed("sha256:old", 0, "old"),
            )
            .unwrap();

        replace_materialized_snapshot_at(
            &mut store,
            "v1",
            &transcript_path,
            &analysis_path,
            "new transcript",
            checkpointed("sha256:new", 4, "cloud"),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&transcript_path).unwrap(),
            "new transcript"
        );
        assert_eq!(read(&analysis_path)["marker"], "cloud");
        assert_eq!(
            store
                .save_at(
                    "v1",
                    &analysis_path,
                    &old.lease,
                    checkpointed("sha256:old", 1, "late"),
                )
                .unwrap()
                .status,
            SessionSaveStatus::Rejected
        );
    }

    #[test]
    fn successful_materialized_replacement_removes_old_inflight() {
        let dir = TestDir::new("replace-clears-inflight");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.transcript_path();
        fs::write(&transcript_path, "old transcript").unwrap();
        seed_analysis_and_inflight(&analysis_path, "j-old");
        let mut store = AnalysisStore::default();

        replace_materialized_snapshot_at(
            &mut store,
            "v1",
            &transcript_path,
            &analysis_path,
            "new transcript",
            checkpointed_at("sha256:new", 4, 100, "cloud"),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&transcript_path).unwrap(),
            "new transcript"
        );
        assert!(!inflight_path(&analysis_path).exists());
    }

    #[test]
    fn failed_materialized_replacement_keeps_matching_old_inflight() {
        let dir = TestDir::new("replace-rollback-keeps-inflight");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.transcript_path();
        fs::write(&transcript_path, "old transcript").unwrap();
        seed_analysis_and_inflight(&analysis_path, "j-old");
        let old_journal = read_inflight_strict(&inflight_path(&analysis_path)).unwrap();
        let mut store = AnalysisStore::default();

        let result = replace_materialized_snapshot_at_with(
            &mut store,
            "v1",
            &transcript_path,
            &analysis_path,
            "new transcript",
            checkpointed_at("sha256:new", 4, 100, "cloud"),
            |_from, _to| Err(std::io::Error::other("install failed")),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&transcript_path).unwrap(),
            "old transcript"
        );
        assert_eq!(
            read_inflight_strict(&inflight_path(&analysis_path)).unwrap(),
            old_journal
        );
    }

    #[test]
    fn changed_transcript_generation_never_adopts_old_inflight() {
        let dir = TestDir::new("generation-rejects-inflight");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.transcript_path();
        fs::write(&transcript_path, "new transcript").unwrap();
        seed_analysis_and_inflight(&analysis_path, "j-old");
        let mut store = AnalysisStore::default();

        let opened = store
            .begin_for_transcript_at(
                "v1",
                &transcript_path,
                &analysis_path,
                false,
                None,
                "neutral",
            )
            .unwrap()
            .unwrap();

        assert!(opened.session.inflight.is_none());
    }

    #[test]
    fn interrupted_cloud_install_never_recovers_analysis_for_the_wrong_transcript() {
        let dir = TestDir::new("interrupted-materialized-pair");
        let analysis_path = dir.analysis_path();
        let transcript_path = dir.0.join("transcript.srt");
        fs::write(&transcript_path, "new transcript").unwrap();
        stage_json(
            &install_artifact(&analysis_path, "installing"),
            &checkpointed("sha256:new", 4, "new"),
        )
        .unwrap();
        stage_json(
            &install_artifact(&analysis_path, "install-backup"),
            &checkpointed("sha256:old", 3, "old"),
        )
        .unwrap();

        let mut restarted = AnalysisStore::default();
        let session = restarted
            .begin_at(
                "v1",
                &analysis_path,
                false,
                "sha256:test",
                false,
                "colloquial",
            )
            .unwrap();

        assert!(session.analysis.is_none());
        assert_eq!(
            fs::read_to_string(transcript_path).unwrap(),
            "new transcript"
        );
        assert!(!analysis_path.exists());
    }

    #[test]
    fn rollback_failure_never_restores_old_analysis_beside_new_transcript() {
        use std::cell::RefCell;
        use std::rc::Rc;

        let dir = TestDir::new("rollback-failure");
        let transcript_path = dir.0.join("transcript.srt");
        let analysis_path = dir.analysis_path();
        let transcript_temporary = install_artifact(&transcript_path, "installing");
        let analysis_temporary = install_artifact(&analysis_path, "installing");
        let transcript_backup = install_artifact(&transcript_path, "install-backup");
        let analysis_backup = install_artifact(&analysis_path, "install-backup");
        let operations = Rc::new(RefCell::new(Vec::<String>::new()));
        let remove_operations = Rc::clone(&operations);
        let rename_operations = Rc::clone(&operations);

        let errors = rollback_materialized_install_with(
            &transcript_path,
            &analysis_path,
            &transcript_temporary,
            &analysis_temporary,
            &transcript_backup,
            &analysis_backup,
            MaterializedInstallState {
                had_transcript: true,
                had_analysis: true,
                transcript_backed_up: true,
                analysis_backed_up: true,
                transcript_committed: true,
                analysis_committed: false,
            },
            |path| {
                remove_operations
                    .borrow_mut()
                    .push(format!("remove:{}", path.display()));
                if path == transcript_path {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "new transcript is locked",
                    ))
                } else {
                    Ok(())
                }
            },
            |from, to| {
                rename_operations.borrow_mut().push(format!(
                    "rename:{}->{}",
                    from.display(),
                    to.display()
                ));
                Ok(())
            },
        );

        assert!(errors
            .iter()
            .any(|error| error.contains("new transcript is locked")));
        assert!(errors
            .iter()
            .any(|error| error.contains("analysis restore skipped")));
        assert!(!operations.borrow().iter().any(|operation| {
            operation
                == &format!(
                    "rename:{}->{}",
                    analysis_backup.display(),
                    analysis_path.display()
                )
        }));
    }
}
