//! Abu native-helper (Phase 2 F10) — minimal loop.
//!
//! Reads NDJSON JSON-RPC requests on stdin (`{"id","method","params"}`), one per
//! line, and writes `{"id","result"}` or `{"id","error"}` per line on stdout.
//! Spawned by Electron main. Runs its work on the process main thread, which is
//! exactly what macOS's enigo/TSM input APIs require (in the Tauri app these had
//! to be dispatched to the main queue explicitly — here it's free).
//!
//! Methods in this minimal loop:
//!   - ping            → liveness
//!   - mouse_move {x?,y?} → move cursor (defaults to CURRENT position: a visual
//!                          no-op, so the acceptance run doesn't disturb the user)
//!   - capture_screen {out?} → capture the primary monitor to a PNG, return dims
//!
//! Next step adds the AX session-cache commands (ax_snapshot/press/set_value/
//! close_session) by extracting src-tauri's Tauri-free `*_impl` code.

use std::io::{BufRead, Write};

use enigo::{Coordinate, Enigo, Mouse, Settings};
use serde_json::{json, Value};
use xcap::Monitor;

#[cfg(target_os = "macos")]
mod ax;

/// Read a required string param, e.g. `session_id`.
fn require_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing required param '{key}'"))
}

/// Read a required u32 param, e.g. `element_id`.
fn require_u32(params: &Value, key: &str) -> Result<u32, String> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .ok_or_else(|| format!("missing required param '{key}'"))
}

fn handle(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "pong": true })),

        // ── Accessibility (AXUIElement) family — reuses src-tauri's
        // Tauri-free `*_impl` code via `ax` module (see src/ax.rs). ──

        "activate_app" => {
            #[cfg(target_os = "macos")]
            {
                let name = require_str(params, "name")?;
                let display = ax::activate_app_impl(name)?;
                Ok(json!({ "activated": display }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "ax_snapshot" => {
            #[cfg(target_os = "macos")]
            {
                let app = params.get("app").and_then(Value::as_str).map(str::to_string);
                let result = ax::ax_snapshot_impl(app)?;
                serde_json::to_value(result).map_err(|e| format!("serialize failed: {e}"))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "ax_press" => {
            #[cfg(target_os = "macos")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                ax::ax_press_impl(session_id, element_id)?;
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "ax_set_value" => {
            #[cfg(target_os = "macos")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                let text = require_str(params, "text")?;
                ax::ax_set_value_impl(session_id, element_id, text)?;
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "ax_perform_action" => {
            #[cfg(target_os = "macos")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                let action_name = require_str(params, "action_name")?;
                ax::ax_perform_action_impl(session_id, element_id, action_name)?;
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "ax_close_session" => {
            #[cfg(target_os = "macos")]
            {
                let session_id = require_str(params, "session_id")?;
                ax::ax_close_session_impl(session_id);
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "mouse_move" => {
            let mut enigo =
                Enigo::new(&Settings::default()).map_err(|e| format!("enigo init failed: {e}"))?;
            // Current position — also the default target, so an argument-less call
            // is a no-op that still exercises the full input-synth (TCC) path.
            let (cx, cy) = enigo.location().map_err(|e| format!("location failed: {e}"))?;
            let tx = params.get("x").and_then(Value::as_i64).map_or(cx, |v| v as i32);
            let ty = params.get("y").and_then(Value::as_i64).map_or(cy, |v| v as i32);
            enigo
                .move_mouse(tx, ty, Coordinate::Abs)
                .map_err(|e| format!("move_mouse failed: {e}"))?;
            Ok(json!({ "moved_to": [tx, ty], "was_at": [cx, cy] }))
        }

        "capture_screen" => {
            let monitors = Monitor::all().map_err(|e| format!("list monitors failed: {e}"))?;
            let monitor = monitors
                .into_iter()
                .next()
                .ok_or_else(|| "no monitor found".to_string())?;
            let img = monitor
                .capture_image()
                .map_err(|e| format!("capture failed: {e}"))?;
            let (w, h) = (img.width(), img.height());
            let out = params
                .get("out")
                .and_then(Value::as_str)
                .unwrap_or("/tmp/native-helper-capture.png");
            img.save(out).map_err(|e| format!("save failed: {e}"))?;
            Ok(json!({ "width": w, "height": h, "path": out }))
        }

        other => Err(format!("unknown method: {other}")),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(stdout, "{}", json!({ "error": format!("parse error: {e}") }));
                let _ = stdout.flush();
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        let resp = match handle(method, &params) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        let _ = writeln!(stdout, "{resp}");
        let _ = stdout.flush();
    }
}
