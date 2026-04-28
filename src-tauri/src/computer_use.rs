//! Computer Use — screenshot capture + keyboard/mouse simulation.
//!
//! Provides Tauri commands for:
//! - `capture_screen`: take a screenshot (full or region), return base64 PNG
//! - `mouse_click`: move mouse and click at coordinates
//! - `mouse_move`: move mouse to coordinates without clicking
//! - `keyboard_type`: type text string
//! - `keyboard_press`: press key combination (e.g. Ctrl+C)
//! - `check_macos_permissions`: check Screen Recording & Accessibility status

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use enigo::{
    Axis, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings,
    Button as EnigoButton, Key,
};
use image::codecs::png::PngEncoder;
use image::ImageEncoder;
use serde::Serialize;
use std::io::Cursor;
use xcap::Monitor;

// macOS CGWindowList API for screenshot-with-exclusion.
// CGWindowListCreateImage is deprecated by Apple in favor of ScreenCaptureKit,
// but still works on all current macOS versions and is much simpler to use.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
use objc2_core_graphics::{
    CGRectInfinite, CGWindowID, CGWindowImageOption, CGWindowListCreateImage,
    CGWindowListOption,
};

// macOS permission checks via FFI
#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[derive(Serialize)]
pub struct MacPermissions {
    pub screen_recording: bool,
    pub accessibility: bool,
}

/// Check Screen Recording and Accessibility permissions.
/// On macOS: uses native APIs. On Windows: checks UAC elevation.
/// On other platforms: returns true for both.
#[tauri::command]
pub fn check_macos_permissions() -> MacPermissions {
    #[cfg(target_os = "macos")]
    {
        let screen_recording = unsafe { CGPreflightScreenCaptureAccess() };
        let accessibility = unsafe { AXIsProcessTrusted() };
        MacPermissions { screen_recording, accessibility }
    }
    #[cfg(target_os = "windows")]
    {
        // Windows doesn't require explicit screen recording permission.
        // Accessibility (controlling other windows) works best with elevated privileges.
        use std::process::Command as StdCommand;
        use std::os::windows::process::CommandExt;
        let is_elevated = StdCommand::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "True")
            .unwrap_or(false);
        MacPermissions { screen_recording: true, accessibility: is_elevated }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        MacPermissions { screen_recording: true, accessibility: true }
    }
}

/// Request macOS Screen Recording permission (triggers system prompt on first call).
/// Returns true if already granted.
#[tauri::command]
pub fn request_screen_recording() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { CGRequestScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[derive(Serialize)]
pub struct ScreenshotResult {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    /// The scale factor applied (original_width / returned_width). 1.0 means no scaling.
    pub scale_factor: f64,
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
    tauri::async_runtime::spawn_blocking(move || {
        let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        let monitor = monitors
            .into_iter()
            .next()
            .ok_or_else(|| "No monitor found".to_string())?;

        let img = monitor
            .capture_image()
            .map_err(|e| format!("Screenshot failed: {}", e))?;

        // Optionally crop to region
        let cropped = if let (Some(rx), Some(ry), Some(rw), Some(rh)) = (x, y, width, height) {
            let rx = rx.max(0) as u32;
            let ry = ry.max(0) as u32;
            let rw = rw.min(img.width().saturating_sub(rx));
            let rh = rh.min(img.height().saturating_sub(ry));
            if rw == 0 || rh == 0 {
                return Err("Crop region is empty".to_string());
            }
            image::DynamicImage::from(img).crop_imm(rx, ry, rw, rh)
        } else {
            image::DynamicImage::from(img)
        };

        // Downscale if max_width is specified and image exceeds it
        let orig_w = cropped.width();
        let (final_img, scale_factor) = if let Some(mw) = max_width {
            if orig_w > mw {
                let scale = orig_w as f64 / mw as f64;
                let new_h = (cropped.height() as f64 / scale) as u32;
                let resized = cropped.resize(mw, new_h, image::imageops::FilterType::Lanczos3);
                (resized, scale)
            } else {
                (cropped, 1.0)
            }
        } else {
            (cropped, 1.0)
        };

        let w = final_img.width();
        let h = final_img.height();

        // Encode to PNG in memory
        let mut buf = Cursor::new(Vec::new());
        let encoder = PngEncoder::new(&mut buf);
        encoder
            .write_image(
                final_img.as_bytes(),
                w,
                h,
                final_img.color().into(),
            )
            .map_err(|e| format!("PNG encode failed: {}", e))?;

        let base64_str = BASE64.encode(buf.into_inner());

        Ok(ScreenshotResult {
            base64: base64_str,
            width: w,
            height: h,
            scale_factor,
        })
    })
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
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("Mouse move failed: {}", e))?;

    // HID settle delay — let OS register the move before clicking
    std::thread::sleep(std::time::Duration::from_millis(100));

    let btn = match button.as_deref().unwrap_or("left") {
        "right" => EnigoButton::Right,
        "middle" => EnigoButton::Middle,
        _ => EnigoButton::Left,
    };

    let btn_name = button.as_deref().unwrap_or("left");

    if btn_name == "double" {
        enigo
            .button(EnigoButton::Left, Direction::Click)
            .map_err(|e| format!("Click failed: {}", e))?;
        std::thread::sleep(std::time::Duration::from_millis(100));
        enigo
            .button(EnigoButton::Left, Direction::Click)
            .map_err(|e| format!("Click failed: {}", e))?;
    } else {
        enigo
            .button(btn, Direction::Click)
            .map_err(|e| format!("Click failed: {}", e))?;
    }

    Ok(format!("Clicked {} at ({}, {})", btn_name, x, y))
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
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    enigo
        .text(&text)
        .map_err(|e| format!("Keyboard type failed: {}", e))?;

    Ok(format!("Typed {} characters", text.len()))
}

