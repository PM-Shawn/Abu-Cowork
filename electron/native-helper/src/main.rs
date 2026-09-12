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
//!   - check_macos_permissions → read-only TCC status checks reused from the
//!     shared Computer Use implementation. GUI permission prompts remain in
//!     Electron main so macOS attributes them to the Abu application.
//!
//! Also hosts the AX session-cache commands (ax_snapshot/press/set_value/
//! close_session) by extracting src-tauri's Tauri-free `*_impl` code (see
//! src/ax.rs, macOS-only).

use std::io::{BufRead, Write};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(target_os = "windows"))]
use enigo::{Coordinate, Enigo, Mouse, Settings};
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
mod ax;
#[cfg(target_os = "windows")]
#[path = "windows/mod.rs"]
mod windows_backend;
// Computer Use (mouse/keyboard/screen-capture/TCC) — cross-platform (only the
// exclusion-capture + permission-check internals are macOS-gated, same as
// src-tauri). See src/cu.rs.
mod cu;
mod error;
use error::HelperError;

const HELPER_PROTOCOL_VERSION: u32 = 2;
static STARTED_AT_MS: OnceLock<u128> = OnceLock::new();
static OUTPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static ACTIVE_REQUEST_CONTEXT: OnceLock<RwLock<Option<Value>>> = OnceLock::new();

fn emit_json(value: &Value) {
    let lock = OUTPUT_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else { return };
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

pub(crate) fn emit_helper_event(event: &str, reason: &str) {
    let context = ACTIVE_REQUEST_CONTEXT
        .get_or_init(|| RwLock::new(None))
        .read()
        .ok()
        .and_then(|value| value.clone());
    emit_json(&json!({ "event": event, "reason": reason, "context": context }));
}

fn started_at_ms() -> u128 {
    *STARTED_AT_MS.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    })
}

fn supported_commands() -> Vec<&'static str> {
    let mut commands = vec![
        "hello",
        "version",
        "health",
        "ping",
        "mouse_click",
        "mouse_move",
        "mouse_scroll",
        "mouse_drag",
        "keyboard_type",
        "keyboard_press",
        "capture_screen",
        "capture_screen_excluding",
        "check_macos_permissions",
    ];
    #[cfg(target_os = "macos")]
    commands.extend([
        "resolve_app_identity",
        "frontmost_app_identity",
        "activate_app",
        "ax_snapshot",
        "ax_press",
        "ax_set_value",
        "ax_perform_action",
        "ax_close_session",
    ]);
    #[cfg(target_os = "windows")]
    commands.extend([
        "input_lease_begin",
        "input_lease_activate",
        "input_lease_commit_observation",
        "input_lease_observe",
        "input_lease_pause",
        "input_lease_resume",
        "input_lease_end",
        "resolve_app_identity",
        "frontmost_app_identity",
        "activate_app",
        "list_apps",
        "launch_app",
        "list_windows",
        "get_window",
        "get_window_graph",
        "frontmost_matches_target",
        "activate_window",
        "ax_snapshot",
        "ax_press",
        "ax_set_value",
        "ax_replace_text",
        "ax_perform_action",
        "ax_restore_focus",
        "ax_close_session",
    ]);
    commands
}

