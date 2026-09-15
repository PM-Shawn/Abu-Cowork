use crate::error::HelperError;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_void, OsStr};
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use ::windows::core::{Interface, PCWSTR};
use ::windows::Win32::Foundation::{ERROR_SUCCESS, HWND};
use ::windows::Win32::Storage::FileSystem::{SearchPathW, WIN32_FIND_DATAW};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    IPersistFile, STGM_READ,
};
use ::windows::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ,
    RRF_RT_REG_SZ,
};
use ::windows::Win32::UI::Shell::{IShellLinkW, ShellExecuteW, ShellLink, SLGP_RAWPATH};
use ::windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use super::signature::executable_signature;
use super::window::{
    activate_window_impl, app_name_from_path, canonical_app_query, frontmost_app_identity_impl,
    identity, list_windows_impl, resolve_window, stable_app_id, AppIdentity, WindowRef,
};

const MAX_CATALOG_ENTRIES: usize = 10_000;
const MAX_DIRECTORY_DEPTH: usize = 12;

/// Poll cadence/budget for the window-appeared wait after a successful
/// `ShellExecuteW`. Windows 11 Store apps start a different process than the
/// stub that was launched, so `wait_for_launched_window` below accepts either
/// the canonical app name resolving to a window, or any visible window whose
/// executable path lands on the one resolved for the launch.
const LAUNCH_WINDOW_POLL_INTERVAL: Duration = Duration::from_millis(150);
const LAUNCH_WINDOW_POLL_TIMEOUT: Duration = Duration::from_millis(5_000);

#[derive(Clone, Debug, Serialize)]
pub struct AppCatalogEntry {
    pub app_id: String,
    pub app_name: String,
    pub launch_target: String,
    pub source: String,
    pub running: bool,
}

/// `launch_app` result: the resolved catalog entry plus the window that
/// appeared for it, if one showed up before the poll budget ran out. A
/// missing window is not an error — the Host decides what to do with
/// `window: null`.
#[derive(Clone, Debug, Serialize)]
pub struct LaunchResult {
    #[serde(flatten)]
    pub entry: AppCatalogEntry,
    pub window: Option<WindowRef>,
}

