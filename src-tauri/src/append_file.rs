//! Native O(1) file append.
//!
//! `conversationStorage.ts`'s `appendToFile` used to be O(file size) per call:
//! Tauri's `@tauri-apps/plugin-fs` has no native append, so every append had to
//! read the whole file, concatenate in memory, and atomic-rewrite it (see
//! `atomic_write.rs`). For long conversations that means each new message costs
//! a full read + full rewrite of an ever-growing `messages.jsonl`.
//!
//! This module exposes a real append: `OpenOptions::new().append(true)` lets
//! the OS seek to EOF and write just the new bytes — O(1) in the size of
//! `data`, independent of how large the file already is.
//!
//! ### Atomicity trade-off (deliberately NOT the same guarantee as atomic_write)
//!
//! `atomic_write_text` (tempfile + fsync + rename) guarantees a reader never
//! observes a half-written file — the rename is a single atomic syscall, so
//! the target is always either fully-old or fully-new content.
//!
//! Native append does **not** have that guarantee: `write_all` can be
//! interrupted by a crash/kill/power-loss *mid-write*, leaving a half-written
//! last line appended to an otherwise-intact file. This is an accepted
//! trade-off for B1: `loadMessages` (`conversationStorage.ts`) already tolerates
//! corrupt JSONL lines by skipping them (per-line try/catch), so the worst case
//! of a crash during append is losing the *one* message that was mid-flight —
//! never the messages already durably on disk before this call started. That
//! is a much smaller blast radius than the old read+rewrite path, which could
//! (before the file-lock fix) corrupt/lose arbitrary lines under concurrent
//! writers. Callers that need the older strict atomicity should keep using
//! `atomic_write_text`; conversation message appends are fine with this
//! weaker guarantee given the existing damage-reduction on read.
//!
//! All FS work runs on the blocking thread pool (`spawn_blocking`) to avoid
//! blocking the Tokio reactor, matching the pattern in `atomic_write.rs`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use tauri::async_runtime::spawn_blocking;

/// Append `data` to the file at `path`, creating the file (and any missing
/// parent directories) if needed. Does **not** read existing content — this
/// is the whole point: cost is O(len(data)), not O(file size).
fn append_sync(path: &Path, data: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        // create_dir_all is idempotent — safe to call even if parent exists.
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({}) failed: {}", parent.display(), e))?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open({}) for append failed: {}", path.display(), e))?;

    file.write_all(data.as_bytes())
        .map_err(|e| format!("write_all({}) failed: {}", path.display(), e))?;
    file.flush()
        .map_err(|e| format!("flush({}) failed: {}", path.display(), e))?;
    Ok(())
}

/// Append `data` to the file at `path` (creating it and its parent
/// directories if they don't exist yet). Native O(1) append — no read of
/// existing content, unlike the atomic_write tempfile+rename path.
#[tauri::command]
pub async fn append_file_text(path: String, data: String) -> Result<(), String> {
    spawn_blocking(move || append_sync(Path::new(&path), &data))
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use tempfile::tempdir;

    #[test]
    fn two_appends_concatenate_in_order() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("messages.jsonl");

        append_sync(&target, "line one\n").unwrap();
        append_sync(&target, "line two\n").unwrap();

        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "line one\nline two\n"
        );
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("nested/deep/messages.jsonl");

        assert!(!target.parent().unwrap().exists());
        append_sync(&target, "first line\n").unwrap();

        assert!(target.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "first line\n");
    }

    #[test]
    fn concurrent_appends_do_not_lose_lines() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("concurrent.jsonl");
        // File must exist before concurrent OpenOptions::append callers race on it.
        fs::write(&target, "").unwrap();

        const N: usize = 20;
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let target = target.clone();
                thread::spawn(move || {
                    append_sync(&target, &format!("line-{}\n", i)).unwrap();
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        let content = fs::read_to_string(&target).unwrap();
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(
            lines.len(),
            N,
            "expected {} lines, got {}: {:?}",
            N,
            lines.len(),
            lines
        );
        // Every line-N marker must be present exactly once — append(true) opens
        // seek to EOF atomically per the POSIX/Windows append-mode contract, so
        // concurrent small writes shouldn't interleave or clobber each other.
        for i in 0..N {
            let marker = format!("line-{}", i);
            assert_eq!(
                lines.iter().filter(|l| **l == marker).count(),
                1,
                "marker {} missing or duplicated",
                marker
            );
        }
    }
}
