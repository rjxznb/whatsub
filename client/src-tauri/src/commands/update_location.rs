//! Can the running app bundle actually be replaced in place?
//!
//! macOS updates work by overwriting the `.app` bundle where it currently
//! lives. Two very common situations make that impossible, and both surface
//! only as a raw `Read-only file system (os error 30)` AFTER the user has
//! already downloaded ~270 MB:
//!
//!   * the app is being run straight out of the mounted `.dmg` (`/Volumes/...`)
//!     because the user double-clicked it instead of dragging it to
//!     Applications — dmg mounts are read-only;
//!   * macOS App Translocation (Gatekeeper path randomisation) is running a
//!     quarantined copy from a randomised read-only mount under
//!     `/private/var/folders/.../AppTranslocation/<uuid>/d/whatsub.app`.
//!
//! Neither is fixable from inside the app — the user has to move the bundle to
//! /Applications and reopen it. So we detect it up front and say that, instead
//! of burning the download and then showing an OS errno.

use serde::Serialize;

/// Why an in-place update can't work, or `None` when the location looks fine.
/// Pure + path-only so it is unit-testable without touching a real filesystem.
pub fn classify_location(path: &str) -> Option<&'static str> {
    // Translocation first: a translocated path also lives under /private, and
    // the marker is unambiguous.
    if path.contains("/AppTranslocation/") {
        return Some("translocated");
    }
    // Anything mounted under /Volumes is a disk image or external mount. The
    // dmg case is the overwhelmingly common one.
    if path.starts_with("/Volumes/") {
        return Some("dmg");
    }
    None
}

#[derive(Serialize)]
pub struct UpdateLocation {
    /// Path of the running executable (diagnostics only).
    pub path: String,
    /// True when an in-place update should be possible.
    pub updatable: bool,
    /// "translocated" | "dmg" | "unwritable" when `updatable` is false.
    pub reason: Option<String>,
}

/// Report whether the running bundle can be updated in place.
///
/// Fails OPEN: if we can't determine the exe path we report `updatable: true`
/// rather than blocking an update that might have worked. The real install
/// still surfaces its own error in that case.
#[tauri::command]
pub async fn update_location() -> Result<UpdateLocation, String> {
    let path = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => {
            return Ok(UpdateLocation {
                path: String::new(),
                updatable: true,
                reason: None,
            })
        }
    };
    if let Some(reason) = classify_location(&path) {
        return Ok(UpdateLocation {
            path,
            updatable: false,
            reason: Some(reason.to_string()),
        });
    }
    Ok(UpdateLocation {
        path,
        updatable: true,
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_app_translocation() {
        let p = "/private/var/folders/x9/abc123/T/AppTranslocation/8F3C-4A/d/whatsub.app/Contents/MacOS/whatsub";
        assert_eq!(classify_location(p), Some("translocated"));
    }

    #[test]
    fn detects_running_from_a_mounted_dmg() {
        let p = "/Volumes/whatsub/whatsub.app/Contents/MacOS/whatsub";
        assert_eq!(classify_location(p), Some("dmg"));
    }

    #[test]
    fn a_normal_applications_install_is_updatable() {
        let p = "/Applications/whatsub.app/Contents/MacOS/whatsub";
        assert_eq!(classify_location(p), None);
    }

    #[test]
    fn windows_and_dev_paths_are_not_flagged() {
        // The classifier runs on every platform; nothing here should trip it.
        assert_eq!(classify_location(r"C:\Program Files\whatsub\whatsub.exe"), None);
        assert_eq!(classify_location("/Users/me/src/whatsub/target/debug/whatsub"), None);
    }

    #[test]
    fn a_volume_named_like_applications_still_counts_as_a_mount() {
        // Guard against a naive "contains /Applications" check being added.
        assert_eq!(
            classify_location("/Volumes/Applications/whatsub.app/Contents/MacOS/whatsub"),
            Some("dmg")
        );
    }
}
