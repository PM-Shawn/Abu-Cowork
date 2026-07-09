//! Screen border overlay + stop button — visual indicators during Computer Use.
//!
//! Creates:
//! 1. A transparent, always-on-top, click-through overlay window (blue border)
//! 2. A small stop button window at the top center of the screen

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "cu-overlay";
const STOP_BTN_LABEL: &str = "cu-stop-btn";

const STOP_BTN_WIDTH: f64 = 160.0;
const STOP_BTN_HEIGHT: f64 = 40.0;

/// Show the screen border overlay + stop button. Creates windows if they don't exist.
///
/// `stop_label` is the already-localized stop-button caption, resolved by the
/// frontend (which owns the UI locale) and injected into the standalone overlay
/// HTML — which lives outside the React i18n tree — as `window.__CU_I18N__`.
#[tauri::command]
pub fn show_screen_border(app: AppHandle, stop_label: String) -> Result<(), String> {
    show_overlay(&app)?;
    show_stop_button(&app, &stop_label)?;
    Ok(())
}

/// Hide both the screen border overlay and stop button.
#[tauri::command]
pub fn hide_screen_border(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.hide();
        let _ = window.destroy();
    }
    if let Some(window) = app.get_webview_window(STOP_BTN_LABEL) {
        let _ = window.hide();
        let _ = window.destroy();
    }
    Ok(())
}

/// Get the CGWindowID of the overlay window (for screenshot exclusion).
#[tauri::command]
pub fn get_overlay_window_id(app: AppHandle) -> Result<Option<u32>, String> {
    // Return the stop button window ID (higher z-order) so OptionOnScreenBelowWindow
    // excludes both the stop button AND the overlay below it.
    let window = app.get_webview_window(STOP_BTN_LABEL)
        .or_else(|| app.get_webview_window(OVERLAY_LABEL));

    let window = match window {
        Some(w) => w,
        None => return Ok(None),
    };

    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        let ns_window_ptr = window.ns_window()
            .map_err(|e| format!("Failed to get NSWindow: {}", e))?;

        if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
            return Ok(Some(ns_window.windowNumber() as u32));
        }
        Ok(None)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(None)
    }
}

// ─── Internal: overlay window ───

fn show_overlay(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Failed to get monitor: {}", e))?
        .ok_or_else(|| "No primary monitor found".to_string())?;

    let size = monitor.size();
    let position = monitor.position();
    let scale = monitor.scale_factor();

    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let logical_x = position.x as f64 / scale;
    let logical_y = position.y as f64 / scale;

    let overlay = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("")
    .inner_size(logical_w, logical_h)
    .position(logical_x, logical_y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .resizable(false)
    .shadow(false)
    .build()
    .map_err(|e| format!("Failed to create overlay window: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        if let Ok(ns_window_ptr) = overlay.ns_window() {
            if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
                ns_window.setIgnoresMouseEvents(true);
                ns_window.setLevel(objc2_app_kit::NSStatusWindowLevel + 1);
                ns_window.setCollectionBehavior(
                    objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                    | objc2_app_kit::NSWindowCollectionBehavior::Stationary
                );
            }
        }
    }

    Ok(())
}

// ─── Internal: stop button window ───

fn show_stop_button(app: &AppHandle, stop_label: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(STOP_BTN_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    // Inject the localized caption before the page loads so the dumb HTML can
    // display it without any i18n logic of its own. serde_json produces a safely
    // escaped JS string literal.
    let stop_label_json = serde_json::to_string(stop_label).unwrap_or_else(|_| "\"\"".to_string());
    let init_script = format!("window.__CU_I18N__ = {{ stopControl: {} }};", stop_label_json);

    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Failed to get monitor: {}", e))?
        .ok_or_else(|| "No primary monitor found".to_string())?;

    let screen_size = monitor.size();
    let scale = monitor.scale_factor();

    let logical_screen_w = screen_size.width as f64 / scale;
    // Center horizontally, at top with small margin
    let btn_x = (logical_screen_w - STOP_BTN_WIDTH) / 2.0;
    let btn_y = 8.0; // Below menu bar

    let stop_btn = WebviewWindowBuilder::new(
        app,
        STOP_BTN_LABEL,
        WebviewUrl::App("stop-button.html".into()),
    )
    .title("")
    .initialization_script(&init_script)
    .inner_size(STOP_BTN_WIDTH, STOP_BTN_HEIGHT)
    .position(btn_x, btn_y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .resizable(false)
    .shadow(false)
    .build()
    .map_err(|e| format!("Failed to create stop button window: {}", e))?;

    // macOS: set higher level than overlay, but DO NOT ignore mouse events (user must click it)
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        if let Ok(ns_window_ptr) = stop_btn.ns_window() {
            if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
                // Higher than overlay so it's always visible and clickable
                ns_window.setLevel(objc2_app_kit::NSStatusWindowLevel + 2);
                ns_window.setCollectionBehavior(
                    objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                    | objc2_app_kit::NSWindowCollectionBehavior::Stationary
                );
            }
        }
    }

    Ok(())
}