/// `resolve_launch_target` result: what launching `app_name` right now would
/// hit, without actually launching it.
#[derive(Clone, Debug, Serialize)]
pub struct LaunchTargetResolution {
    pub running: bool,
    pub launch_target: String,
    pub identity: AppIdentity,
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
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
    let wide = wide_null(target);
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

/// True when `query` looks like it could be (or contain) a filesystem path —
/// `\`, `/`, `:`, or `..`. A catalog `app_id` may legitimately contain these
/// (e.g. `shortcut:c:\...\x.lnk`), but the App Paths/PATH fallback below must
/// never turn arbitrary user text into a path, so it refuses to run for
/// anything that looks like one.
fn looks_like_path(query: &str) -> bool {
    query.contains('\\') || query.contains('/') || query.contains(':') || query.contains("..")
}

/// A handful of canonical app names whose real executable stem differs from
/// the display name `canonical_app_query` produces. Extend deliberately —
/// each entry should be a name Windows itself uses, verified against a real
/// install, not a guess.
fn fallback_exe_stem(canonical: &str) -> &str {
    match canonical {
        "calculator" => "calc",
        other => other,
    }
}

/// Builds the `<name>.exe` candidate for the App Paths/PATH fallback: the
/// canonical stem plus `.exe`, unless it already ends with `.exe`
/// (case-insensitive) — so `WINWORD.EXE` keeps one suffix instead of
/// becoming `WINWORD.EXE.exe`.
pub(crate) fn fallback_exe_name(query: &str) -> String {
    let canonical = canonical_app_query(query);
    let stem = fallback_exe_stem(&canonical);
    if stem.to_ascii_lowercase().ends_with(".exe") {
        stem.to_string()
    } else {
        format!("{stem}.exe")
    }
}

/// Reads the default value of `HKEY_*\...\App Paths\<exe_name>`, auto-expanding
/// a `REG_EXPAND_SZ` value's environment references and stripping surrounding
/// quotes. `None` when the value is absent or unreadable.
fn read_app_paths_registry(hive: HKEY, exe_name: &str) -> Option<String> {
    let subkey = wide_null(&format!(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}"
    ));
    let mut buffer = vec![0u16; 8_192];
    let mut size_bytes = (buffer.len() * size_of::<u16>()) as u32;
    let status = unsafe {
        RegGetValueW(
            hive,
            PCWSTR(subkey.as_ptr()),
            PCWSTR::null(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            None,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            Some(&mut size_bytes),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let chars = (size_bytes as usize / size_of::<u16>()).min(buffer.len());
    let end = buffer[..chars]
        .iter()
        .position(|&value| value == 0)
        .unwrap_or(chars);
    let raw = String::from_utf16_lossy(&buffer[..end]);
    let unquoted = raw.trim().trim_matches('"').trim().to_string();
    (!unquoted.is_empty()).then_some(unquoted)
}

/// `SearchPathW` for `exe_name` across the standard Windows search order
/// (application directory, system directories, `PATH`). Always called with an
/// explicit `.exe` suffix so it cannot match an extensionless same-named file
/// on `PATH` — this machine's Git install ships an extensionless `notepad`
/// shim in `Git\usr\bin`, which a bare "notepad" search would otherwise hit.
fn search_path_for_exe(exe_name: &str) -> Option<String> {
    let exe_wide = wide_null(exe_name);
    let mut buffer = vec![0u16; 8_192];
    let length = unsafe {
        SearchPathW(
            PCWSTR::null(),
            PCWSTR(exe_wide.as_ptr()),
            PCWSTR::null(),
            Some(&mut buffer),
            None,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return None;
    }
    let trimmed = String::from_utf16_lossy(&buffer[..length as usize])
        .trim()
        .to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Resolves `exe_name` to a file that actually exists, in App Paths (current
/// user, then local machine) / PATH-search order, tagging which source
/// answered.
fn resolve_exe_path(exe_name: &str) -> Option<(String, &'static str)> {
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Some(path) = read_app_paths_registry(hive, exe_name) {
            if Path::new(&path).is_file() {
                return Some((path, "app-paths"));
            }
        }
    }
    search_path_for_exe(exe_name).map(|path| (path, "search-path"))
}

/// The last-resort fallback used only when neither a running window nor the
/// Start Menu catalog match `query`: canonicalize it to an exe name and
/// resolve that name via the registry's App Paths mechanism, then `PATH`.
/// Refuses any query that looks like a path — see `looks_like_path` — so
/// this can never turn arbitrary user/app_id text into a filesystem path.
pub(crate) fn resolve_fallback_executable(query: &str) -> Option<AppCatalogEntry> {
    if looks_like_path(query) {
        return None;
    }
    let exe_name = fallback_exe_name(query);
    let (path, source) = resolve_exe_path(&exe_name)?;
    Some(AppCatalogEntry {
        app_id: stable_app_id(None, &path),
        app_name: app_name_from_path(&path),
        launch_target: path,
        source: source.to_string(),
        running: false,
    })
}

/// Resolves a `.lnk` shortcut's real target via `IShellLinkW` + `IPersistFile`
/// COM. Returns `None` on any COM failure — the caller treats an
/// unresolvable shortcut the same as one with no executable path.
fn resolve_shortcut_target(lnk_path: &Path) -> Option<String> {
    // Tolerate "already initialized": CoInitializeEx's S_FALSE is still `Ok`
    // in windows-rs, the same tolerance the UIA worker thread relies on. This
    // can run on a thread COM was never touched on yet, or one that already
    // has an apartment from earlier in the process.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let shell_link: IShellLinkW =
        unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }.ok()?;
    let persist_file: IPersistFile = shell_link.cast().ok()?;
    let wide_path = wide_null(&lnk_path.to_string_lossy());
    unsafe { persist_file.Load(PCWSTR(wide_path.as_ptr()), STGM_READ) }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut find_data = WIN32_FIND_DATAW::default();
    unsafe { shell_link.GetPath(&mut buffer, &mut find_data, SLGP_RAWPATH.0 as u32) }.ok()?;
    let end = buffer
        .iter()
        .position(|&value| value == 0)
        .unwrap_or(buffer.len());
    let resolved = String::from_utf16_lossy(&buffer[..end]).trim().to_string();
    (!resolved.is_empty()).then_some(resolved)
}

/// The executable path actually behind a resolved launch target: itself for
/// an `.exe`, the shortcut's resolved target for a `.lnk` (kept only if it
/// exists and ends in `.exe`), and `None` for a `.url` or an unresolvable
/// `.lnk` — those have no single executable identity to report.
fn executable_path_for_target(launch_target: &str) -> Option<String> {
    let path = Path::new(launch_target);
    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("exe") => Some(launch_target.to_string()),
        Some("lnk") => resolve_shortcut_target(path).filter(|resolved| {
            resolved.to_ascii_lowercase().ends_with(".exe") && Path::new(resolved).is_file()
        }),
        _ => None,
    }
}

/// One resolved launch target: a live window to activate, or a catalog /
/// fallback entry that still needs `ShellExecuteW`.
#[derive(Debug)]
enum LaunchTarget {
    Running(WindowRef),
    Catalog(AppCatalogEntry),
}

impl LaunchTarget {
    fn launch_target(&self) -> &str {
        match self {
            LaunchTarget::Running(window) => &window.executable_path,
            LaunchTarget::Catalog(entry) => &entry.launch_target,
        }
    }
}

/// The query normalized as-is, plus its `canonical_app_query` form when that
/// differs (e.g. `记事本` also tries `notepad`) — both are matched against
/// running windows and the catalog so a localized name resolves the same way
/// an English one does.
fn candidate_needles(query: &str) -> Vec<String> {
    let raw = normalize(query);
    let canonical = normalize(&canonical_app_query(query));
    if raw == canonical {
        vec![raw]
    } else {
        vec![raw, canonical]
    }
}

/// The shared resolver behind both `launch_app` and `resolve_launch_target`:
/// exact match against running windows (raw or canonical name/app_id) →
/// exact match against the Start Menu catalog (raw or canonical
/// name/app_id/launch_target) → the App Paths/PATH fallback for plain names.
fn resolve_launch_candidate(query: &str) -> Result<LaunchTarget, HelperError> {
    let needles = candidate_needles(query);
    if needles.iter().all(|needle| needle.is_empty()) {
        return Err(HelperError::not_executed("invalid-params", "application name must not be empty"));
    }

    // Activating an already-running exact match avoids creating duplicate
    // application windows and preserves the target WindowRef.
    let running = list_windows_impl(None)?;
    let mut exact_running: Vec<WindowRef> = running
        .into_iter()
        .filter(|window| {
            let app_name = normalize(&window.app_name);
            let app_id = normalize(&window.app_id);
            needles.iter().any(|needle| &app_name == needle || &app_id == needle)
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
        return Ok(LaunchTarget::Running(exact_running.remove(0)));
    }

    let catalog = list_apps_impl()?;
    let mut matches: Vec<AppCatalogEntry> = catalog
        .into_iter()
        .filter(|entry| {
            let app_name = normalize(&entry.app_name);
            let app_id = normalize(&entry.app_id);
            let launch_target = normalize(&entry.launch_target);
            needles.iter().any(|needle| {
                &app_name == needle || &app_id == needle || &launch_target == needle
            })
        })
        .collect();
    matches.sort_by_key(|entry| (!entry.running, entry.app_id.clone()));
    matches
        .dedup_by(|left, right| normalize(&left.launch_target) == normalize(&right.launch_target));
    if !matches.is_empty() {
        if matches.len() > 1 {
            let choices = matches
                .iter()
                .take(5)
                .map(|entry| entry.app_id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(HelperError::not_executed("app-ambiguous", format!("application '{query}' is ambiguous: {choices}")));
        }
        return Ok(LaunchTarget::Catalog(matches.remove(0)));
    }

    if let Some(entry) = resolve_fallback_executable(query) {
        return Ok(LaunchTarget::Catalog(entry));
    }

    Err(HelperError::not_executed("app-not-found", format!(
        "application '{query}' was not found in running windows or Start Menu"
    )))
}

/// Compares the resolver's chosen launch target against what the caller (the
/// Host) expected before dispatching anything — closes the gap between the
/// Host classifying one target and the helper launching another.
/// Case-insensitive, so a case-only difference (e.g. drive-letter casing)
/// still passes.
pub(crate) fn launch_target_changed(expected: &str, actual: &str) -> bool {
    !expected.eq_ignore_ascii_case(actual)
}

/// Polls for a window to appear after a successful `ShellExecuteW`. Windows
/// 11 Store apps start a different process than the stub that was launched,
/// so this accepts either: the canonical app name now resolving to a window,
/// or any visible window whose executable path matches the one resolved for
/// the launch. A window not appearing within the budget is not an error —
/// callers get `None` back, never a `HelperError`.
fn wait_for_launched_window(canonical_name: &str, executable_path: Option<&str>) -> Option<WindowRef> {
    let deadline = Instant::now() + LAUNCH_WINDOW_POLL_TIMEOUT;
    loop {
        if let Ok(window) = resolve_window(canonical_name) {
            return Some(window);
        }
        if let Some(target_path) = executable_path {
            if let Ok(windows) = list_windows_impl(None) {
                if let Some(window) = windows
                    .into_iter()
                    .find(|window| window.executable_path.eq_ignore_ascii_case(target_path))
                {
                    return Some(window);
                }
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(LAUNCH_WINDOW_POLL_INTERVAL);
    }
}

pub fn launch_app_impl(
    query: String,
    expected_launch_target: Option<String>,
) -> Result<LaunchResult, HelperError> {
    let target = resolve_launch_candidate(&query)?;

    if let Some(expected) = expected_launch_target.as_deref() {
        if launch_target_changed(expected, target.launch_target()) {
            return Err(HelperError::not_executed("target-changed", format!(
                "resolved launch target for '{query}' no longer matches the expected target"
            )));
        }
    }

    match target {
        LaunchTarget::Running(window) => {
            let activated = activate_window_impl(window.window_id.clone())?;
            let entry = AppCatalogEntry {
                app_id: activated.app_id.clone(),
                app_name: activated.app_name.clone(),
                launch_target: activated.executable_path.clone(),
                source: "running-window".to_string(),
                running: true,
            };
            Ok(LaunchResult {
                entry,
                window: Some(activated),
            })
        }
        LaunchTarget::Catalog(entry) => {
            shell_execute(&entry.launch_target)?;
            let canonical_name = canonical_app_query(&query);
            let executable_path = executable_path_for_target(&entry.launch_target);
            let window = wait_for_launched_window(&canonical_name, executable_path.as_deref());
            Ok(LaunchResult { entry, window })
        }
    }
}

pub fn resolve_launch_target_impl(query: String) -> Result<LaunchTargetResolution, HelperError> {
    let target = resolve_launch_candidate(&query)?;
    match target {
        LaunchTarget::Running(window) => Ok(LaunchTargetResolution {
            running: true,
            launch_target: window.executable_path.clone(),
            identity: identity(&window),
        }),
        LaunchTarget::Catalog(entry) => {
            let exe = executable_path_for_target(&entry.launch_target).ok_or_else(|| {
                HelperError::not_executed("launch-identity-unavailable", format!(
                    "no executable path could be determined for '{}'",
                    entry.launch_target
                ))
            })?;
            let signature = executable_signature(&exe);
            let app_id = stable_app_id(None, &exe);
            Ok(LaunchTargetResolution {
                running: false,
                launch_target: entry.launch_target,
                identity: AppIdentity {
                    app_name: app_name_from_path(&exe),
                    bundle_id: app_id.clone(),
                    process_id: 0,
                    app_id,
                    executable_path: exe,
                    window_id: String::new(),
                    signature_status: signature.signature_status,
                    signer_subject: signature.signer_subject,
                    package_full_name: None,
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        candidate_needles, fallback_exe_name, launch_target_changed, looks_like_path,
        normalize, resolve_fallback_executable, resolve_launch_candidate, shortcut_name,
        stable_path_id,
    };
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

    #[test]
    fn candidate_needles_include_the_canonical_form_alongside_the_raw_query() {
        assert_eq!(candidate_needles("记事本"), vec!["记事本", "notepad"]);
        assert_eq!(candidate_needles("Notepad"), vec!["notepad"]);
    }

    #[test]
    fn fallback_exe_name_maps_canonical_names_to_real_executable_stems() {
        assert_eq!(fallback_exe_name("计算器"), "calc.exe");
        assert_eq!(fallback_exe_name("WINWORD.EXE"), "winword.exe");
    }

    #[test]
    fn fallback_refuses_query_text_that_looks_like_a_path() {
        assert!(looks_like_path(r"c:\windows\notepad.exe"));
        assert!(looks_like_path("shortcut:c:\\menu\\notepad.lnk"));
        assert!(looks_like_path("some/relative/path"));
        assert!(looks_like_path("../escape"));
        assert!(!looks_like_path("notepad"));

        assert!(resolve_fallback_executable(r"c:\windows\notepad.exe").is_none());
        assert!(resolve_fallback_executable("shortcut:c:\\menu\\notepad.lnk").is_none());
        assert!(resolve_fallback_executable("../escape").is_none());
    }

    #[test]
    fn fallback_resolves_notepad_to_a_real_notepad_exe_not_the_extensionless_git_shim() {
        let resolved =
            resolve_fallback_executable("notepad").expect("notepad.exe should resolve via App Paths or PATH");
        let lower_target = resolved.launch_target.to_ascii_lowercase();
        assert!(
            lower_target.ends_with(r"\notepad.exe"),
            "unexpected launch target: {lower_target}"
        );
        assert!(
            !lower_target.contains(r"\git\"),
            "resolved the extensionless Git shim instead of a real notepad.exe: {lower_target}"
        );
        assert!(!resolved.running);
        assert!(matches!(resolved.source.as_str(), "app-paths" | "search-path"));
    }

    #[test]
    fn resolve_launch_candidate_reports_app_not_found_for_a_nonexistent_query() {
        let error = resolve_launch_candidate("definitely-not-a-real-app-xyz123")
            .expect_err("a nonsense app name must not resolve to anything");
        assert_eq!(error.code, "app-not-found");
    }

    #[test]
    fn launch_target_changed_ignores_case_but_not_real_differences() {
        assert!(!launch_target_changed(
            r"C:\Windows\notepad.exe",
            r"c:\windows\NOTEPAD.EXE"
        ));
        assert!(launch_target_changed(
            r"C:\Windows\notepad.exe",
            r"C:\Windows\System32\notepad.exe"
        ));
    }
}
