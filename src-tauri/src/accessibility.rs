//! Accessibility (AXUIElement) perception + execution layer.
//!
//! Phase 3 / Step 1+2 of the Computer Use overhaul.
//!
//! Step 1 (shipped): `get_ui_snapshot` — read-only AX tree snapshot.
//! Step 2 (this file): `ax_snapshot` — snapshot + session cache of live element refs
//!                     `ax_press`    — AXPress on a cached element (no cursor movement)
//!                     `ax_set_value`— AXSetValue on a cached element (no key synthesis)
//!                     `ax_close_session` — release retained element refs
//!
//! All execution actions drive controls directly via AXUIElement APIs — they do NOT
//! move the system cursor and do NOT steal keyboard focus, making the experience
//! "丝滑" (smooth/non-interrupting). Pixel+enigo is the fallback for canvas-only apps.

// Structs (AxQualityReport, UiElement, UiSnapshot, AxSnapshotResult, AxDiagReport,
// AxDiagSnapshot, AxTextNode) are shared verbatim with the native-helper crate via
// `include!` — see accessibility_types.rs for the canonical definitions.
include!("accessibility_types.rs");

/// Capture a read-only snapshot of the currently focused application's UI tree.
///
/// macOS only. Requires Accessibility permission (the same TCC grant used by the
/// existing Computer Use mouse/keyboard path).
#[tauri::command]
pub fn get_ui_snapshot(app_name: Option<String>) -> Result<UiSnapshot, String> {
    #[cfg(target_os = "macos")]
    {
        macos::get_ui_snapshot_impl(app_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("get_ui_snapshot is only supported on macOS".to_string())
    }
}

/// Open `app_name` (e.g. "Notes", "Finder", "Safari"), wait for it to become
/// focused, then capture an AX snapshot and return a quality report.
///
/// Intended for developer verification — call once from devtools console:
///   `window.__TAURI__.core.invoke('test_ax_snapshot', { appName: 'Notes' })`
///
/// macOS only.
#[tauri::command]
pub async fn test_ax_snapshot(app_name: String) -> Result<AxQualityReport, String> {
    #[cfg(target_os = "macos")]
    {
        macos::test_ax_snapshot_impl(app_name).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("test_ax_snapshot is only supported on macOS".to_string())
    }
}

/// Diagnostic: probe an app's AX tree before/after activation. Developer-only.
///   `window.__TAURI__.core.invoke('ax_diagnose', { appName: 'Notes' })`
#[tauri::command]
pub async fn ax_diagnose(app_name: String) -> Result<AxDiagReport, String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_diagnose_impl(app_name).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("ax_diagnose is only supported on macOS".to_string())
    }
}

/// Diagnostic: dump every text-bearing node (no role filter) for `app_name`, or the
/// frontmost app when omitted. Reveals whether semantic text exists in the tree but
/// is filtered out by the normal interactable-only walk. Developer-only.
///   `window.__TAURI__.core.invoke('ax_probe_text', { appName: 'D-Chat' })`
#[tauri::command]
pub fn ax_probe_text(app_name: Option<String>) -> Result<Vec<AxTextNode>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_probe_text_impl(app_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("ax_probe_text is only supported on macOS".to_string())
    }
}

/// Diagnostic: force-enable Chromium/Electron accessibility (set AXManualAccessibility +
/// AXEnhancedUserInterface on the app), wait, then dump text nodes. Electron apps build
/// no AX tree until an assistive tech requests it — this is the standard way to turn it on.
/// Developer-only.
///   `window.__TAURI__.core.invoke('ax_enable_electron_a11y', { appName: 'D-Chat' })`
#[tauri::command]
pub async fn ax_enable_electron_a11y(app_name: String) -> Result<Vec<AxTextNode>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_enable_electron_a11y_impl(app_name).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("ax_enable_electron_a11y is only supported on macOS".to_string())
    }
}

