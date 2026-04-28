//! Fullscreen application detection for Notice Gate.
//!
//! Gate queues L2 notices to inbox when a fullscreen app is active, so
//! presentations / games / focus apps aren't interrupted. L3 in
//! fullscreen is dropped (never queues, too low value to warrant
//! buffer pressure). L1 bypasses Gate entirely.
//!
//! macOS: osascript reads the AXFullScreen accessibility attribute of
//!   the frontmost window. Same Accessibility permission that
//!   `window_info::get_active_window` already uses — no new prompt.
//! Windows: PowerShell + user32 DLL — compares the foreground
//!   window's rect to the primary screen size.
//!
//! MVP-quality: shells out to osascript/powershell rather than native
//! crates to keep Cargo.toml lean. Gate calls this at most every few
//! seconds (TS-side cache on top), so shell-out cost is acceptable.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct FullscreenInfo {
    pub is_fullscreen: bool,
    /// Name of the fullscreen app, None when not fullscreen.
    pub app_name: Option<String>,
}

/// Query whether a fullscreen app is currently focused.
#[tauri::command]
pub fn check_fullscreen() -> Result<FullscreenInfo, String> {
    check_fullscreen_impl()
}

#[cfg(target_os = "macos")]
fn check_fullscreen_impl() -> Result<FullscreenInfo, String> {
    use std::process::{Command, Stdio};

    let script = r#"
        tell application "System Events"
            set frontApp to first application process whose frontmost is true
            set appName to name of frontApp
            try
                set isFS to value of attribute "AXFullScreen" of window 1 of frontApp
            on error
                set isFS to false
            end try
        end tell
        return appName & "|||" & isFS
    "#;

    let output = Command::new("osascript")
        .args(["-e", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        return Err("osascript exited non-zero".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = text.splitn(2, "|||").collect();
    let app = parts.first().unwrap_or(&"").to_string();
    let is_fs = parts
        .get(1)
        .map(|s| s.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    Ok(FullscreenInfo {
        is_fullscreen: is_fs,
        app_name: if is_fs && !app.is_empty() { Some(app) } else { None },
    })
}

#[cfg(target_os = "windows")]
fn check_fullscreen_impl() -> Result<FullscreenInfo, String> {
    use std::process::{Command, Stdio};

    let script = r#"
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class FS {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
            [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
            [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        }
"@
        $hwnd = [FS]::GetForegroundWindow()
        $rect = New-Object FS+RECT
        [FS]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
        $sw = [FS]::GetSystemMetrics(0)
        $sh = [FS]::GetSystemMetrics(1)
        $w = $rect.Right - $rect.Left
        $h = $rect.Bottom - $rect.Top
        $isFS = ($w -ge $sw -and $h -ge $sh)
        $pid = 0
        [FS]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $appName = if ($proc) { $proc.ProcessName } else { "" }
        Write-Output "$appName|||$isFS"
    "#;

    use std::os::windows::process::CommandExt;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

    if !output.status.success() {
        return Err("PowerShell exited non-zero".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = text.splitn(2, "|||").collect();
    let app = parts.first().unwrap_or(&"").to_string();
    let is_fs = parts
        .get(1)
        .map(|s| s.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    Ok(FullscreenInfo {
        is_fullscreen: is_fs,
        app_name: if is_fs && !app.is_empty() { Some(app) } else { None },
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn check_fullscreen_impl() -> Result<FullscreenInfo, String> {
    Ok(FullscreenInfo {
        is_fullscreen: false,
        app_name: None,
    })
}
