//! Move files/folders to the OS trash instead of deleting them permanently.
//!
//! The workspace file tree uses this (rather than Tauri's `fs:remove`) so a
//! delete is recoverable: on macOS the entry lands in Finder's Trash, on
//! Windows the Recycle Bin, on Linux the XDG trash. Because this is our own
//! command it runs outside the `fs` plugin's scope — the caller (the file
//! tree) confines the target to the workspace root before invoking.
//!
//! Runs on the blocking pool: the `trash` crate performs synchronous I/O
//! (and, on macOS, may talk to Finder) which must not block the Tokio reactor.

use tauri::async_runtime::spawn_blocking;

/// Move a single file or directory to the OS trash. Returns an error string on
/// failure (missing path, permission denied, unsupported platform target).
#[tauri::command]
pub async fn move_to_trash(path: String) -> Result<(), String> {
    spawn_blocking(move || trash::delete(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("join error: {e}"))?
}