/// Bring an application to the foreground (activate it) by name.
///
/// macOS: `NSRunningApplication.activateWithOptions` (native AppKit) — does NOT require
/// the Automation/Apple-Events TCC grant that AppleScript `tell ... to activate` needs
/// (the source of the recurring -600 / -1743 errors). Cross-app window raising that
/// AXRaise cannot do is handled here.
/// Windows: PowerShell `AppActivate`.
///
/// Returns the activated app's display name on success.
#[tauri::command]
pub fn activate_app(app_name: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::activate_app_impl(app_name)
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let script = format!(
            r#"$proc = Get-Process -Name '{}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($proc) {{ [void][System.Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) }} else {{ Write-Error 'Process not found' }}"#,
            app_name.replace('\'', "")
        );
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Failed to run PowerShell: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed to activate '{}': {}", app_name, stderr.trim()));
        }
        Ok(format!("Activated '{}'", app_name))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app_name;
        Err("activate_app is not supported on this platform".to_string())
    }
}

/// Snapshot the focused app's AX tree AND cache live element references for actions.
///
/// Returns an `AxSnapshotResult` whose `session_id` can be passed to `ax_press`,
/// `ax_set_value`, and `ax_close_session`. The session holds CFRetain'd element
/// refs — call `ax_close_session` when the agent turn is complete to free memory.
#[tauri::command]
pub fn ax_snapshot(app_name: Option<String>) -> Result<AxSnapshotResult, String> {
    #[cfg(target_os = "macos")]
    {
        // The legacy Tauri compatibility command has no Electron Host Gate
        // identity to bind. New Computer Use development passes both values
        // from the Electron helper entrypoint.
        macos::ax_snapshot_impl(app_name, None, None)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("ax_snapshot is only supported on macOS".to_string())
    }
}

/// Press (click) a UI element by its session + element id.
///
/// Calls `AXUIElementPerformAction(kAXPressAction)` — does NOT move the system
/// cursor, does NOT steal keyboard focus. Works on buttons, menu items, links,
/// checkboxes, radio buttons, disclosure triangles, etc.
#[tauri::command]
pub fn ax_press(session_id: String, element_id: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_press_impl(session_id, element_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, element_id);
        Err("ax_press is only supported on macOS".to_string())
    }
}

/// Set a text value on a UI element by its session + element id.
///
/// Calls `AXUIElementSetAttributeValue(kAXValueAttribute, CFString)` — does NOT
/// synthesise keystrokes, does NOT steal keyboard focus. Works on text fields,
/// text areas, combo boxes, search fields, etc.
///
/// Prefer this over enigo-based typing whenever possible.
#[tauri::command]
pub fn ax_set_value(session_id: String, element_id: u32, text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_set_value_impl(session_id, element_id, text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, element_id, text);
        Err("ax_set_value is only supported on macOS".to_string())
    }
}

/// Perform a named AX action on a cached element (e.g. "AXShowMenu", "AXPick",
/// "AXIncrement", "AXDecrement"). Unlike `ax_press` (which hard-codes "AXPress"),
/// this lets the model invoke any action the element advertises.
///
/// Useful for: right-click-equivalent menus (AXShowMenu), combo-box selection
/// (AXPick), stepper controls (AXIncrement/AXDecrement), disclosure triangles, etc.
#[tauri::command]
pub fn ax_perform_action(
    session_id: String,
    element_id: u32,
    action_name: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_perform_action_impl(session_id, element_id, action_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, element_id, action_name);
        Err("ax_perform_action is only supported on macOS".to_string())
    }
}

/// Release all CFRetain'd element references held by this session.
///
/// Must be called when the agent turn is done (or on error bailout) to avoid
/// leaking AX element references. Silently succeeds if the session is not found.
#[tauri::command]
pub fn ax_close_session(session_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_close_session_impl(session_id);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = session_id;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[path = "accessibility_macos.rs"]
mod macos;
