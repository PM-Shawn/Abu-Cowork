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
        
        let mut cmd = StdCommand::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
            "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"]);
        cmd.creation_flags(0x08000000);  // CREATE_NO_WINDOW
        
        let is_elevated = cmd.output()
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

    // Small delay to let the OS register the move
    std::thread::sleep(std::time::Duration::from_millis(200));

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
        std::thread::sleep(std::time::Duration::from_millis(200));
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

    // Press modifiers down
    for m in &mods {
        let k = parse_modifier(m)?;
        enigo
            .key(k, Direction::Press)
            .map_err(|e| format!("Modifier press failed: {}", e))?;
    }

    // Press and release the main key
    let main_key = parse_key(&key)?;
    enigo
        .key(main_key, Direction::Click)
        .map_err(|e| format!("Key press failed: {}", e))?;

    // Release modifiers in reverse
    for m in mods.iter().rev() {
        let k = parse_modifier(m)?;
        enigo
            .key(k, Direction::Release)
            .map_err(|e| format!("Modifier release failed: {}", e))?;
    }

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
    std::thread::sleep(std::time::Duration::from_millis(200));

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
#[tauri::command]
pub fn mouse_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
) -> Result<String, String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("Enigo init failed: {}", e))?;

    enigo
        .move_mouse(start_x, start_y, Coordinate::Abs)
        .map_err(|e| format!("Mouse move failed: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(200));

    enigo
        .button(EnigoButton::Left, Direction::Press)
        .map_err(|e| format!("Mouse down failed: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(200));

    enigo
        .move_mouse(end_x, end_y, Coordinate::Abs)
        .map_err(|e| format!("Mouse drag move failed: {}", e))?;
    std::thread::sleep(std::time::Duration::from_millis(200));

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
