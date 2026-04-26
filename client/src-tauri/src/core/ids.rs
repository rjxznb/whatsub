use sha2::{Digest, Sha256};
use std::path::Path;

pub fn id_from_file_hash(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    Ok(hex[..12].to_string())
}

pub fn id_from_youtube_url(url: &str) -> Option<String> {
    let patterns = ["v=", "youtu.be/", "shorts/", "/embed/"];
    for p in &patterns {
        if let Some(idx) = url.find(p) {
            let start = idx + p.len();
            let candidate: String = url[start..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if candidate.len() == 11 {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn id_from_url_fallback(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let hex = hex::encode(hasher.finalize());
    format!("u_{}", &hex[..10])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_v_param() {
        assert_eq!(
            id_from_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn youtube_short() {
        assert_eq!(
            id_from_youtube_url("https://youtu.be/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn youtube_shorts() {
        assert_eq!(
            id_from_youtube_url("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn non_youtube_returns_none() {
        assert_eq!(
            id_from_youtube_url("https://www.bilibili.com/video/BV1xx411c7mu"),
            None
        );
    }

    #[test]
    fn url_fallback_is_stable() {
        let a = id_from_url_fallback("https://example.com/video");
        let b = id_from_url_fallback("https://example.com/video");
        assert_eq!(a, b);
        assert!(a.starts_with("u_"));
        assert_eq!(a.len(), 12);
    }
}
