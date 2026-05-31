use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::Path;

const LEARNER_PROFILE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LearnerProfile {
    pub version: u32,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    pub estimate: Estimate,
    #[serde(rename = "errorEvents")]
    pub error_events: Vec<ErrorEvent>,
    #[serde(rename = "masteryIndex")]
    pub mastery_index: MasteryIndex,
    pub goals: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Estimate {
    pub cefr: Option<String>,
    #[serde(rename = "vocabSize")]
    pub vocab_size: Option<u32>,
    #[serde(rename = "listeningLevel")]
    pub listening_level: Option<String>,
    pub confidence: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ErrorEvent {
    pub id: String,
    pub ts: u64,
    pub source: ErrorEventSource,
    pub pattern: String,
    pub detail: String,
    #[serde(rename = "userInput")]
    pub user_input: String,
    pub correction: String,
    pub resolved: bool,
    #[serde(rename = "resolvedAt")]
    pub resolved_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ErrorEventSource {
    #[serde(rename = "type")]
    pub kind: String,  // "lesson" | "roleplay" | "remediation"
    #[serde(rename = "videoId")]
    pub video_id: Option<String>,
    #[serde(rename = "cueIdx")]
    pub cue_idx: Option<u32>,
    #[serde(rename = "questionId")]
    pub question_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct MasteryIndex {
    #[serde(rename = "weakPatterns")]
    pub weak_patterns: Vec<WeakPattern>,
    #[serde(rename = "knownWords")]
    pub known_words: Vec<String>,
    #[serde(rename = "weakWords")]
    pub weak_words: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WeakPattern {
    pub pattern: String,
    pub occurrences: u32,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: u64,
    #[serde(rename = "sampleErrorIds")]
    pub sample_error_ids: Vec<String>,
    #[serde(rename = "lastRemediatedAt")]
    pub last_remediated_at: Option<u64>,
}

impl LearnerProfile {
    fn new_empty(now: u64) -> Self {
        Self {
            version: LEARNER_PROFILE_VERSION,
            created_at: now,
            updated_at: now,
            estimate: Estimate::default(),
            error_events: vec![],
            mastery_index: MasteryIndex::default(),
            goals: vec![],
        }
    }
}

// Fix 4: renamed from now_secs() → now_millis(), uses .as_millis() as u64.
// All learner-profile timestamps are milliseconds to match the TS Date.now()
// convention used by ErrorEvent.ts and the Task 7 remediation cooldown
// (which compares Date.now() − lastRemediatedAt against COOLDOWN_MS).
fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Path-injectable load. Tests use this with std::env::temp_dir().
pub fn learner_profile_load_from(path: &Path) -> AppResult<LearnerProfile> {
    if !path.exists() {
        return Ok(LearnerProfile::new_empty(now_millis()));
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Ok(LearnerProfile::new_empty(now_millis())),
    };
    match serde_json::from_str::<LearnerProfile>(&raw) {
        Ok(p) => Ok(p),
        Err(e) => {
            eprintln!(
                "[learner_profile] corrupt at {}: {} — treating as empty",
                path.display(),
                e
            );
            Ok(LearnerProfile::new_empty(now_millis()))
        }
    }
}

// Fix 1: atomic save via tmp + rename, mirroring agent_history_save_to.
// Prevents a mid-write crash from corrupting errorEvents (永不删除 核心数据).
pub fn learner_profile_save_to(path: &Path, profile: &LearnerProfile) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(profile).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Append one event and bump weak_patterns counts. Idempotent on event.id.
pub fn learner_profile_log_event_in(
    profile: &mut LearnerProfile,
    event: ErrorEvent,
) {
    if profile.error_events.iter().any(|e| e.id == event.id) {
        return; // dedupe
    }
    // Fix 4 (part 2): use event.ts for last_seen_at (consistent with
    // rebuild_index_in, which also derives last_seen_at from event.ts).
    // updated_at stays wall-clock (it's not compared cross-unit).
    profile.updated_at = now_millis();

    // Update weakPatterns
    if let Some(wp) = profile
        .mastery_index
        .weak_patterns
        .iter_mut()
        .find(|w| w.pattern == event.pattern)
    {
        wp.occurrences += 1;
        wp.last_seen_at = event.ts;
        wp.sample_error_ids.insert(0, event.id.clone());
        wp.sample_error_ids.truncate(5);
    } else {
        profile.mastery_index.weak_patterns.push(WeakPattern {
            pattern: event.pattern.clone(),
            occurrences: 1,
            last_seen_at: event.ts,
            sample_error_ids: vec![event.id.clone()],
            last_remediated_at: None,
        });
    }

    profile.error_events.push(event);
}

/// Mark events resolved by id, set last_remediated_at on their patterns.
pub fn learner_profile_resolve_events_in(
    profile: &mut LearnerProfile,
    ids: &[String],
) {
    let now = now_millis();
    let mut resolved_patterns: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for ev in profile.error_events.iter_mut() {
        if ids.contains(&ev.id) && !ev.resolved {
            ev.resolved = true;
            ev.resolved_at = Some(now);
            resolved_patterns.insert(ev.pattern.clone());
        }
    }
    for wp in profile.mastery_index.weak_patterns.iter_mut() {
        if resolved_patterns.contains(&wp.pattern) {
            wp.last_remediated_at = Some(now);
        }
    }
    // Fix 5: only bump updated_at when at least one event actually changed.
    let changed = !resolved_patterns.is_empty();
    if changed {
        profile.updated_at = now;
    }
}

/// Rebuild masteryIndex from errorEvents. Used after migrations or
/// in case the cached index gets stale. Pure recomputation, no I/O.
pub fn learner_profile_rebuild_index_in(profile: &mut LearnerProfile) {
    use std::collections::HashMap;
    let mut by_pattern: HashMap<String, Vec<(u64, String, Option<u64>)>> = HashMap::new();
    for ev in &profile.error_events {
        by_pattern
            .entry(ev.pattern.clone())
            .or_default()
            .push((ev.ts, ev.id.clone(), ev.resolved_at));
    }
    // Preserve existing last_remediated_at lookup (it's not derivable from
    // events alone — a remediation that resolved 5 events has the same ts on
    // all of them, so MAX of resolved_at IS last_remediated_at).
    let mut weak_patterns: Vec<WeakPattern> = by_pattern
        .into_iter()
        .map(|(pattern, mut occs)| {
            occs.sort_by_key(|(ts, _, _)| std::cmp::Reverse(*ts));
            let last_seen_at = occs.first().map(|(t, _, _)| *t).unwrap_or(0);
            let last_remediated_at = occs.iter().filter_map(|(_, _, r)| *r).max();
            let sample_error_ids = occs.iter().take(5).map(|(_, id, _)| id.clone()).collect();
            WeakPattern {
                pattern,
                occurrences: occs.len() as u32,
                last_seen_at,
                sample_error_ids,
                last_remediated_at,
            }
        })
        .collect();
    weak_patterns.sort_by_key(|w| std::cmp::Reverse(w.occurrences));
    profile.mastery_index.weak_patterns = weak_patterns;
}

#[tauri::command]
pub fn learner_profile_load() -> AppResult<LearnerProfile> {
    learner_profile_load_from(&paths::learner_profile_path()?)
}

#[tauri::command]
pub fn learner_profile_log_event(event: ErrorEvent) -> AppResult<()> {
    let path = paths::learner_profile_path()?;
    let mut profile = learner_profile_load_from(&path)?;
    learner_profile_log_event_in(&mut profile, event);
    learner_profile_save_to(&path, &profile)
}

#[tauri::command]
pub fn learner_profile_resolve_events(ids: Vec<String>) -> AppResult<()> {
    let path = paths::learner_profile_path()?;
    let mut profile = learner_profile_load_from(&path)?;
    learner_profile_resolve_events_in(&mut profile, &ids);
    learner_profile_save_to(&path, &profile)
}

#[tauri::command]
pub fn learner_profile_rebuild_index() -> AppResult<LearnerProfile> {
    let path = paths::learner_profile_path()?;
    let mut profile = learner_profile_load_from(&path)?;
    learner_profile_rebuild_index_in(&mut profile);
    learner_profile_save_to(&path, &profile)?;
    Ok(profile)
}

#[tauri::command]
pub fn learner_profile_export() -> AppResult<String> {
    let src = paths::learner_profile_path()?;
    let profile = learner_profile_load_from(&src)?;
    let downloads = dirs::download_dir()
        .ok_or_else(|| "could not determine downloads dir".to_string())?;
    let ts = now_millis();
    let dst = downloads.join(format!("whatsub_learner_profile_{}.json", ts));
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&dst, json).map_err(|e| e.to_string())?;
    Ok(dst.display().to_string())
}

#[tauri::command]
pub fn learner_profile_reset() -> AppResult<()> {
    let path = paths::learner_profile_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fix 2: collision-resistant temp path using nanoseconds + process id,
    // so parallel cargo test runs don't stomp each other's files.
    fn temp_path(name: &str) -> std::path::PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("whatsub_test_{}_{}_{}.json", name, std::process::id(), ts));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn ev(id: &str, pattern: &str) -> ErrorEvent {
        ErrorEvent {
            id: id.into(),
            ts: 0,
            source: ErrorEventSource {
                kind: "lesson".into(),
                video_id: None,
                cue_idx: None,
                question_id: None,
            },
            pattern: pattern.into(),
            detail: "".into(),
            user_input: "".into(),
            correction: "".into(),
            resolved: false,
            resolved_at: None,
        }
    }

    #[test]
    fn load_missing_returns_empty() {
        let p = temp_path("load_missing");
        let loaded = learner_profile_load_from(&p).unwrap();
        assert_eq!(loaded.version, LEARNER_PROFILE_VERSION);
        assert!(loaded.error_events.is_empty());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let p = temp_path("roundtrip");
        let mut profile = LearnerProfile::new_empty(now_millis());
        learner_profile_log_event_in(&mut profile, ev("e1", "past_tense_irregular"));
        learner_profile_save_to(&p, &profile).unwrap();
        let back = learner_profile_load_from(&p).unwrap();
        assert_eq!(back.error_events.len(), 1);
        assert_eq!(back.error_events[0].id, "e1");
    }

    #[test]
    fn log_event_is_idempotent_by_id() {
        let mut profile = LearnerProfile::new_empty(0);
        learner_profile_log_event_in(&mut profile, ev("e1", "p"));
        learner_profile_log_event_in(&mut profile, ev("e1", "p"));
        assert_eq!(profile.error_events.len(), 1);
        assert_eq!(profile.mastery_index.weak_patterns[0].occurrences, 1);
    }

    #[test]
    fn log_event_increments_weak_pattern() {
        let mut profile = LearnerProfile::new_empty(0);
        learner_profile_log_event_in(&mut profile, ev("e1", "past_tense_irregular"));
        learner_profile_log_event_in(&mut profile, ev("e2", "past_tense_irregular"));
        let wp = &profile.mastery_index.weak_patterns[0];
        assert_eq!(wp.occurrences, 2);
        assert_eq!(wp.sample_error_ids, vec!["e2", "e1"]);
    }

    #[test]
    fn resolve_events_marks_resolved_and_remediation_ts() {
        let mut profile = LearnerProfile::new_empty(0);
        learner_profile_log_event_in(&mut profile, ev("e1", "p"));
        learner_profile_resolve_events_in(&mut profile, &["e1".into()]);
        assert!(profile.error_events[0].resolved);
        assert!(profile.error_events[0].resolved_at.is_some());
        assert!(profile.mastery_index.weak_patterns[0].last_remediated_at.is_some());
    }

    #[test]
    fn rebuild_index_recomputes_from_events() {
        let mut profile = LearnerProfile::new_empty(0);
        profile.error_events.push(ErrorEvent {
            ts: 100,
            ..ev("e1", "past_tense_irregular")
        });
        profile.error_events.push(ErrorEvent {
            ts: 200,
            ..ev("e2", "past_tense_irregular")
        });
        profile.error_events.push(ErrorEvent {
            ts: 150,
            ..ev("e3", "article_missing")
        });
        learner_profile_rebuild_index_in(&mut profile);
        assert_eq!(profile.mastery_index.weak_patterns.len(), 2);
        // sorted by occurrences desc
        assert_eq!(profile.mastery_index.weak_patterns[0].pattern, "past_tense_irregular");
        assert_eq!(profile.mastery_index.weak_patterns[0].occurrences, 2);
        assert_eq!(profile.mastery_index.weak_patterns[0].last_seen_at, 200);
    }

    // Fix 3: test that a corrupt JSON file loads as empty without panicking.
    // The corrupt-JSON branch is load-bearing (the whole profile silently
    // resets), so this exercises the eprintln + fallback path.
    #[test]
    fn load_corrupt_returns_empty_and_does_not_panic() {
        let p = temp_path("corrupt");
        std::fs::write(&p, b"{ not valid json").unwrap();
        let loaded = learner_profile_load_from(&p).unwrap();
        assert_eq!(loaded.version, LEARNER_PROFILE_VERSION);
        assert!(loaded.error_events.is_empty());
        let _ = std::fs::remove_file(&p);
    }
}
