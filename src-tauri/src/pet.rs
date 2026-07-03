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

use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

const PET_LABEL: &str = "pet";
const PET_SIZE: f64 = 80.0;

/// Applies the macOS-only NSWindow tweaks (clear background, no shadow,
/// floating level, cross-Spaces behavior) once at window creation. These
/// properties are sticky — AppKit does not reset `hasShadow` on resize, so
/// no re-application is needed afterwards. (The dark smudge users saw around
/// the expanded bubble/menu was the webview's own CSS `box-shadow`, not the
/// native window shadow — see PetInputBubble/PetContextMenu.)
///
/// Must run on the main thread; Tauri executes sync commands on the main
/// thread, so calling this from `pet_show` is safe.
#[cfg(target_os = "macos")]
fn apply_macos_style(window: &tauri::WebviewWindow) {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSColor, NSWindow};

    if let Ok(ns_window_ptr) = window.ns_window() {
        if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
            ns_window.setOpaque(false);
            ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
            ns_window.setHasShadow(false);
            ns_window.setLevel(objc2_app_kit::NSFloatingWindowLevel);
            ns_window.setCollectionBehavior(
                objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces
                | objc2_app_kit::NSWindowCollectionBehavior::Stationary,
            );
        }
    }
}

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
    // The pet is usually NOT the key window when a notification pops up (the
    // user is working in the main window). Without this, macOS swallows the
    // first click just to activate the pet window, so clicking the bubble does
    // nothing until the second click. Accept-first-mouse delivers that first
    // click straight to the webview.
    .accept_first_mouse(true)
    .build()
    .map_err(|e| format!("Failed to create pet window: {}", e))?;

    #[cfg(target_os = "macos")]
    apply_macos_style(&pet);

    Ok(())
}

/// Set the pet window's frame in one native operation.
///
/// `anchor_bottom` / `anchor_right` each independently pick which edge of the
/// window stays fixed on screen while the size changes, so the avatar (glued
/// to that same edge in CSS — see `PetApp.tsx`) never visibly moves:
/// - `anchor_bottom = false` (default): top edge fixed, grows downward.
///   `anchor_bottom = true`: bottom edge fixed, grows upward (pet in the
///   lower half of the screen — the default spawn position).
/// - `anchor_right = false` (default): left edge fixed, grows rightward.
///   `anchor_right = true`: right edge fixed, grows leftward (pet in the
///   right half of the screen — also the default spawn position, so this
///   triggers out of the box: without it, a 200px-wide bubble/menu opened
///   from the default bottom-right spawn point grows past the screen's
///   right edge and gets clipped, since nothing ever anchored horizontally).
///
/// When both anchors are at their default (top-left fixed), this is a plain
/// cross-platform `set_size()` — nothing needs to move. Otherwise, on macOS,
/// it's a single `NSWindow setFrame:display:` call so the move+resize can't
/// be observed as two separate frames (a two-step `setPosition` then
/// `setSize` let the avatar visibly jump before settling — the original
/// "click flicker").
#[tauri::command]
pub fn pet_set_frame(
    app: AppHandle,
    width: f64,
    height: f64,
    anchor_bottom: bool,
    anchor_right: bool,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PET_LABEL) else {
        return Ok(());
    };

    if !anchor_bottom && !anchor_right {
        return window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string());
    }

    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_app_kit::NSWindow;

        // Sync Tauri commands run on the main thread — safe for AppKit.
        let ns_window_ptr = window.ns_window().map_err(|e| e.to_string())?;
        if let Some(ns_window) = unsafe { Retained::retain(ns_window_ptr as *mut NSWindow) } {
            let mut frame = ns_window.frame();
            // Cocoa origin is the bottom-left corner, Y increasing upward.
            if anchor_right {
                // Keep the right edge (origin.x + old width) fixed: shift
                // the origin left by however much wider the window got.
                frame.origin.x -= width - frame.size.width;
            }
            if !anchor_bottom {
                // Default is "bottom fixed" in this coordinate system
                // (untouched origin.y = grows upward, taller). To fix the
                // TOP edge instead (origin.y + old height) and grow
                // downward, shift the origin down by the height delta.
                frame.origin.y -= height - frame.size.height;
            }
            frame.size.width = width;
            frame.size.height = height;
            ns_window.setFrame_display(frame, true);
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Fallback: compute the new top-left so the anchored edge(s) stay
        // fixed, then resize. Two steps, but still far tighter than two JS
        // IPC roundtrips.
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let new_w_phys = (width * scale).round() as i32;
        let new_h_phys = (height * scale).round() as i32;
        let new_x = if anchor_right {
            pos.x + size.width as i32 - new_w_phys
        } else {
            pos.x
        };
        let new_y = if anchor_bottom {
            pos.y + size.height as i32 - new_h_phys
        } else {
            pos.y
        };
        window
            .set_position(tauri::PhysicalPosition::new(new_x, new_y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
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