/// Press a key combination (e.g. key="Return", modifiers=["meta"]).
/// Runs synchronously on the main thread — Enigo/TSM APIs require main dispatch queue on macOS.
#[tauri::command]
pub fn keyboard_press(
    key: String,
    modifiers: Option<Vec<String>>,
) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    let mods = modifiers.unwrap_or_default();

    // Track successfully pressed modifiers for safe cleanup on error
    let mut pressed_keys: Vec<Key> = Vec::new();

    let result = (|| -> Result<(), String> {
        // Press modifiers down
        for m in &mods {
            let k = parse_modifier(m)?;
            enigo
                .key(k, Direction::Press)
                .map_err(|e| format!("Modifier press failed: {}", e))?;
            pressed_keys.push(k);
        }

        // Press and release the main key
        let main_key = parse_key(&key)?;
        enigo
            .key(main_key, Direction::Click)
            .map_err(|e| format!("Key press failed: {}", e))?;

        Ok(())
    })();

    // Always release pressed modifiers in reverse order (even on error)
    // This prevents stuck modifier keys when the main key press fails
    for k in pressed_keys.into_iter().rev() {
        let _ = enigo.key(k, Direction::Release); // Best-effort, swallow errors
    }

    // Propagate any error from the press phase
    result?;

    let mod_str = if mods.is_empty() {
        String::new()
    } else {
        format!("{}+", mods.join("+"))
    };
    Ok(format!("Pressed {}{}", mod_str, key))
}

/// Scroll at (x, y) in a direction. Amount is number of "ticks" (default 3).
#[tauri::command]
pub fn mouse_scroll(
    x: i32,
    y: i32,
    direction: String,
    amount: Option<i32>,
) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    // Move to position first
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("Mouse move failed: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(100));

    let ticks = amount.unwrap_or(3);
    let (axis, value) = match direction.as_str() {
        "up" => (Axis::Vertical, ticks),
        "down" => (Axis::Vertical, -ticks),
        "left" => (Axis::Horizontal, -ticks),
        "right" => (Axis::Horizontal, ticks),
        other => return Err(format!("Unknown scroll direction: {}", other)),
    };

    enigo
        .scroll(value, axis)
        .map_err(|e| format!("Scroll failed: {}", e))?;

    Ok(format!("Scrolled {} {} ticks at ({}, {})", direction, ticks, x, y))
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
    use std::time::Duration;

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    // Move to start position
    enigo
        .move_mouse(start_x, start_y, Coordinate::Abs)
        .map_err(|e| format!("Mouse move failed: {}", e))?;
    std::thread::sleep(Duration::from_millis(100));

    // Press mouse button
    enigo
        .button(EnigoButton::Left, Direction::Press)
        .map_err(|e| format!("Mouse down failed: {}", e))?;
    std::thread::sleep(Duration::from_millis(100));

    // Animated move: ease-out-cubic at 60fps, 2000px/s speed, max 0.5s
    let dx = (end_x - start_x) as f64;
    let dy = (end_y - start_y) as f64;
    let distance = (dx * dx + dy * dy).sqrt();
    let duration_sec = (distance / 2000.0).min(0.5).max(0.05);
    let total_frames = (duration_sec * 60.0) as i32;

    if total_frames > 1 {
        let frame_ms = (duration_sec * 1000.0 / total_frames as f64) as u64;
        for frame in 1..=total_frames {
            let t = frame as f64 / total_frames as f64;
            let eased = 1.0 - (1.0 - t).powi(3); // ease-out-cubic
            let x = start_x + (dx * eased) as i32;
            let y = start_y + (dy * eased) as i32;
            let _ = enigo.move_mouse(x, y, Coordinate::Abs);
            if frame < total_frames {
                std::thread::sleep(Duration::from_millis(frame_ms));
            }
        }
    } else {
        enigo
            .move_mouse(end_x, end_y, Coordinate::Abs)
            .map_err(|e| format!("Mouse drag move failed: {}", e))?;
    }

    std::thread::sleep(Duration::from_millis(100));

    // Release mouse button
    enigo
        .button(EnigoButton::Left, Direction::Release)
        .map_err(|e| format!("Mouse up failed: {}", e))?;

    Ok(format!("Dragged from ({}, {}) to ({}, {})", start_x, start_y, end_x, end_y))
}

