use crate::core::paths;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::Path;

const AGENT_HISTORY_MAX_BYTES: usize = 5 * 1024 * 1024;
const AGENT_HISTORY_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AgentHistory {
    pub version: u32,
    #[serde(rename = "activeConversationId")]
    pub active_conversation_id: Option<String>,
    pub conversations: Vec<Conversation>,
}

impl Default for AgentHistory {
    fn default() -> Self {
        Self {
            version: AGENT_HISTORY_VERSION,
            active_conversation_id: None,
            conversations: vec![],
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(rename = "pageContextAtStart")]
    pub page_context_at_start: serde_json::Value,
    #[serde(rename = "summaryUpToMsgId")]
    pub summary_up_to_msg_id: Option<String>,
    pub summary: Option<String>,
    pub messages: Vec<serde_json::Value>,
}

/// Load + parse agent_history.json at `path`. Returns default (empty) if missing
/// or corrupt — corrupted JSON is logged but never blocks the user.
fn agent_history_load_from(path: &Path) -> AppResult<AgentHistory> {
    if !path.exists() {
        return Ok(AgentHistory::default());
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => {
            return Ok(AgentHistory::default());
        }
    };
    match serde_json::from_str::<AgentHistory>(&raw) {
        Ok(h) => Ok(h),
        Err(e) => {
            eprintln!(
                "[agent_history] corrupt at {}: {} — treating as empty",
                path.display(),
                e
            );
            Ok(AgentHistory::default())
        }
    }
}

/// Enforce 5MB hard cap. Pops the oldest conversation by `updated_at` until
/// the serialized size is at or under cap. Returns count popped.
///
/// Never partial-prunes within a conversation — dropping individual messages
/// from a kept conversation would leave the LLM context inconsistent.
fn enforce_size_cap(history: &mut AgentHistory) -> AppResult<usize> {
    let mut dropped = 0;
    loop {
        let serialized = serde_json::to_string(history)?;
        if serialized.len() <= AGENT_HISTORY_MAX_BYTES {
            return Ok(dropped);
        }
        if history.conversations.is_empty() {
            return Ok(dropped);
        }
        // Find index of oldest conversation by updated_at.
        let mut oldest_idx = 0;
        let mut oldest_ts = u64::MAX;
        for (i, c) in history.conversations.iter().enumerate() {
            if c.updated_at < oldest_ts {
                oldest_ts = c.updated_at;
                oldest_idx = i;
            }
        }
        history.conversations.remove(oldest_idx);
        dropped += 1;
    }
}

/// Save history to `path` atomically (.tmp + rename). Enforces 5MB cap first.
/// Returns the number of conversations dropped to satisfy the cap (0 if none).
fn agent_history_save_to(path: &Path, mut history: AgentHistory) -> AppResult<usize> {
    history.version = AGENT_HISTORY_VERSION;
    let dropped = enforce_size_cap(&mut history)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Atomic write: .tmp then rename
    let tmp = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(&history)?;
    std::fs::write(&tmp, serialized)?;
    std::fs::rename(&tmp, path)?;
    Ok(dropped)
}

#[tauri::command]
pub fn agent_history_load() -> AppResult<AgentHistory> {
    let path = paths::agent_history_path()?;
    agent_history_load_from(&path)
}

#[tauri::command]
pub fn agent_history_save(history: AgentHistory) -> AppResult<usize> {
    let path = paths::agent_history_path()?;
    agent_history_save_to(&path, history)
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_history_save_then_load_roundtrips() {
        let dir = std::env::temp_dir().join("whatsub-agent-test-1");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent_history.json");
        let history = super::AgentHistory {
            version: 1,
            active_conversation_id: Some("c1".into()),
            conversations: vec![super::Conversation {
                id: "c1".into(),
                title: "test".into(),
                created_at: 100,
                updated_at: 100,
                page_context_at_start: serde_json::json!({"pathname": "/library"}),
                summary_up_to_msg_id: None,
                summary: None,
                messages: vec![],
            }],
        };
        super::agent_history_save_to(&path, history.clone()).unwrap();
        let loaded = super::agent_history_load_from(&path).unwrap();
        assert_eq!(loaded.active_conversation_id, Some("c1".into()));
        assert_eq!(loaded.conversations.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_history_load_returns_default_on_missing_file() {
        let dir = std::env::temp_dir().join("whatsub-agent-test-2");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("never_existed.json");
        let loaded = super::agent_history_load_from(&path).unwrap();
        assert_eq!(loaded.conversations.len(), 0);
        assert_eq!(loaded.version, 1);
    }

    #[test]
    fn agent_history_load_treats_corrupt_as_default() {
        let dir = std::env::temp_dir().join("whatsub-agent-test-3");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent_history.json");
        std::fs::write(&path, "{ not valid json").unwrap();
        let loaded = super::agent_history_load_from(&path).unwrap();
        assert_eq!(loaded.conversations.len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_history_save_enforces_5mb_cap_dropping_oldest() {
        let dir = std::env::temp_dir().join("whatsub-agent-test-4");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent_history.json");

        // Each conversation ~1.5MB of dummy text. 5 of them = ~7.5MB > 5MB cap.
        let big_payload = "x".repeat(1_500_000);
        let history = super::AgentHistory {
            version: 1,
            active_conversation_id: None,
            conversations: (0..5)
                .map(|i| super::Conversation {
                    id: format!("c{}", i),
                    title: format!("conv {}", i),
                    created_at: 100 + i as u64,
                    updated_at: 100 + i as u64,
                    page_context_at_start: serde_json::json!({"pathname": "/library"}),
                    summary_up_to_msg_id: None,
                    summary: Some(big_payload.clone()),
                    messages: vec![],
                })
                .collect(),
        };
        let dropped = super::agent_history_save_to(&path, history.clone()).unwrap();
        assert!(dropped > 0, "expected at least one conversation dropped");
        let loaded = super::agent_history_load_from(&path).unwrap();
        // The newest (highest updated_at) must survive
        assert!(loaded.conversations.iter().any(|c| c.id == "c4"));
        // The oldest must be gone
        assert!(!loaded.conversations.iter().any(|c| c.id == "c0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_history_save_writes_atomically_via_tmp_rename() {
        // After save, no .tmp file should remain
        let dir = std::env::temp_dir().join("whatsub-agent-test-5");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent_history.json");
        super::agent_history_save_to(&path, super::AgentHistory::default()).unwrap();
        let tmp = path.with_extension("json.tmp");
        assert!(!tmp.exists(), "stray .tmp left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
