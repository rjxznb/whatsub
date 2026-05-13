; NSIS installer hooks for whatsub.
;
; The "Delete application data" checkbox in Tauri's default NSIS
; uninstaller targets paths derived from the bundle IDENTIFIER:
;
;   $APPDATA\com.whatsub.app
;   $LOCALAPPDATA\com.whatsub.app
;
; Our Rust core/paths.rs writes data to a path derived from the
; productName instead:
;
;   $APPDATA\whatsub
;
; (because dirs::data_dir() returns %APPDATA% on Windows and we
; .join("whatsub") onto it).
;
; So Tauri's built-in cleanup deletes a directory that doesn't
; exist for us, and the user's actual data — settings, library
; index, vocabulary, license, cookies, downloaded videos, Whisper
; models — survives the uninstall even when the box is ticked.
;
; This hook patches that mismatch: after Tauri runs its standard
; uninstall section, if the user picked "Delete application data"
; we also recursively remove the productName-keyed paths.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState == 1
    RMDir /r "$APPDATA\whatsub"
    RMDir /r "$LOCALAPPDATA\whatsub"
  ${EndIf}
!macroend