fn parse_modifier(m: &str) -> Result<Key, String> {
    match m.to_lowercase().as_str() {
        "ctrl" | "control" => Ok(Key::Control),
        "shift" => Ok(Key::Shift),
        "alt" | "option" => Ok(Key::Alt),
        "meta" | "cmd" | "command" | "win" | "super" => Ok(Key::Meta),
        other => Err(format!("Unknown modifier: {}", other)),
    }
}

fn parse_key(k: &str) -> Result<Key, String> {
    // Single character
    if k.len() == 1 {
        let ch = k.chars().next().unwrap();
        return Ok(Key::Unicode(ch));
    }

    match k.to_lowercase().as_str() {
        "return" | "enter" => Ok(Key::Return),
        "tab" => Ok(Key::Tab),
        "escape" | "esc" => Ok(Key::Escape),
        "backspace" => Ok(Key::Backspace),
        "delete" => Ok(Key::Delete),
        "space" => Ok(Key::Space),
        "up" | "arrowup" => Ok(Key::UpArrow),
        "down" | "arrowdown" => Ok(Key::DownArrow),
        "left" | "arrowleft" => Ok(Key::LeftArrow),
        "right" | "arrowright" => Ok(Key::RightArrow),
        "home" => Ok(Key::Home),
        "end" => Ok(Key::End),
        "pageup" => Ok(Key::PageUp),
        "pagedown" => Ok(Key::PageDown),
        "f1" => Ok(Key::F1),
        "f2" => Ok(Key::F2),
        "f3" => Ok(Key::F3),
        "f4" => Ok(Key::F4),
        "f5" => Ok(Key::F5),
        "f6" => Ok(Key::F6),
        "f7" => Ok(Key::F7),
        "f8" => Ok(Key::F8),
        "f9" => Ok(Key::F9),
        "f10" => Ok(Key::F10),
        "f11" => Ok(Key::F11),
        "f12" => Ok(Key::F12),
        "capslock" => Ok(Key::CapsLock),
        other => Err(format!("Unknown key: {}", other)),
    }
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

/// Capture the screen excluding a specific window (by CGWindowID).
///
/// Uses CGWindowListCreateImage with OptionOnScreenBelowWindow to capture
/// everything on screen BELOW the specified window — effectively excluding
/// that window and any windows above it from the screenshot.
///
/// This allows Abu to take screenshots without hiding its own window.
#[tauri::command]
pub async fn capture_screen_excluding(
    exclude_window_id: u32,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    max_width: Option<u32>,
) -> Result<ScreenshotResult, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            capture_excluding_impl(exclude_window_id, x, y, width, height, max_width)
        })
        .await
        .map_err(|e| format!("Task join error: {}", e))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Fallback to regular capture on non-macOS (xcap doesn't support exclusion)
        capture_screen(x, y, width, height, max_width).await
    }
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // CGWindowListCreateImage — still functional, simpler than ScreenCaptureKit
fn capture_excluding_impl(
    exclude_window_id: u32,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    max_width: Option<u32>,
) -> Result<ScreenshotResult, String> {
    unsafe {
        // Capture everything on screen below the excluded window.
        // This excludes the Abu window (and any window above it) from the screenshot.
        let cg_image = CGWindowListCreateImage(
            CGRectInfinite,
            CGWindowListOption::OptionOnScreenBelowWindow,
            exclude_window_id as CGWindowID,
            CGWindowImageOption::Default,
        );

        let cg_image = cg_image
            .ok_or_else(|| "CGWindowListCreateImage returned null — check Screen Recording permission".to_string())?;

        use objc2_core_graphics::{CGImage, CGDataProvider};

        let img_w = CGImage::width(Some(&cg_image));
        let img_h = CGImage::height(Some(&cg_image));
        let bytes_per_row = CGImage::bytes_per_row(Some(&cg_image));

        if img_w == 0 || img_h == 0 {
            return Err("Screenshot captured empty image".to_string());
        }

        let data_provider = CGImage::data_provider(Some(&cg_image))
            .ok_or_else(|| "Failed to get data provider".to_string())?;
        let data = CGDataProvider::data(Some(&data_provider))
            .ok_or_else(|| "Failed to copy image data".to_string())?
            .to_vec();

        // Convert BGRA → RGBA, stripping row padding
        let mut buffer = Vec::with_capacity(img_w * img_h * 4);
        for row in data.chunks_exact(bytes_per_row) {
            let row_pixels = &row[..img_w * 4];
            for bgra in row_pixels.chunks_exact(4) {
                buffer.push(bgra[2]); // R
                buffer.push(bgra[1]); // G
                buffer.push(bgra[0]); // B
                buffer.push(bgra[3]); // A
            }
        }

        let img = image::RgbaImage::from_raw(img_w as u32, img_h as u32, buffer)
            .ok_or_else(|| "Failed to create image from raw data".to_string())?;
        let dynamic = image::DynamicImage::from(img);

        // Optional crop
        let cropped = if let (Some(rx), Some(ry), Some(rw), Some(rh)) = (x, y, width, height) {
            let rx = rx.max(0) as u32;
            let ry = ry.max(0) as u32;
            let rw = rw.min(dynamic.width().saturating_sub(rx));
            let rh = rh.min(dynamic.height().saturating_sub(ry));
            if rw == 0 || rh == 0 {
                return Err("Crop region is empty".to_string());
            }
            dynamic.crop_imm(rx, ry, rw, rh)
        } else {
            dynamic
        };

        // Downscale if needed
        let orig_w = cropped.width();
        let (final_img, scale_factor) = if let Some(mw) = max_width {
            if orig_w > mw {
                let scale = orig_w as f64 / mw as f64;
                let new_h = (cropped.height() as f64 / scale) as u32;
                let resized = cropped.resize(mw, new_h, image::imageops::FilterType::Lanczos3);
                (resized, scale)
            } else {
                (cropped, 1.0)
            }
        } else {
            (cropped, 1.0)
        };

        let w = final_img.width();
        let h = final_img.height();

        // Encode to PNG
        let mut buf = Cursor::new(Vec::new());
        let encoder = PngEncoder::new(&mut buf);
        encoder
            .write_image(final_img.as_bytes(), w, h, final_img.color().into())
            .map_err(|e| format!("PNG encode failed: {}", e))?;

        Ok(ScreenshotResult {
            base64: BASE64.encode(buf.into_inner()),
            width: w,
            height: h,
            scale_factor,
        })
    }
}

