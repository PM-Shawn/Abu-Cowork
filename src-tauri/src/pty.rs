//! Terminal pty session manager — backs the workspace "terminal" tab
//! (`@xterm/xterm` frontend, see `TerminalTab.tsx`) with a real cross-platform
//! pseudo-terminal via `portable-pty`.
//!
//! ## Lifecycle
//! - `pty_spawn` opens a pty, spawns a login shell into it, and starts a
//!   background thread that streams raw output bytes to the frontend via
//!   `pty://data/{id}` events. On EOF/error it emits `pty://exit/{id}` with
//!   the child's exit code (or `null` if unavailable) and removes the
//!   session.
//! - `pty_write` / `pty_resize` look up the session by id and act on it.
//! - `pty_kill` best-effort kills the child and removes the session; the
//!   reader thread notices EOF shortly after and exits on its own.
//!
//! ## Locking discipline
//! The `Mutex<HashMap<String, PtySession>>` is only ever held for quick
//! lookups/inserts/removals — never across a blocking read. The reader
//! thread gets its own cloned reader handle up front (before the session is
//! inserted into the map) and never touches the lock while blocked in
//! `read()`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

/// Bytes read per `reader.read()` call. Not a protocol constant — just a
/// reasonable chunk size for streaming terminal output.
const READ_CHUNK_SIZE: usize = 8192;

struct PtySession {
    /// Kept for `pty_resize` (informs the kernel + child of window size).
    master: Box<dyn MasterPty + Send>,
    /// User keystrokes (from xterm's `onData`) are written here.
    writer: Box<dyn Write + Send>,
    /// Kept for `pty_kill`.
    child: Box<dyn Child + Send + Sync>,
}

/// Tauri-managed global state — mirrors the `McpState` pattern in `lib.rs`
/// (a `Mutex<HashMap<id, session>>` registered once via `.manage(...)`).
#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Resolve the shell(s) to try spawning, in priority order.
///
/// - Unix: `$SHELL` first (if set), then `/bin/zsh` → `/bin/bash` → `/bin/sh`.
/// - Windows: `powershell.exe` then `cmd.exe`.
///
/// Returning a list (rather than a single guess) lets `pty_spawn` fall back
/// automatically if the preferred shell fails to spawn (e.g. a stale `$SHELL`
/// pointing at a since-removed custom shell).
fn candidate_shells() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        vec!["powershell.exe".to_string(), "cmd.exe".to_string()]
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut candidates = Vec::new();
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.trim().is_empty() {
                candidates.push(shell);
            }
        }
        for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if !candidates.iter().any(|s| s == fallback) {
                candidates.push(fallback.to_string());
            }
        }
        candidates
    }
}

/// Spawn a new pty session and start streaming its output.
///
/// `cwd`, when provided and an existing directory, becomes the shell's
/// starting directory (typically the active conversation's workspace dir —
/// resolved on the frontend); otherwise the shell starts in its own default
/// (usually the user's home directory).
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<(), String> {
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.contains_key(&id) {
            return Err(format!("pty session '{}' already running", id));
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {}", e))?;

    let valid_cwd = cwd.filter(|dir| std::path::Path::new(dir).is_dir());

    let shells = candidate_shells();
    let mut last_err: Option<String> = None;
    let mut spawned: Option<Box<dyn Child + Send + Sync>> = None;
    for shell in &shells {
        let mut cmd = CommandBuilder::new(shell);
        #[cfg(not(target_os = "windows"))]
        cmd.env("TERM", "xterm-256color");
        if let Some(dir) = &valid_cwd {
            cmd.cwd(dir);
        }
        match pair.slave.spawn_command(cmd) {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    // Slave end is only needed to spawn the child; drop it now (matches the
    // portable-pty example — the child has already inherited the fds it needs).
    drop(pair.slave);

    let child = spawned.ok_or_else(|| {
        last_err.unwrap_or_else(|| "no shell could be spawned".to_string())
    })?;

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {}", e))?;

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        // Re-check under lock — spawning above was not atomic with this insert.
        if sessions.contains_key(&id) {
            return Err(format!("pty session '{}' already running", id));
        }
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let app_clone = app.clone();
    let id_clone = id.clone();
    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; READ_CHUNK_SIZE];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk: Vec<u8> = buf[..n].to_vec();
                    let _ = app_clone.emit(&format!("pty://data/{}", id_clone), chunk);
                }
                Err(_) => break,
            }
        }

        // Remove the session (quick, under lock), then reap the child
        // (blocking `wait()`) *outside* the lock.
        let pty_state = app_clone.state::<PtyState>();
        let removed = {
            let mut sessions = pty_state
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            sessions.remove(&id_clone)
        };
        let exit_code: Option<i32> = removed.and_then(|mut session| {
            session
                .child
                .wait()
                .ok()
                .map(|status| status.exit_code() as i32)
        });

        let _ = app_clone.emit(&format!("pty://exit/{}", id_clone), exit_code);
    });

    Ok(())
}

/// Write user input (raw keystrokes/pastes from xterm's `onData`) to a pty's
/// stdin.
#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("pty session '{}' not found", id))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("pty write error: {}", e))?;
    session
        .writer
        .flush()
        .map_err(|e| format!("pty flush error: {}", e))?;
    Ok(())
}

/// Inform the pty (and the shell inside it) of a terminal resize.
#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("pty session '{}' not found", id))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty resize error: {}", e))?;
    Ok(())
}

/// Best-effort kill + remove a pty session. Idempotent — killing an already
/// gone/never-existed id is not an error (the reader thread may have already
/// removed it on EOF).
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    // Take the session out of the map, then drop the lock BEFORE the
    // (blocking) kill + reap so we never hold the mutex across a wait().
    let removed = {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.remove(&id)
    };
    if let Some(mut session) = removed {
        let _ = session.child.kill();
        // Reap the killed child so it doesn't linger as a zombie until the
        // app exits (SIGKILL'd children are reaped promptly). The reader
        // thread's own reap path only runs when *it* removes the session on
        // EOF, so on this explicit-close path we must reap here.
        let _ = session.child.wait();
    }
    Ok(())
}
