//! Screen border overlay — visual indicator during Computer Use.
//!
//! Creates a transparent, always-on-top, click-through window that renders
//! a glowing blue border around the screen. Used to indicate that Abu is
//! actively controlling the computer.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_LABEL: &str = "cu-overlay";

/// Show the screen border overlay. Creates the window if it doesn't exist.
#[tauri::command]
pub fn show_screen_border(app: AppHandle) -> Result<(), String> {
    // If overlay already exists, just show it
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.show();
        return Ok(());
    }

    // Get primary monitor size
    let monitor = app
        .primary_monitor()
        .map_err(|e| format!("Failed to get monitor: {}", e))?
        .ok_or_else(|| "No primary monitor found".to_string())?;

    let size = monitor.size();
    let position = monitor.position();
    let scale = monitor.scale_factor();

    // Convert physical pixels to logical pixels (Tauri uses logical coordinates)
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let logical_x = position.x as f64 / scale;
    let logical_y = position.y as f64 / scale;

    let overlay = WebviewWindowBuilder::new(
        &app,
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

    // macOS: make the overlay window ignore all mouse events (click-through)
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        if let Ok(ns_window_ptr) = overlay.ns_window() {
            if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
                ns_window.setIgnoresMouseEvents(true);
                // Set above menu bar so the border covers the full screen edges
                ns_window.setLevel(objc2_app_kit::NSStatusWindowLevel + 1);
                // Allow window to cover the menu bar area
                ns_window.setCollectionBehavior(
                    objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                    | objc2_app_kit::NSWindowCollectionBehavior::Stationary
                );
            }
        }
    }

    Ok(())
}

/// Hide the screen border overlay.
#[tauri::command]
pub fn hide_screen_border(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        // Use hide() for immediate effect, then destroy() to clean up.
        // close() is async and may not take effect before the next frame.
        let _ = window.hide();
        let _ = window.destroy();
    }
    Ok(())
}

/// Get the CGWindowID of the overlay window (for screenshot exclusion).
#[tauri::command]
pub fn get_overlay_window_id(app: AppHandle) -> Result<Option<u32>, String> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
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