// ─── App focus management ────────────────────────────────────

/// Activate (bring to front) an application by name.
/// Uses AppleScript on macOS, PowerShell on Windows.
#[tauri::command]
pub fn activate_app(app_name: String) -> Result<String, String> {
    activate_app_impl(&app_name)
}

#[cfg(target_os = "macos")]
fn activate_app_impl(app_name: &str) -> Result<String, String> {
    use std::process::{Command, Stdio};

    // Sanitize app name to prevent AppleScript injection
    let safe_name = app_name.replace('\\', "").replace('"', "");

    let script = format!(
        r#"tell application "{}" to activate"#,
        safe_name
    );

    let output = Command::new("osascript")
        .args(["-e", &script])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to activate '{}': {}", app_name, stderr.trim()));
    }

    Ok(format!("Activated '{}'", app_name))
}

#[cfg(target_os = "windows")]
fn activate_app_impl(app_name: &str) -> Result<String, String> {
    use std::process::{Command, Stdio};

    let script = format!(
        r#"$proc = Get-Process -Name '{}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($proc) {{ [void][System.Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) }} else {{ Write-Error 'Process not found' }}"#,
        app_name.replace('\'', "")
    );

    use std::os::windows::process::CommandExt;
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
fn activate_app_impl(app_name: &str) -> Result<String, String> {
    Err(format!("activate_app not supported on this platform (tried to activate '{}')", app_name))
}
