//! Abu native-helper (Phase 2 F10) — minimal loop.
//!
//! Reads NDJSON JSON-RPC requests on stdin (`{"id","method","params"}`), one per
//! line, and writes `{"id","result"}` or `{"id","error"}` per line on stdout.
//! Spawned by Electron main. Runs its work on the process main thread, which is
//! exactly what macOS's enigo/TSM input APIs require (in the Tauri app these had
//! to be dispatched to the main queue explicitly — here it's free).
//!
//! Methods in this minimal loop:
//!   - ping                     → liveness
//!   - mouse_move {x?,y?}       → move cursor (defaults to CURRENT position: a
//!                                visual no-op, so the acceptance run doesn't
//!                                disturb the user)
//!   - mouse_click/mouse_scroll/mouse_drag, keyboard_type/keyboard_press →
//!     input synthesis (enigo), reusing src-tauri's `computer_use_impl.rs`
//!     verbatim via the `cu` module (see src/cu.rs) — same shapes as the
//!     shipping Tauri commands in src-tauri/src/computer_use.rs.
//!   - capture_screen / capture_screen_excluding → base64 PNG capture
//!     (ScreenshotResult: {base64, width, height, scale_factor, origin_x,
//!     origin_y}), also reused from computer_use_impl.rs.
//!   - check_macos_permissions / request_screen_recording → TCC checks,
//!     reused from computer_use_impl.rs.
//!
//! Also hosts the AX session-cache commands (ax_snapshot/press/set_value/
//! close_session) by extracting src-tauri's Tauri-free `*_impl` code (see
//! src/ax.rs, macOS-only).

use std::io::{BufRead, Write};

use enigo::{Coordinate, Enigo, Mouse, Settings};
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
mod ax;
// Computer Use (mouse/keyboard/screen-capture/TCC) — cross-platform (only the
// exclusion-capture + permission-check internals are macOS-gated, same as
// src-tauri). See src/cu.rs.
mod cu;

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

/// Read a required i32 param, e.g. mouse/drag coordinates.
fn require_i32(params: &Value, key: &str) -> Result<i32, String> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| format!("missing required param '{key}'"))
}

/// Optional i32 param (None when absent or null — distinct from `0`).
fn opt_i32(params: &Value, key: &str) -> Option<i32> {
    params.get(key).and_then(Value::as_i64).map(|v| v as i32)
}

/// Optional u32 param.
fn opt_u32(params: &Value, key: &str) -> Option<u32> {
    params.get(key).and_then(Value::as_u64).map(|v| v as u32)
}

/// Optional f64 param, e.g. `anchor_x`/`anchor_y`.
fn opt_f64(params: &Value, key: &str) -> Option<f64> {
    params.get(key).and_then(Value::as_f64)
}

/// Optional string param, e.g. `button`.
fn opt_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Optional string array param, e.g. `modifiers`.
fn opt_str_vec(params: &Value, key: &str) -> Option<Vec<String>> {
    params.get(key).and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    })
}

fn handle(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "ping" => Ok(json!({ "pong": true })),

        // ── Accessibility (AXUIElement) family — reuses src-tauri's
        // Tauri-free `*_impl` code via `ax` module (see src/ax.rs). ──

        "activate_app" => {
            #[cfg(target_os = "macos")]
            {
                // Frontend sends { appName } (computerTools.ts:523,545) →
                // nativeHelperManager casing → app_name. Returns a BARE string
                // (invoke<string>), matching the Rust activate_app's Result<String>.
                let name = require_str(params, "app_name")?;
                let display = ax::activate_app_impl(name)?;
                Ok(Value::String(display))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("AX is macOS-only".to_string())
            }
        }

        "ax_snapshot" => {
            #[cfg(target_os = "macos")]
            {
                // Frontend sends { appName } (computerTools.ts:551) → app_name.
                let app = params.get("app_name").and_then(Value::as_str).map(str::to_string);
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

        // ── Computer Use — screen capture (base64 PNG, matches computer_use.rs's
        // ScreenshotResult shape exactly: {base64, width, height, scale_factor,
        // origin_x, origin_y} — NOT the old {width, height, path}-to-disk shape
        // this arm used to return before the cu module reuse). ──
        "capture_screen" => {
            let x = opt_i32(params, "x");
            let y = opt_i32(params, "y");
            let width = opt_u32(params, "width");
            let height = opt_u32(params, "height");
            let max_width = opt_u32(params, "max_width");
            let result = cu::capture_screen_impl(x, y, width, height, max_width)?;
            serde_json::to_value(result).map_err(|e| format!("serialize failed: {e}"))
        }

        "capture_screen_excluding" => {
            let exclude_window_id = require_u32(params, "exclude_window_id")?;
            let x = opt_i32(params, "x");
            let y = opt_i32(params, "y");
            let width = opt_u32(params, "width");
            let height = opt_u32(params, "height");
            let max_width = opt_u32(params, "max_width");
            let anchor_x = opt_f64(params, "anchor_x");
            let anchor_y = opt_f64(params, "anchor_y");
            #[cfg(target_os = "macos")]
            {
                let result = cu::capture_excluding_impl(
                    exclude_window_id,
                    x,
                    y,
                    width,
                    height,
                    max_width,
                    anchor_x,
                    anchor_y,
                )?;
                serde_json::to_value(result).map_err(|e| format!("serialize failed: {e}"))
            }
            #[cfg(not(target_os = "macos"))]
            {
                // xcap doesn't support exclusion — fall back to regular capture,
                // same as computer_use.rs's non-macOS branch.
                let _ = (exclude_window_id, anchor_x, anchor_y);
                let result = cu::capture_screen_impl(x, y, width, height, max_width)?;
                serde_json::to_value(result).map_err(|e| format!("serialize failed: {e}"))
            }
        }

        "check_macos_permissions" => {
            let perms = cu::check_macos_permissions_impl();
            serde_json::to_value(perms).map_err(|e| format!("serialize failed: {e}"))
        }

        "request_screen_recording" => {
            let granted = cu::request_screen_recording_impl();
            Ok(json!(granted))
        }

        "mouse_click" => {
            let x = require_i32(params, "x")?;
            let y = require_i32(params, "y")?;
            let button = opt_str(params, "button");
            let msg = cu::mouse_click_impl(x, y, button)?;
            Ok(json!(msg))
        }

        "mouse_scroll" => {
            let x = require_i32(params, "x")?;
            let y = require_i32(params, "y")?;
            let direction = require_str(params, "direction")?;
            let amount = opt_i32(params, "amount");
            let msg = cu::mouse_scroll_impl(x, y, direction, amount)?;
            Ok(json!(msg))
        }

        "mouse_drag" => {
            let start_x = require_i32(params, "start_x")?;
            let start_y = require_i32(params, "start_y")?;
            let end_x = require_i32(params, "end_x")?;
            let end_y = require_i32(params, "end_y")?;
            let msg = cu::mouse_drag_impl(start_x, start_y, end_x, end_y)?;
            Ok(json!(msg))
        }

        "keyboard_type" => {
            let text = require_str(params, "text")?;
            let msg = cu::keyboard_type_impl(text)?;
            Ok(json!(msg))
        }

        "keyboard_press" => {
            let key = require_str(params, "key")?;
            let modifiers = opt_str_vec(params, "modifiers");
            let msg = cu::keyboard_press_impl(key, modifiers)?;
            Ok(json!(msg))
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
