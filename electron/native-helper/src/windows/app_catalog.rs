use crate::error::HelperError;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::Shell::ShellExecuteW;
use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use super::window::{
    activate_window_impl, frontmost_app_identity_impl, list_windows_impl, WindowRef,
};

const MAX_CATALOG_ENTRIES: usize = 10_000;
const MAX_DIRECTORY_DEPTH: usize = 12;

#[derive(Clone, Debug, Serialize)]
pub struct AppCatalogEntry {
    pub app_id: String,
    pub app_name: String,
    pub launch_target: String,
    pub source: String,
    pub running: bool,
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn stable_path_id(path: &Path) -> String {
    format!("shortcut:{}", normalize(&path.to_string_lossy()))
}

fn shortcut_name(path: &Path) -> Option<String> {
    let name = path.file_stem()?.to_string_lossy().trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn scan_shortcuts(root: &Path, source: &str, result: &mut Vec<AppCatalogEntry>) {
    if !root.is_dir() || result.len() >= MAX_CATALOG_ENTRIES {
        return;
    }
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_DIRECTORY_DEPTH || result.len() >= MAX_CATALOG_ENTRIES {
            continue;
        }
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if result.len() >= MAX_CATALOG_ENTRIES {
                break;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let supported = path
                .extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "lnk" | "exe" | "url"
                    )
                });
            if !supported {
                continue;
            }
            let Some(app_name) = shortcut_name(&path) else {
                continue;
            };
            result.push(AppCatalogEntry {
                app_id: stable_path_id(&path),
                app_name,
                launch_target: path.to_string_lossy().to_string(),
                source: source.to_string(),
                running: false,
            });
        }
    }
}

fn start_menu_roots() -> Vec<(PathBuf, &'static str)> {
    let mut roots = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push((
            PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs"),
            "user-start-menu",
        ));
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        roots.push((
            PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"),
            "machine-start-menu",
        ));
    }
    roots
}

pub fn list_apps_impl() -> Result<Vec<AppCatalogEntry>, HelperError> {
    let mut result = Vec::new();
    let mut running_by_id = HashMap::<String, WindowRef>::new();
    for window in list_windows_impl(None)? {
        running_by_id
            .entry(normalize(&window.app_id))
            .or_insert(window);
    }
    for window in running_by_id.values() {
        result.push(AppCatalogEntry {
            app_id: window.app_id.clone(),
            app_name: window.app_name.clone(),
            launch_target: window.executable_path.clone(),
            source: "running-window".to_string(),
            running: true,
        });
    }
    for (root, source) in start_menu_roots() {
        scan_shortcuts(&root, source, &mut result);
    }

    let mut seen = HashSet::new();
    result.retain(|entry| seen.insert((normalize(&entry.app_id), normalize(&entry.app_name))));
    result.sort_by(|left, right| {
        normalize(&left.app_name)
            .cmp(&normalize(&right.app_name))
            .then_with(|| left.app_id.cmp(&right.app_id))
    });
    Ok(result)
}

fn shell_execute(target: &str) -> Result<(), HelperError> {
    let wide: Vec<u16> = OsStr::new(target).encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            PCWSTR::null(),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        return Err(HelperError::not_executed("activation-refused", format!(
            "Windows refused to launch the selected application ({})",
            result.0 as isize
        )));
    }
    Ok(())
}

pub fn launch_app_impl(query: String) -> Result<AppCatalogEntry, HelperError> {
    let needle = normalize(&query);
    if needle.is_empty() {
        return Err(HelperError::not_executed("invalid-params", "application name must not be empty"));
    }

    // Activating an already-running exact match avoids creating duplicate
    // application windows and preserves the target WindowRef.
    let running = list_windows_impl(None)?;
    let mut exact_running: Vec<_> = running
        .iter()
        .filter(|window| {
            normalize(&window.app_name) == needle || normalize(&window.app_id) == needle
        })
        .collect();
    let distinct_running_ids: HashSet<_> = exact_running
        .iter()
        .map(|window| normalize(&window.app_id))
        .collect();
    if exact_running.len() > 1 && distinct_running_ids.len() > 1 {
        return Err(HelperError::not_executed("app-ambiguous", format!(
            "application '{query}' is ambiguous across multiple application identities"
        )));
    }
    if !exact_running.is_empty() {
        let foreground_window_id = frontmost_app_identity_impl()
            .ok()
            .map(|identity| identity.window_id);
        exact_running.sort_by_key(|window| {
            let area = i64::from(window.bounds[2]).saturating_mul(i64::from(window.bounds[3]));
            let is_not_foreground = foreground_window_id
                .as_ref()
                .is_none_or(|window_id| !window.window_id.eq_ignore_ascii_case(window_id));
            (is_not_foreground, window.minimized, Reverse(area))
        });
        let window = activate_window_impl(exact_running[0].window_id.clone())?;
        return Ok(AppCatalogEntry {
            app_id: window.app_id,
            app_name: window.app_name,
            launch_target: window.executable_path,
            source: "running-window".to_string(),
            running: true,
        });
    }
    let catalog = list_apps_impl()?;
    let mut matches: Vec<_> = catalog
        .into_iter()
        .filter(|entry| {
            normalize(&entry.app_name) == needle
                || normalize(&entry.app_id) == needle
                || normalize(&entry.launch_target) == needle
        })
        .collect();
    matches.sort_by_key(|entry| (!entry.running, entry.app_id.clone()));
    matches
        .dedup_by(|left, right| normalize(&left.launch_target) == normalize(&right.launch_target));
    if matches.is_empty() {
        return Err(HelperError::not_executed("app-not-found", format!(
            "application '{query}' was not found in running windows or Start Menu"
        )));
    }
    if matches.len() > 1 {
        let choices = matches
            .iter()
            .take(5)
            .map(|entry| entry.app_id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(HelperError::not_executed("app-ambiguous", format!("application '{query}' is ambiguous: {choices}")));
    }
    let selected = matches.remove(0);
    shell_execute(&selected.launch_target)?;
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::{normalize, shortcut_name, stable_path_id};
    use std::path::Path;

    #[test]
    fn shortcut_identity_is_case_insensitive_and_stable() {
        assert_eq!(
            stable_path_id(Path::new(r"C:\Menu\Notepad.lnk")),
            "shortcut:c:\\menu\\notepad.lnk"
        );
        assert_eq!(
            shortcut_name(Path::new(r"C:\Menu\Notepad.lnk")).as_deref(),
            Some("Notepad")
        );
        assert_eq!(normalize("  NOTEPAD "), "notepad");
    }
}