/// L3 driver capability declaration (contract §2.8). Only facts backed by
/// tests or real-desktop evidence are claimed; anything unmeasured is declared
/// as "not promised" so the upper tiers never plan around it.
fn driver_capabilities() -> Value {
    #[cfg(target_os = "windows")]
    {
        json!({
            "id": "windows-uia",
            "input": {
                "foreground_required": true,
                "background_element_actions": false,
                "unicode_text": true,
                "chords": true,
                "ime_aware": false,
                "physical_input_monitoring": windows_backend::input_monitoring_ready(),
            },
            "capture": {
                "display": "wgc-monitor",
                "occluded_window": false,
                "excludes_own_window": true,
            },
            "elements": {
                "identity": "runtime-id",
                "empty_value": "string",
                "actions": [
                    "Invoke", "SetValue", "Focus", "Toggle", "Select", "Expand", "Collapse",
                    "ScrollIntoView", "Scroll",
                ],
            },
            "boundaries": ["secure-desktop", "higher-integrity"],
            "activation": { "can_activate_window": true },
        })
    }
    #[cfg(target_os = "macos")]
    {
        // TODO(mac): values inferred from the current AX/enigo implementation;
        // the Mac session confirms each against a real machine (contract §2.8).
        json!({
            "id": "macos-ax",
            "input": {
                "foreground_required": true,
                "background_element_actions": true,
                "unicode_text": true,
                "chords": true,
                "ime_aware": false,
                "physical_input_monitoring": false,
            },
            "capture": {
                "display": "xcap",
                "occluded_window": false,
                "excludes_own_window": true,
            },
            "elements": {
                "identity": "session-index",
                "empty_value": "unknown",
                "actions": ["AXPress", "AXSetValue", "AXShowMenu", "AXPick", "AXIncrement", "AXDecrement"],
            },
            "boundaries": [],
            "activation": { "can_activate_window": true },
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        json!({
            "id": "unavailable",
            "input": {
                "foreground_required": true,
                "background_element_actions": false,
                "unicode_text": false,
                "chords": false,
                "ime_aware": false,
                "physical_input_monitoring": false,
            },
            "capture": { "display": "unknown", "occluded_window": false, "excludes_own_window": false },
            "elements": { "identity": "none", "empty_value": "unknown", "actions": [] },
            "boundaries": [],
            "activation": { "can_activate_window": false },
        })
    }
}

fn helper_identity() -> Value {
    #[cfg(target_os = "windows")]
    let input_monitoring = windows_backend::input_monitoring_ready();
    #[cfg(not(target_os = "windows"))]
    let input_monitoring = false;
    json!({
        "protocol_version": HELPER_PROTOCOL_VERSION,
        "binary_version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "supported_commands": supported_commands(),
        "started_at_ms": started_at_ms(),
        "capabilities": {
            "transport": "ndjson-stdio",
            "request_serialization": "host",
            "legacy_v1_request_adapter": true,
            "events": if cfg!(target_os = "windows") && input_monitoring {
                vec!["user-interrupted", "user-input-detected", "window-invalidated"]
            } else {
                Vec::<&str>::new()
            },
            "screen_capture": if cfg!(target_os = "windows") { "wgc-monitor" } else { "xcap" },
            "input": if cfg!(target_os = "windows") { "sendinput-guarded" } else { "enigo" },
            "physical_input_monitoring": input_monitoring,
            "accessibility": if cfg!(target_os = "macos") {
                "axui-element"
            } else if cfg!(target_os = "windows") {
                "windows-uia"
            } else {
                "unavailable"
            },
            "driver": driver_capabilities(),
        },
    })
}

struct WireRequest {
    id: Value,
    method: String,
    params: Value,
    context: Option<Value>,
}

fn normalize_request_context(req: &Value) -> Option<Value> {
    let context = req.get("context")?.as_object()?;
    let conversation_id = context
        .get("conversation_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(256).collect::<String>());
    let loop_id = context
        .get("loop_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(256).collect::<String>());
    let target = context
        .get("target")
        .and_then(Value::as_object)
        .map(|target| {
            json!({
                "app_id": target
                    .get("app_id")
                    .and_then(Value::as_str)
                    .map(|value| value.chars().take(1024).collect::<String>()),
                "process_id": target.get("process_id").and_then(Value::as_u64),
                "window_id": target
                    .get("window_id")
                    .and_then(Value::as_str)
                    .map(|value| value.chars().take(128).collect::<String>()),
            })
        });
    if conversation_id.is_none() && loop_id.is_none() && target.is_none() {
        return None;
    }
    Some(json!({
        "conversation_id": conversation_id,
        "loop_id": loop_id,
        "target": target,
    }))
}

fn parse_wire_request(req: &Value) -> Result<WireRequest, HelperError> {
    let method = req
        .get("method")
        .or_else(|| req.get("command"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| HelperError::not_executed("invalid-params", "missing request method/command"))?;
    let params = req
        .get("params")
        .or_else(|| req.get("args"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(WireRequest {
        id: req.get("id").cloned().unwrap_or(Value::Null),
        method: method.to_string(),
        params,
        context: normalize_request_context(req),
    })
}

/// Read a required string param, e.g. `session_id`.
fn require_str(params: &Value, key: &str) -> Result<String, HelperError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| HelperError::not_executed("invalid-params", format!("missing required param '{key}'")))
}

/// Read a required u32 param, e.g. `element_id`.
fn require_u32(params: &Value, key: &str) -> Result<u32, HelperError> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .ok_or_else(|| HelperError::not_executed("invalid-params", format!("missing required param '{key}'")))
}

/// Read a required u64 param used for monotonic observation/input epochs.
fn require_u64(params: &Value, key: &str) -> Result<u64, HelperError> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| HelperError::not_executed("invalid-params", format!("missing required param '{key}'")))
}

/// Read a required i32 param, e.g. mouse/drag coordinates.
fn require_i32(params: &Value, key: &str) -> Result<i32, HelperError> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| HelperError::not_executed("invalid-params", format!("missing required param '{key}'")))
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

/// Re-check the real foreground application immediately before global input.
/// Main-process checks remain useful for policy/UI, but only this helper can
/// close the final IPC scheduling window before Enigo injects an event.
fn assert_expected_target(params: &Value) -> Result<(), String> {
    let expected_bundle = require_str(params, "expected_bundle_id")?;
    let expected_pid = params
        .get("expected_process_id")
        .and_then(Value::as_i64)
        .map(|value| value as i32);

    #[cfg(target_os = "macos")]
    {
        let actual = ax::frontmost_app_identity_impl()?;
        if !actual.bundle_id.eq_ignore_ascii_case(&expected_bundle)
            || expected_pid.is_some_and(|pid| pid != actual.process_id)
        {
            return Err(format!(
                "Computer Use target changed before native input: expected {} ({:?}), got {} ({})",
                expected_bundle, expected_pid, actual.bundle_id, actual.process_id
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let actual = windows_backend::frontmost_app_identity_impl()?;
        if !actual.bundle_id.eq_ignore_ascii_case(&expected_bundle)
            || expected_pid.is_some_and(|pid| pid != actual.process_id)
        {
            return Err(format!(
                "Computer Use target changed before native input: expected {} ({:?}), got {} ({})",
                expected_bundle, expected_pid, actual.bundle_id, actual.process_id
            ));
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (expected_bundle, expected_pid);
        Err("Computer Use native target validation is unsupported on this platform".to_string())
    }
}

fn handle(method: &str, params: &Value) -> Result<Value, HelperError> {
    match method {
        "ping" => Ok(json!({ "pong": true })),
        "hello" | "version" => Ok(helper_identity()),
        "health" => {
            let mut identity = helper_identity();
            if let Some(object) = identity.as_object_mut() {
                object.insert("pong".to_string(), Value::Bool(true));
                object.insert("healthy".to_string(), Value::Bool(true));
            }
            Ok(identity)
        }

        #[cfg(target_os = "windows")]
        "input_lease_begin" => {
            let epoch = windows_backend::begin_input_lease(&require_str(params, "lease_id")?)?;
            Ok(json!({ "input_epoch": epoch, "phase": "observing" }))
        }
        #[cfg(target_os = "windows")]
        "input_lease_activate" => {
            let epoch = windows_backend::activate_input_lease(
                &require_str(params, "lease_id")?,
                require_u64(params, "expected_input_epoch")?,
            )?;
            Ok(json!({ "input_epoch": epoch, "phase": "running" }))
        }
        #[cfg(target_os = "windows")]
        "input_lease_commit_observation" => {
            let epoch = windows_backend::commit_input_observation(
                &require_str(params, "lease_id")?,
                require_u64(params, "expected_input_epoch")?,
            )?;
            Ok(json!({ "input_epoch": epoch, "phase": "observing" }))
        }
        #[cfg(target_os = "windows")]
        "input_lease_observe" => {
            let epoch = windows_backend::observe_input_lease(&require_str(params, "lease_id")?)?;
            Ok(json!({ "input_epoch": epoch, "phase": "observing" }))
        }
        #[cfg(target_os = "windows")]
        "input_lease_pause" => {
            let owner = u32::try_from(require_u64(params, "consent_owner_process_id")?)
                .map_err(|_| HelperError::not_executed("invalid-params", "consent owner process id is invalid"))?;
            let epoch =
                windows_backend::pause_input_lease(&require_str(params, "lease_id")?, owner)?;
            Ok(json!({ "input_epoch": epoch, "phase": "paused-for-consent" }))
        }
        #[cfg(target_os = "windows")]
        "input_lease_resume" => {
            let (dirty, epoch) =
                windows_backend::resume_input_lease(&require_str(params, "lease_id")?)?;
            Ok(json!({
                "dirty": dirty,
                "input_epoch": epoch,
                "phase": if dirty { "observing" } else { "running" },
            }))
        }
        #[cfg(target_os = "windows")]
        "input_lease_end" => {
            windows_backend::end_input_lease(&require_str(params, "lease_id")?)?;
            Ok(json!({ "ended": true, "phase": "idle" }))
        }

        // ── Accessibility (AXUIElement) family — reuses src-tauri's
        // Tauri-free `*_impl` code via `ax` module (see src/ax.rs). ──
        "resolve_app_identity" => {
            #[cfg(target_os = "macos")]
            {
                let name = require_str(params, "app_name")?;
                let identity = ax::resolve_app_identity_impl(name)?;
                serde_json::to_value(identity).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "macos"))]
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "App identity resolution is macOS-only"))
            }
            #[cfg(target_os = "windows")]
            {
                let name = require_str(params, "app_name")?;
                let identity = windows_backend::resolve_app_identity_impl(name)?;
                serde_json::to_value(identity).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
        }

        "frontmost_app_identity" => {
            #[cfg(target_os = "macos")]
            {
                let identity = ax::frontmost_app_identity_impl()?;
                serde_json::to_value(identity).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "macos"))]
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Frontmost app identity resolution is macOS-only"))
            }
            #[cfg(target_os = "windows")]
            {
                let identity = windows_backend::frontmost_app_identity_impl()?;
                serde_json::to_value(identity).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
        }

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
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "AX is macOS-only"))
            }
            #[cfg(target_os = "windows")]
            {
                let name = require_str(params, "app_name")?;
                let display = windows_backend::activate_app_impl(name)?;
                Ok(Value::String(display))
            }
        }

        "list_windows" => {
            #[cfg(target_os = "windows")]
            {
                let expected_app_id = opt_str(params, "expected_app_id");
                let windows = windows_backend::list_windows_impl(expected_app_id)?;
                serde_json::to_value(windows).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Window enumeration is Windows-only"))
            }
        }

        "list_apps" => {
            #[cfg(target_os = "windows")]
            {
                let apps = windows_backend::list_apps_impl()?;
                serde_json::to_value(apps).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Application catalog is Windows-only"))
            }
        }

        "launch_app" => {
            #[cfg(target_os = "windows")]
            {
                let query = require_str(params, "app_name")?;
                let app = windows_backend::launch_app_impl(query)?;
                serde_json::to_value(app).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Application launch is Windows-only"))
            }
        }

        "get_window" => {
            #[cfg(target_os = "windows")]
            {
                let window_id = require_str(params, "window_id")?;
                let window = windows_backend::get_window_impl(window_id)?;
                serde_json::to_value(window).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Window lookup is Windows-only"))
            }
        }

        "get_window_graph" => {
            #[cfg(target_os = "windows")]
            {
                let graph = windows_backend::get_window_graph_impl(
                    require_str(params, "expected_app_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                )?;
                serde_json::to_value(graph).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Window graph lookup is Windows-only"))
            }
        }

        "frontmost_matches_target" => {
            #[cfg(target_os = "windows")]
            {
                let result = windows_backend::frontmost_matches_target_impl(
                    require_str(params, "expected_app_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                )?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Window target matching is Windows-only"))
            }
        }

        "activate_window" => {
            #[cfg(target_os = "windows")]
            {
                let window_id = require_str(params, "window_id")?;
                let window = windows_backend::activate_window_impl(window_id)?;
                serde_json::to_value(window).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Window activation is Windows-only"))
            }
        }

        "ax_snapshot" => {
            #[cfg(target_os = "macos")]
            {
                // Frontend sends { appName } (computerTools.ts:551) → app_name.
                let app = params
                    .get("app_name")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let expected_bundle_id = require_str(params, "expected_bundle_id")?;
                let expected_process_id = opt_i32(params, "expected_process_id");
                let result =
                    ax::ax_snapshot_impl(app, Some(expected_bundle_id), expected_process_id)?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(target_os = "windows")]
            {
                let expected_app_id = require_str(params, "expected_bundle_id")?;
                let app_name = params
                    .get("app_name")
                    .and_then(Value::as_str)
                    .unwrap_or(&expected_app_id)
                    .to_string();
                let expected_process_id = opt_i32(params, "expected_process_id")
                    .and_then(|value| u32::try_from(value).ok());
                let result = windows_backend::ax_snapshot_impl(
                    app_name,
                    Some(expected_app_id),
                    expected_process_id,
                    opt_str(params, "expected_window_id"),
                )?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Accessibility snapshots are unsupported on this platform"))
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
            #[cfg(target_os = "windows")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                windows_backend::ax_press_impl(session_id, element_id)?;
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Accessibility actions are unsupported on this platform"))
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
            #[cfg(target_os = "windows")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                let text = require_str(params, "text")?;
                windows_backend::ax_set_value_impl(session_id, element_id, text)?;
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Accessibility actions are unsupported on this platform"))
            }
        }

        "ax_replace_text" => {
            #[cfg(target_os = "windows")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                let text = require_str(params, "text")?;
                let expected_app_id = require_str(params, "expected_bundle_id")?;
                let expected_process_id =
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?;
                let expected_window_id = require_str(params, "expected_window_id")?;
                let expected_input_epoch = require_u64(params, "expected_input_epoch")?;

                // UIA chooses and verifies the exact cached element; guarded
                // SendInput then performs the user-visible edit against the
                // same app/PID/HWND/input epoch. This avoids trusting a
                // provider-side ValuePattern cache as proof of a real edit.
                windows_backend::ax_perform_action_impl(
                    session_id,
                    element_id,
                    "focus".to_string(),
                )?;
                windows_backend::keyboard_press_impl(
                    "a".to_string(),
                    vec!["ctrl".to_string()],
                    expected_app_id.clone(),
                    expected_process_id,
                    expected_window_id.clone(),
                    expected_input_epoch,
                )?;
                let result = if text.is_empty() {
                    windows_backend::keyboard_press_impl(
                        "backspace".to_string(),
                        Vec::new(),
                        expected_app_id,
                        expected_process_id,
                        expected_window_id,
                        expected_input_epoch,
                    )?
                } else {
                    windows_backend::keyboard_type_impl(
                        text,
                        expected_app_id,
                        expected_process_id,
                        expected_window_id,
                        expected_input_epoch,
                    )?
                };
                Ok(json!(result))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "guarded accessibility text replacement is Windows-only"))
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
            #[cfg(target_os = "windows")]
            {
                let session_id = require_str(params, "session_id")?;
                let element_id = require_u32(params, "element_id")?;
                let action_name = require_str(params, "action_name")?;
                windows_backend::ax_perform_action_impl(session_id, element_id, action_name)?;
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Accessibility actions are unsupported on this platform"))
            }
        }

        "ax_restore_focus" => {
            #[cfg(target_os = "windows")]
            {
                let session_id = require_str(params, "session_id")?;
                let restored = windows_backend::ax_restore_focus_impl(session_id)?;
                Ok(json!({ "restored": restored }))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err(HelperError::not_executed("unsupported-platform", "UIA focus restoration is Windows-only"))
            }
        }

        "ax_close_session" => {
            #[cfg(target_os = "macos")]
            {
                let session_id = require_str(params, "session_id")?;
                ax::ax_close_session_impl(session_id);
                Ok(json!({ "ok": true }))
            }
            #[cfg(target_os = "windows")]
            {
                let session_id = require_str(params, "session_id")?;
                windows_backend::ax_close_session_impl(session_id);
                Ok(json!({ "ok": true }))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err(HelperError::not_executed("unsupported-platform", "Accessibility actions are unsupported on this platform"))
            }
        }

        "mouse_move" => {
            #[cfg(target_os = "windows")]
            {
                let result = windows_backend::mouse_move_impl(
                    require_i32(params, "x")?,
                    require_i32(params, "y")?,
                    require_str(params, "screenshot_id")?,
                    require_str(params, "expected_bundle_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                    require_u64(params, "expected_input_epoch")?,
                )?;
                Ok(json!(result))
            }
            #[cfg(not(target_os = "windows"))]
            {
                assert_expected_target(params)?;
                let mut enigo = Enigo::new(&Settings::default())
                    .map_err(|e| format!("enigo init failed: {e}"))?;
                let (cx, cy) = enigo
                    .location()
                    .map_err(|e| format!("location failed: {e}"))?;
                let tx = params
                    .get("x")
                    .and_then(Value::as_i64)
                    .map_or(cx, |v| v as i32);
                let ty = params
                    .get("y")
                    .and_then(Value::as_i64)
                    .map_or(cy, |v| v as i32);
                enigo
                    .move_mouse(tx, ty, Coordinate::Abs)
                    .map_err(|e| format!("move_mouse failed: {e}"))?;
                Ok(json!({ "moved_to": [tx, ty], "was_at": [cx, cy] }))
            }
        }

        // ── Computer Use — screen capture (base64 PNG, matches computer_use.rs's
        // ScreenshotResult shape exactly: {base64, width, height, scale_factor,
        // origin_x, origin_y} — NOT the old {width, height, path}-to-disk shape
        // this arm used to return before the cu module reuse). ──
        "capture_screen" => {
            if params.get("expected_bundle_id").is_some() {
                assert_expected_target(params)?;
            }
            let x = opt_i32(params, "x");
            let y = opt_i32(params, "y");
            let width = opt_u32(params, "width");
            let height = opt_u32(params, "height");
            let max_width = opt_u32(params, "max_width");
            #[cfg(target_os = "windows")]
            {
                let result = windows_backend::capture_screen_state_impl(
                    x,
                    y,
                    width,
                    height,
                    max_width,
                    None,
                    None,
                    opt_str(params, "expected_bundle_id"),
                    opt_i32(params, "expected_process_id")
                        .and_then(|value| u32::try_from(value).ok()),
                    opt_str(params, "expected_window_id"),
                )?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let result = cu::capture_screen_impl(x, y, width, height, max_width)?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
        }

        "capture_screen_excluding" => {
            if params.get("expected_bundle_id").is_some() {
                assert_expected_target(params)?;
            }
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
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(target_os = "windows")]
            {
                let _ = exclude_window_id;
                let result = windows_backend::capture_screen_state_impl(
                    x,
                    y,
                    width,
                    height,
                    max_width,
                    anchor_x,
                    anchor_y,
                    opt_str(params, "expected_bundle_id"),
                    opt_i32(params, "expected_process_id")
                        .and_then(|value| u32::try_from(value).ok()),
                    opt_str(params, "expected_window_id"),
                )?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                // xcap doesn't support exclusion — fall back to regular capture,
                // same as computer_use.rs's non-macOS branch.
                let _ = (exclude_window_id, anchor_x, anchor_y);
                let result = cu::capture_screen_impl(x, y, width, height, max_width)?;
                serde_json::to_value(result).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
            }
        }

        "check_macos_permissions" => {
            let perms = cu::check_macos_permissions_impl();
            serde_json::to_value(perms).map_err(|e| HelperError::internal(format!("serialize failed: {e}")))
        }

        "mouse_click" => {
            let x = require_i32(params, "x")?;
            let y = require_i32(params, "y")?;
            let button = opt_str(params, "button");
            #[cfg(target_os = "windows")]
            {
                let msg = windows_backend::mouse_click_impl(
                    x,
                    y,
                    button,
                    require_str(params, "screenshot_id")?,
                    require_str(params, "expected_bundle_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                    require_u64(params, "expected_input_epoch")?,
                )?;
                Ok(json!(msg))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let msg =
                    cu::mouse_click_guarded_impl(x, y, button, || assert_expected_target(params))?;
                Ok(json!(msg))
            }
        }

        "mouse_scroll" => {
            let x = require_i32(params, "x")?;
            let y = require_i32(params, "y")?;
            let direction = require_str(params, "direction")?;
            let amount = opt_i32(params, "amount");
            #[cfg(target_os = "windows")]
            {
                let msg = windows_backend::mouse_scroll_impl(
                    x,
                    y,
                    direction,
                    amount,
                    require_str(params, "screenshot_id")?,
                    require_str(params, "expected_bundle_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                    require_u64(params, "expected_input_epoch")?,
                )?;
                Ok(json!(msg))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let msg = cu::mouse_scroll_guarded_impl(x, y, direction, amount, || {
                    assert_expected_target(params)
                })?;
                Ok(json!(msg))
            }
        }

        "mouse_drag" => {
            let start_x = require_i32(params, "start_x")?;
            let start_y = require_i32(params, "start_y")?;
            let end_x = require_i32(params, "end_x")?;
            let end_y = require_i32(params, "end_y")?;
            #[cfg(target_os = "windows")]
            {
                let msg = windows_backend::mouse_drag_impl(
                    start_x,
                    start_y,
                    end_x,
                    end_y,
                    require_str(params, "screenshot_id")?,
                    require_str(params, "expected_bundle_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                    require_u64(params, "expected_input_epoch")?,
                )?;
                Ok(json!(msg))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let msg = cu::mouse_drag_guarded_impl(start_x, start_y, end_x, end_y, || {
                    assert_expected_target(params)
                })?;
                Ok(json!(msg))
            }
        }

        "keyboard_type" => {
            let text = require_str(params, "text")?;
            #[cfg(target_os = "windows")]
            {
                let msg = windows_backend::keyboard_type_impl(
                    text,
                    require_str(params, "expected_bundle_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                    require_u64(params, "expected_input_epoch")?,
                )?;
                Ok(json!(msg))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let msg = cu::keyboard_type_guarded_impl(text, || assert_expected_target(params))?;
                Ok(json!(msg))
            }
        }

        "keyboard_press" => {
            let key = require_str(params, "key")?;
            let modifiers = opt_str_vec(params, "modifiers");
            #[cfg(target_os = "windows")]
            {
                let msg = windows_backend::keyboard_press_impl(
                    key,
                    modifiers.unwrap_or_default(),
                    require_str(params, "expected_bundle_id")?,
                    u32::try_from(require_i32(params, "expected_process_id")?)
                        .map_err(|_| HelperError::not_executed("invalid-params", "expected process id is invalid"))?,
                    require_str(params, "expected_window_id")?,
                    require_u64(params, "expected_input_epoch")?,
                )?;
                Ok(json!(msg))
            }
            #[cfg(not(target_os = "windows"))]
            {
                let msg = cu::keyboard_press_guarded_impl(key, modifiers, || {
                    assert_expected_target(params)
                })?;
                Ok(json!(msg))
            }
        }

        other => Err(HelperError::not_executed("unknown-method", format!("unknown method: {other}"))),
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        let _ = unsafe {
            windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            )
        };
    }
    #[cfg(target_os = "windows")]
    let _ = windows_backend::initialize_input_monitoring();
    let _ = started_at_ms();
    let stdin = std::io::stdin();
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
                emit_json(&json!({
                    "error": HelperError::not_executed("invalid-params", format!("parse error: {e}")),
                }));
                continue;
            }
        };
        let wire = match parse_wire_request(&req) {
            Ok(value) => value,
            Err(error) => {
                emit_json(&json!({
                    "id": req.get("id").cloned().unwrap_or(Value::Null),
                    "error": error,
                }));
                continue;
            }
        };
        if let Some(context) = &wire.context {
            if let Ok(mut active) = ACTIVE_REQUEST_CONTEXT
                .get_or_init(|| RwLock::new(None))
                .write()
            {
                *active = Some(context.clone());
            }
        }
        #[cfg(target_os = "windows")]
        if matches!(
            wire.method.as_str(),
            "ax_snapshot" | "capture_screen" | "capture_screen_excluding"
        ) {
            windows_backend::begin_input_observation();
        }
        let handled = handle(&wire.method, &wire.params);
        let resp = match handled {
            Ok(result) => json!({ "id": wire.id, "result": result }),
            Err(error) => json!({ "id": wire.id, "error": error }),
        };
        emit_json(&resp);
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn accepts_v2_and_legacy_v1_request_shapes() {
        let v2 = parse_wire_request(&json!({
            "id": 1,
            "method": "health",
            "params": { "ignored": true },
            "context": {
                "conversation_id": "conversation-a",
                "loop_id": "loop-a",
                "target": {
                    "app_id": "path:C:\\Windows\\System32\\notepad.exe",
                    "process_id": 42,
                    "window_id": "0x1234",
                    "window_title": "must not cross the protocol boundary"
                },
                "user_text": "must not cross the protocol boundary"
            }
        }))
        .unwrap();
        assert_eq!(v2.method, "health");
        assert_eq!(v2.params["ignored"], true);
        let context = v2.context.unwrap();
        assert_eq!(context["conversation_id"], "conversation-a");
        assert_eq!(context["loop_id"], "loop-a");
        assert_eq!(context["target"]["process_id"], 42);
        assert!(context.get("user_text").is_none());
        assert!(context["target"].get("window_title").is_none());

        let v1 = parse_wire_request(&json!({
            "id": "legacy",
            "command": "ping",
            "args": { "legacy": true },
        }))
        .unwrap();
        assert_eq!(v1.id, "legacy");
        assert_eq!(v1.method, "ping");
        assert_eq!(v1.params["legacy"], true);
        assert!(v1.context.is_none());
        assert!(parse_wire_request(&json!({ "id": 2 })).is_err());
    }
}
