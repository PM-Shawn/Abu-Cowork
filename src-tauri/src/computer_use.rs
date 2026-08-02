//! Computer Use — screenshot capture + keyboard/mouse simulation.
//!
//! Provides Tauri commands for:
//! - `capture_screen`: take a screenshot (full or region), return base64 PNG
//! - `mouse_click`: move mouse and click at coordinates
//! - `mouse_move`: move mouse to coordinates without clicking
//! - `keyboard_type`: type text string
//! - `keyboard_press`: press key combination (e.g. Ctrl+C)
//! - `check_macos_permissions`: check Screen Recording & Accessibility status
//!
//! The actual logic (Tauri-free — no `AppHandle`/`Window`/`State` params) lives in
//! `computer_use_impl.rs`, `include!`d below. That file is shared verbatim with
//! the native-helper crate (electron/native-helper/src/cu.rs) so Electron-shell
//! mode gets byte-identical behavior. Mirrors the accessibility.rs /
//! accessibility_macos.rs split (see ax.rs's doc comment for the native-helper
//! side of that pattern). Every command here is a thin wrapper that just calls
//! into the shared `*_impl` function — keep it that way; put new logic in
//! computer_use_impl.rs, not here.

// Shared Tauri-free structs + impl fns (MacPermissions, ScreenshotResult,
// check_macos_permissions_impl, request_screen_recording_impl, capture_screen_impl,
// mouse_click_impl, mouse_scroll_impl, mouse_drag_impl, keyboard_type_impl,
// keyboard_press_impl, capture_excluding_impl, choose_display_id) — these come
// with their own `use` statements (enigo/base64/image/xcap/objc2-core-graphics),
// which is why this file has no top-level imports of its own beyond this include.
include!("computer_use_impl.rs");

/// Check Screen Recording and Accessibility permissions.
#[tauri::command]
pub fn check_macos_permissions() -> MacPermissions {
    check_macos_permissions_impl()
}

/// Request macOS Screen Recording permission (triggers system prompt on first call).
/// Returns true if already granted.
#[tauri::command]
pub fn request_screen_recording() -> bool {
    request_screen_recording_impl()
}

/// Capture the primary monitor (or a region) and return base64-encoded PNG.
/// If `max_width` is set, the image is downscaled so the width fits within the limit.
/// The `scale_factor` in the result tells callers how to map coordinates back.
#[tauri::command]
pub async fn capture_screen(
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    max_width: Option<u32>,
) -> Result<ScreenshotResult, String> {
    tauri::async_runtime::spawn_blocking(move || capture_screen_impl(x, y, width, height, max_width))
        .await
        .map_err(|e| format!("Task join error: {}", e))?
}

/// Move mouse to (x, y) and click.
/// Runs synchronously on the main thread — Enigo/TSM APIs require main dispatch queue on macOS.
#[tauri::command]
pub fn mouse_click(
    x: i32,
    y: i32,
    button: Option<String>,
) -> Result<String, String> {
    mouse_click_impl(x, y, button)
}

/// Move mouse to (x, y) without clicking.
#[tauri::command]
pub fn mouse_move(x: i32, y: i32) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("Mouse move failed: {}", e))?;

    Ok(format!("Moved mouse to ({}, {})", x, y))
}

/// Type a text string via simulated keyboard input.
/// Runs synchronously on the main thread — Enigo/TSM APIs require main dispatch queue on macOS.
#[tauri::command]
pub fn keyboard_type(text: String) -> Result<String, String> {
    keyboard_type_impl(text)
}

/// Press a key combination (e.g. key="Return", modifiers=["meta"]).
/// Runs synchronously on the main thread — Enigo/TSM APIs require main dispatch queue on macOS.
#[tauri::command]
pub fn keyboard_press(
    key: String,
    modifiers: Option<Vec<String>>,
) -> Result<String, String> {
    keyboard_press_impl(key, modifiers)
}

/// Scroll at (x, y) in a direction. Amount is number of "ticks" (default 3).
#[tauri::command]
pub fn mouse_scroll(
    x: i32,
    y: i32,
    direction: String,
    amount: Option<i32>,
) -> Result<String, String> {
    mouse_scroll_impl(x, y, direction, amount)
}

/// Click and drag from (start_x, start_y) to (end_x, end_y).
/// Uses ease-out-cubic animation for smooth, natural drag movement.
#[tauri::command]
pub fn mouse_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
) -> Result<String, String> {
    mouse_drag_impl(start_x, start_y, end_x, end_y)
}

// ─── Screenshot with window exclusion (macOS) ────────────────────────

/// Get the CGWindowID of the Tauri main window.
/// This is the macOS window number used by CGWindowListCreateImage.
#[tauri::command]
pub fn get_abu_window_id(window: tauri::Window) -> Result<u32, String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        let ns_window_ptr = window.ns_window()
            .map_err(|e| format!("Failed to get NSWindow: {}", e))?;

        // ns_window() returns *mut c_void pointing to the NSWindow
        let ns_window: Retained<NSWindow> = unsafe {
            Retained::retain(ns_window_ptr as *mut NSWindow)
                .ok_or_else(|| "NSWindow pointer is null".to_string())?
        };

        Ok(ns_window.windowNumber() as u32)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("get_abu_window_id is only supported on macOS".to_string())
    }
}

/// Capture a single display excluding a specific window (by CGWindowID).
///
/// Uses CGWindowListCreateImage with OptionOnScreenBelowWindow to capture
/// everything on screen BELOW the specified window — effectively excluding
/// that window and any windows above it from the screenshot.
///
/// `x`/`y`/`width`/`height`: optional crop region, in DISPLAY-RELATIVE LOGICAL POINTS
/// (i.e. screenshot-coord × previous scale_factor). None = full display.
#[tauri::command]
pub async fn capture_screen_excluding(
    exclude_window_id: u32,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    max_width: Option<u32>,
    anchor_x: Option<f64>,
    anchor_y: Option<f64>,
) -> Result<ScreenshotResult, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            capture_excluding_impl(exclude_window_id, x, y, width, height, max_width, anchor_x, anchor_y)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Fallback to regular capture on non-macOS (xcap doesn't support exclusion)
        let _ = (anchor_x, anchor_y);
        capture_screen(x, y, width, height, max_width).await
    }
}

// App focus management lives in `accessibility::activate_app` — it uses the native
// NSRunningApplication API on macOS (no Automation/Apple-Events permission, unlike the
// old AppleScript `tell ... to activate` that failed with -600).
