//! Active window info — get the frontmost application name and window title.
//!
//! macOS: uses osascript (AppleScript) — no extra crates needed.
//! Windows: uses PowerShell to query the foreground window.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct ActiveWindowInfo {
    pub app_name: String,
    pub window_title: String,
    pub bundle_id: Option<String>,
}

/// Get the currently focused window's app name and title.
#[tauri::command]
pub fn get_active_window() -> Result<ActiveWindowInfo, String> {
    get_active_window_impl()
}

#[cfg(target_os = "macos")]
fn get_active_window_impl() -> Result<ActiveWindowInfo, String> {
    use std::process::{Command, Stdio};

    // AppleScript to get frontmost app name, window title, and bundle identifier
    let script = r#"
        tell application "System Events"
            set frontApp to first application process whose frontmost is true
            set appName to name of frontApp
            set bundleId to bundle identifier of frontApp
            try
                set winTitle to name of front window of frontApp
            on error
                set winTitle to ""
            end try
        end tell
        return appName & "|||" & winTitle & "|||" & bundleId
    "#;

    let output = Command::new("osascript")
        .args(["-e", script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        return Err("osascript failed".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = text.splitn(3, "|||").collect();

    Ok(ActiveWindowInfo {
        app_name: parts.first().unwrap_or(&"").to_string(),
        window_title: parts.get(1).unwrap_or(&"").to_string(),
        bundle_id: parts.get(2).map(|s| s.to_string()).filter(|s| !s.is_empty()),
    })
}

#[cfg(target_os = "windows")]
fn get_active_window_impl() -> Result<ActiveWindowInfo, String> {
    use std::process::{Command, Stdio};

    // PowerShell script to get foreground window info
    let script = r#"
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        using System.Text;
        public class WinAPI {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        }
"@
        $hwnd = [WinAPI]::GetForegroundWindow()
        $sb = New-Object System.Text.StringBuilder 256
        [WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        $pid = 0
        [WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        $appName = if ($proc) { $proc.ProcessName } else { "" }
        Write-Output "$appName|||$title"
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
        return Err("PowerShell command failed".to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let parts: Vec<&str> = text.splitn(2, "|||").collect();

    // On Windows, use process path as a pseudo bundle_id
    let process_name = parts.first().unwrap_or(&"").to_string();
    Ok(ActiveWindowInfo {
        app_name: process_name.clone(),
        window_title: parts.get(1).unwrap_or(&"").to_string(),
        bundle_id: if process_name.is_empty() { None } else { Some(process_name) },
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn get_active_window_impl() -> Result<ActiveWindowInfo, String> {
    Err("Active window detection not supported on this platform".to_string())
}
