//! Desktop pet window — transparent circular floater (PRD-02 v1).
//!
//! Mirrors overlay.rs pattern: WebviewWindowBuilder with transparency +
//! always-on-top + no decorations + skip_taskbar. On macOS uses NSWindow
//! collectionBehavior=CanJoinAllSpaces so the pet follows the user across
//! Spaces, and level=floating (below NSStatusWindowLevel) so system
//! notifications still win.
//!
//! MVP (Phase A): show / hide / toggle. Later phases add: resize (mini
//! input), drag persistence, status light.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PET_LABEL: &str = "pet";
const PET_SIZE: f64 = 80.0;

/// Show the pet window. Creates it if missing, positions at bottom-right
/// of the primary monitor on first run.
#[tauri::command]
pub fn pet_show(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Failed to get monitor: {}", e))?
        .ok_or_else(|| "No primary monitor found".to_string())?;

    let size = monitor.size();
    let scale = monitor.scale_factor();
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;

    // Default position: bottom-right, 100px margin
    let pet_x = logical_w - PET_SIZE - 100.0;
    let pet_y = logical_h - PET_SIZE - 100.0;

    let pet = WebviewWindowBuilder::new(
        &app,
        PET_LABEL,
        WebviewUrl::App("pet.html".into()),
    )
    .title("")
    .inner_size(PET_SIZE, PET_SIZE)
    .position(pet_x, pet_y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .build()
    .map_err(|e| format!("Failed to create pet window: {}", e))?;

    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::{NSColor, NSWindow};

        if let Ok(ns_window_ptr) = pet.ns_window() {
            if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
                // Explicitly clear the window backing so the transparent CSS
                // actually shows through. Small windows make any residual
                // background color visible as a rectangle; overlay.rs doesn't
                // need this because it's fullscreen.
                ns_window.setOpaque(false);
                ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
                ns_window.setHasShadow(false);
                // Floating level: above normal windows but below system UI
                // (NSStatusWindowLevel = 25, so notifications still win).
                ns_window.setLevel(objc2_app_kit::NSFloatingWindowLevel);
                // Follow user across Spaces so pet always reachable.
                ns_window.setCollectionBehavior(
                    objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                    | objc2_app_kit::NSWindowCollectionBehavior::Stationary,
                );
            }
        }
    }

    Ok(())
}

/// Hide the pet window without destroying it (keeps WebView alive for
/// quick toggle). Destroy happens on app quit via the normal lifecycle.
#[tauri::command]
pub fn pet_hide(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        let _ = window.hide();
    }
    Ok(())
}

/// Toggle pet visibility. Convenience for dev/testing — later Settings UI
/// will drive show/hide based on `pet.mode` instead.
#[tauri::command]
pub fn pet_toggle(app: AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window(PET_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return Ok(false);
        }
        let _ = window.show();
        return Ok(true);
    }
    pet_show(app)?;
    Ok(true)
}

#[tauri::command]
pub async fn pet_focus_main(app: AppHandle) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        main_win.unminimize().map_err(|e| e.to_string())?;
        main_win.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
