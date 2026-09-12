use crate::error::HelperError;
use serde::Serialize;
use std::cmp::Reverse;
use std::ffi::c_void;
use std::path::Path;
use std::thread;
use std::time::Duration;

use ::windows::core::PWSTR;
use ::windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
use ::windows::Win32::Storage::Packaging::Appx::{GetApplicationUserModelId, GetPackageFullName};
use ::windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
use ::windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumChildWindows, EnumWindows, GetForegroundWindow, GetWindow, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsChild, IsIconic, IsWindowVisible,
    SetForegroundWindow, ShowWindowAsync, SwitchToThisWindow, GW_HWNDPREV, GW_OWNER, SW_RESTORE,
};

use super::signature::executable_signature;

#[derive(Clone, Debug, Serialize)]
pub struct AppIdentity {
    pub app_name: String,
    pub bundle_id: String,
    pub process_id: i32,
    pub app_id: String,
    pub executable_path: String,
    pub window_id: String,
    pub signature_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signer_subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_full_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WindowRef {
    pub app_id: String,
    pub app_name: String,
    pub window_id: String,
    pub process_id: u32,
    pub title: String,
    pub bounds: [i32; 4],
    pub executable_path: String,
    pub minimized: bool,
    pub signature_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signer_subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_full_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct WindowTargetMatch {
    pub matches: bool,
    pub actual_window_id: String,
    pub relation: String,
    pub expected_bounds: [i32; 4],
    pub actual_bounds: [i32; 4],
}

#[derive(Clone, Debug, Serialize)]
pub struct WindowGraphNode {
    pub window_id: String,
    pub owner_window_id: Option<String>,
    pub app_id: String,
    pub app_name: String,
    pub process_id: u32,
    pub title: String,
    pub bounds: [i32; 4],
    pub minimized: bool,
    pub z_index: usize,
    pub relation: String,
    pub foreground: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WindowGraph {
    pub target_window_id: String,
    pub foreground_window_id: Option<String>,
    pub nodes: Vec<WindowGraphNode>,
}

pub(crate) fn hwnd_id(hwnd: HWND) -> String {
    format!("0x{:X}", hwnd.0 as usize)
}

pub(crate) fn parse_hwnd(value: &str) -> Result<HWND, HelperError> {
    let raw = value.trim().strip_prefix("0x").unwrap_or(value.trim());
    let address =
        usize::from_str_radix(raw, 16).map_err(|_| HelperError::not_executed("invalid-params", format!("invalid window_id '{value}'")))?;
    if address == 0 {
        return Err(HelperError::not_executed("invalid-params", "window_id must not be null"));
    }
    Ok(HWND(address as *mut c_void))
}

fn window_title(hwnd: HWND) -> String {
    let mut buffer = vec![0u16; 1024];
    let length = unsafe { GetWindowTextW(hwnd, &mut buffer) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
        .trim()
        .to_string()
}

fn process_path(process_id: u32) -> Result<String, HelperError> {
    let process = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|error| HelperError::preflight(format!("OpenProcess({process_id}) failed: {error}")))?
    };
    let result = (|| {
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .map_err(|error| HelperError::preflight(format!("QueryFullProcessImageNameW({process_id}) failed: {error}")))?;
        }
        Ok(String::from_utf16_lossy(&buffer[..length as usize]))
    })();
    let _ = unsafe { CloseHandle(process) };
    result
}

fn process_app_user_model_id(process_id: u32) -> Option<String> {
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let result = (|| {
        let mut length = 0u32;
        let _ = unsafe { GetApplicationUserModelId(process, &mut length, PWSTR::null()) };
        if length <= 1 || length > 32_768 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize];
        let status =
            unsafe { GetApplicationUserModelId(process, &mut length, PWSTR(buffer.as_mut_ptr())) };
        if status.0 != 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        let value = String::from_utf16_lossy(&buffer[..end]).trim().to_string();
        (!value.is_empty()).then_some(value)
    })();
    let _ = unsafe { CloseHandle(process) };
    result
}

fn process_package_full_name(process_id: u32) -> Option<String> {
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let result = (|| {
        let mut length = 0u32;
        let _ = unsafe { GetPackageFullName(process, &mut length, PWSTR::null()) };
        if length <= 1 || length > 32_768 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize];
        let status =
            unsafe { GetPackageFullName(process, &mut length, PWSTR(buffer.as_mut_ptr())) };
        if status.0 != 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        let value = String::from_utf16_lossy(&buffer[..end]).trim().to_string();
        (!value.is_empty()).then_some(value)
    })();
    let _ = unsafe { CloseHandle(process) };
    result
}

unsafe extern "system" fn enum_child_process(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let output = &mut *(lparam.0 as *mut Vec<u32>);
    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    if process_id != 0 && !output.contains(&process_id) {
        output.push(process_id);
    }
    BOOL(1)
}

fn hosted_process(hwnd: HWND, owner_process_id: u32, owner_path: &str) -> Option<(u32, String)> {
    let owner_name = app_name_from_path(owner_path).to_lowercase();
    if owner_name != "applicationframehost" {
        return None;
    }
    let mut process_ids = Vec::new();
    let _ = unsafe {
        EnumChildWindows(
            hwnd,
            Some(enum_child_process),
            LPARAM((&mut process_ids as *mut Vec<u32>) as isize),
        )
    };
    process_ids.into_iter().find_map(|process_id| {
        if process_id == owner_process_id {
            return None;
        }
        let path = process_path(process_id).ok()?;
        let name = app_name_from_path(&path).to_lowercase();
        if matches!(
            name.as_str(),
            "applicationframehost" | "textinputhost" | "shellexperiencehost"
        ) {
            return None;
        }
        Some((process_id, path))
    })
}

fn app_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn stable_app_id(aumid: Option<String>, executable_path: &str) -> String {
    aumid
        .map(|value| format!("aumid:{}", value.to_lowercase()))
        .unwrap_or_else(|| executable_path.to_lowercase())
}

pub(crate) fn inspect_window(hwnd: HWND) -> Result<WindowRef, HelperError> {
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return Err(HelperError::observe_again("window-not-visible", "window is not visible"));
    }
    let title = window_title(hwnd);
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if process_id == 0 {
        return Err(HelperError::preflight("window process identity is unavailable"));
    }
    let owner_path = process_path(process_id)?;
    let (process_id, executable_path) =
        hosted_process(hwnd, process_id, &owner_path).unwrap_or((process_id, owner_path));
    let app_id = stable_app_id(process_app_user_model_id(process_id), &executable_path);
    let package_full_name = process_package_full_name(process_id);
    let mut signature = executable_signature(&executable_path);
    if signature.signature_status != "valid" && package_full_name.is_some() {
        // AppX/MSIX package identity is assigned by Windows after package
        // signature/integrity validation. Many packaged executables do not
        // carry a separately trusted embedded PE signature.
        signature.signature_status = "package-trusted".to_string();
        signature.signer_subject = None;
    }
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }
        .map_err(|error| HelperError::preflight(format!("GetWindowRect failed: {error}")))?;
    let width = rect.right.saturating_sub(rect.left);
    let height = rect.bottom.saturating_sub(rect.top);
    if width <= 0 || height <= 0 {
        return Err(HelperError::observe_again("window-not-visible", "window bounds are empty"));
    }
    Ok(WindowRef {
        app_name: app_name_from_path(&executable_path),
        app_id,
        window_id: hwnd_id(hwnd),
        process_id,
        title,
        bounds: [rect.left, rect.top, width, height],
        executable_path,
        minimized: unsafe { IsIconic(hwnd) }.as_bool(),
        signature_status: signature.signature_status,
        signer_subject: signature.signer_subject,
        package_full_name,
    })
}

unsafe extern "system" fn enum_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let output = &mut *(lparam.0 as *mut Vec<WindowRef>);
    if let Ok(window) = inspect_window(hwnd) {
        output.push(window);
    }
    BOOL(1)
}

unsafe extern "system" fn enum_window_handle(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let output = &mut *(lparam.0 as *mut Vec<HWND>);
    if IsWindowVisible(hwnd).as_bool() {
        output.push(hwnd);
    }
    BOOL(1)
}

pub fn list_windows_impl(expected_app_id: Option<String>) -> Result<Vec<WindowRef>, HelperError> {
    let mut windows = list_windows_z_order()?;
    if let Some(expected) = expected_app_id {
        windows.retain(|window| window.app_id.eq_ignore_ascii_case(expected.trim()));
    }
    windows.sort_by(|left, right| {
        left.app_name
            .to_lowercase()
            .cmp(&right.app_name.to_lowercase())
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
    });
    Ok(windows)
}

/// Returns visible top-level windows in the z-order supplied by EnumWindows:
/// the first entry is the topmost window. Keep this separate from the
/// alphabetically sorted public catalog so screenshots can bind their zIndex
/// to the exact window stack observed around capture time.
pub(crate) fn list_windows_z_order() -> Result<Vec<WindowRef>, HelperError> {
    let mut windows: Vec<WindowRef> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_window),
            LPARAM((&mut windows as *mut Vec<WindowRef>) as isize),
        )
        .map_err(|error| HelperError::preflight(format!("EnumWindows failed: {error}")))?;
    }
    Ok(windows)
}

fn owner_window_id(window_id: &str) -> Option<String> {
    let window = parse_hwnd(window_id).ok()?;
    let owner = unsafe { GetWindow(window, GW_OWNER) }.ok()?;
    (!owner.0.is_null()).then(|| hwnd_id(owner))
}

/// Build a bounded structural graph around one authorized HWND. Enumeration
/// filters by native PID/owner relation before running the more expensive
/// Authenticode-aware WindowRef inspection, so a UIA observation does not scan
/// signatures for every unrelated desktop window.
pub fn get_window_graph_impl(
    expected_app_id: String,
    expected_process_id: u32,
    expected_window_id: String,
) -> Result<WindowGraph, HelperError> {
    let target = get_window_impl(expected_window_id.clone())?;
    if target.process_id != expected_process_id
        || !target.app_id.eq_ignore_ascii_case(expected_app_id.trim())
    {
        return Err(HelperError::observe_again("target-changed", "window graph target identity changed"));
    }
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_window_handle),
            LPARAM((&mut handles as *mut Vec<HWND>) as isize),
        )
        .map_err(|error| HelperError::preflight(format!("EnumWindows failed: {error}")))?;
    }
    let foreground = unsafe { GetForegroundWindow() };
    let foreground_window_id = (!foreground.0.is_null()).then(|| hwnd_id(foreground));
    let mut nodes = Vec::new();
    for (z_index, hwnd) in handles.into_iter().enumerate() {
        if nodes.len() >= 32 {
            break;
        }
        let window_id = hwnd_id(hwnd);
        let mut native_process_id = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut native_process_id)) };
        let exact = window_id.eq_ignore_ascii_case(&expected_window_id);
        let owned_popup = window_is_owned_by(&window_id, &expected_window_id);
        let owner = window_is_owned_by(&expected_window_id, &window_id);
        if !exact && !owned_popup && !owner && native_process_id != expected_process_id {
            continue;
        }
        let Ok(window) = inspect_window(hwnd) else {
            continue;
        };
        let same_process = window.process_id == expected_process_id;
        let same_app = window.app_id.eq_ignore_ascii_case(expected_app_id.trim());
        if !exact && !owned_popup && !owner && !same_process && !same_app {
            continue;
        }
        let relation = if exact {
            "exact"
        } else if owned_popup {
            "owned-popup"
        } else if owner {
            "owner"
        } else if same_process {
            "same-process"
        } else {
            "same-app"
        };
        nodes.push(WindowGraphNode {
            window_id: window.window_id.clone(),
            owner_window_id: owner_window_id(&window.window_id),
            app_id: window.app_id,
            app_name: window.app_name,
            process_id: window.process_id,
            title: window.title,
            bounds: window.bounds,
            minimized: window.minimized,
            z_index,
            relation: relation.to_string(),
            foreground: foreground_window_id
                .as_ref()
                .is_some_and(|id| id.eq_ignore_ascii_case(&window.window_id)),
        });
    }
    if !nodes.iter().any(|node| node.relation == "exact") {
        // Some UWP/ApplicationFrameHost HWNDs remain directly queryable but
        // are omitted from a concurrent EnumWindows pass while their hosted
        // surface is being composed. The exact target above was already
        // revalidated by HWND + hosted PID + stable app_id, so retain it as
        // the graph anchor instead of turning this benign enumeration race
        // into a false target-loss result.
        if nodes.len() >= 32 {
            nodes.pop();
        }
        let target_foreground = foreground_window_id
            .as_ref()
            .is_some_and(|id| id.eq_ignore_ascii_case(&target.window_id));
        nodes.push(WindowGraphNode {
            window_id: target.window_id.clone(),
            owner_window_id: owner_window_id(&target.window_id),
            app_id: target.app_id,
            app_name: target.app_name,
            process_id: target.process_id,
            title: target.title,
            bounds: target.bounds,
            minimized: target.minimized,
            z_index: window_z_index(&target.window_id)
                .ok()
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(usize::MAX),
            relation: "exact".to_string(),
            foreground: target_foreground,
        });
        nodes.sort_by_key(|node| node.z_index);
    }
    Ok(WindowGraph {
        target_window_id: expected_window_id,
        foreground_window_id,
        nodes,
    })
}

pub(crate) fn window_is_owned_by(window_id: &str, target_window_id: &str) -> bool {
    let Ok(mut current) = parse_hwnd(window_id) else {
        return false;
    };
    let Ok(target) = parse_hwnd(target_window_id) else {
        return false;
    };
    // Owner chains are normally one or two entries. Keep the traversal
    // bounded so malformed/native window graphs cannot stall capture.
    for _ in 0..16 {
        let Ok(owner) = (unsafe { GetWindow(current, GW_OWNER) }) else {
            return false;
        };
        current = owner;
        if current == target {
            return true;
        }
    }
    false
}

pub(crate) fn window_has_owner(window_id: &str) -> bool {
    let Ok(window) = parse_hwnd(window_id) else {
        return false;
    };
    unsafe { GetWindow(window, GW_OWNER) }.is_ok_and(|owner| !owner.0.is_null())
}

pub(crate) fn window_ids_related(actual_window_id: &str, expected_window_id: &str) -> bool {
    if actual_window_id.eq_ignore_ascii_case(expected_window_id)
        || window_is_owned_by(actual_window_id, expected_window_id)
        || window_is_owned_by(expected_window_id, actual_window_id)
    {
        return true;
    }
    if window_is_descendant_of(actual_window_id, expected_window_id) {
        return true;
    }
    let Ok(actual) = get_window_impl(actual_window_id.to_string()) else {
        return false;
    };
    let Ok(expected) = get_window_impl(expected_window_id.to_string()) else {
        return false;
    };
    bounds_contain_auxiliary(expected.bounds, actual.bounds)
}

fn window_is_descendant_of(window_id: &str, target_window_id: &str) -> bool {
    let Ok(window) = parse_hwnd(window_id) else {
        return false;
    };
    let Ok(target) = parse_hwnd(target_window_id) else {
        return false;
    };
    unsafe { IsChild(target, window) }.as_bool()
}

fn bounds_contain_auxiliary(container: [i32; 4], candidate: [i32; 4]) -> bool {
    let [container_x, container_y, container_width, container_height] = container;
    let [candidate_x, candidate_y, candidate_width, candidate_height] = candidate;
    if container_width <= 0
        || container_height <= 0
        || candidate_width <= 0
        || candidate_height <= 0
    {
        return false;
    }
    let contained = candidate_x >= container_x
        && candidate_y >= container_y
        && candidate_x.saturating_add(candidate_width)
            <= container_x.saturating_add(container_width)
        && candidate_y.saturating_add(candidate_height)
            <= container_y.saturating_add(container_height);
    let container_area = i64::from(container_width) * i64::from(container_height);
    let candidate_area = i64::from(candidate_width) * i64::from(candidate_height);
    contained && candidate_area.saturating_mul(4) <= container_area
}

pub(crate) fn window_z_index(window_id: &str) -> Result<i32, HelperError> {
    let mut current = parse_hwnd(window_id)?;
    let mut z_index = 0i32;
    // Walk towards the top of the native z-order. Count visible windows only,
    // matching the layers present in the WGC monitor frame.
    for _ in 0..32_768 {
        let Ok(previous) = (unsafe { GetWindow(current, GW_HWNDPREV) }) else {
            return Ok(z_index);
        };
        current = previous;
        if unsafe { IsWindowVisible(current) }.as_bool() {
            z_index = z_index.saturating_add(1);
        }
    }
    Err(HelperError::preflight("window z-order traversal exceeded the safety bound"))
}

pub fn get_window_impl(window_id: String) -> Result<WindowRef, HelperError> {
    inspect_window(parse_hwnd(&window_id)?)
}

fn identity(window: &WindowRef) -> AppIdentity {
    AppIdentity {
        app_name: window.app_name.clone(),
        bundle_id: window.app_id.clone(),
        process_id: window.process_id as i32,
        app_id: window.app_id.clone(),
        executable_path: window.executable_path.clone(),
        window_id: window.window_id.clone(),
        signature_status: window.signature_status.clone(),
        signer_subject: window.signer_subject.clone(),
        package_full_name: window.package_full_name.clone(),
    }
}

pub fn frontmost_app_identity_impl() -> Result<AppIdentity, HelperError> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return Err(HelperError::observe_again("window-not-found", "foreground window is unavailable"));
    }
    Ok(identity(&inspect_window(hwnd)?))
}

pub fn frontmost_matches_target_impl(
    expected_app_id: String,
    expected_process_id: u32,
    expected_window_id: String,
) -> Result<WindowTargetMatch, HelperError> {
    let actual = frontmost_app_identity_impl()?;
    let actual_window = get_window_impl(actual.window_id.clone())?;
    let expected_window = get_window_impl(expected_window_id.clone())?;
    let same_identity = actual.process_id == expected_process_id as i32
        && actual.bundle_id.eq_ignore_ascii_case(&expected_app_id);
    let relation = if actual.window_id.eq_ignore_ascii_case(&expected_window_id) {
        "exact"
    } else if window_is_owned_by(&actual.window_id, &expected_window_id) {
        "frontmost-owned-by-target"
    } else if window_is_owned_by(&expected_window_id, &actual.window_id) {
        "target-owned-by-frontmost"
    } else if window_is_descendant_of(&actual.window_id, &expected_window_id) {
        "frontmost-descendant-of-target"
    } else if bounds_contain_auxiliary(expected_window.bounds, actual_window.bounds) {
        "contained-auxiliary"
    } else {
        "unrelated"
    };
    Ok(WindowTargetMatch {
        matches: same_identity && relation != "unrelated",
        actual_window_id: actual.window_id,
        relation: relation.to_string(),
        expected_bounds: expected_window.bounds,
        actual_bounds: actual_window.bounds,
    })
}

fn normalized_candidates(window: &WindowRef) -> [String; 3] {
    [
        window.app_name.to_lowercase(),
        format!("{}.exe", window.app_name.to_lowercase()),
        window.app_id.to_lowercase(),
    ]
}

fn canonical_app_query(name: &str) -> String {
    let normalized = name.trim().to_lowercase();
    match normalized.as_str() {
        "记事本" | "windows 记事本" | "微软记事本" => "notepad".to_string(),
        "计算器" | "windows 计算器" => "calculator".to_string(),
        "画图" | "windows 画图" => "mspaint".to_string(),
        "资源管理器" | "文件资源管理器" | "windows 资源管理器" => {
            "explorer".to_string()
        }
        _ => normalized,
    }
}

fn select_preferred_window(
    mut windows: Vec<WindowRef>,
    foreground_window_id: Option<&str>,
) -> WindowRef {
    windows.sort_by_key(|window| {
        let area = i64::from(window.bounds[2]).saturating_mul(i64::from(window.bounds[3]));
        let is_not_foreground = foreground_window_id
            .is_none_or(|window_id| !window.window_id.eq_ignore_ascii_case(window_id));
        (is_not_foreground, window.minimized, Reverse(area))
    });
    windows.remove(0)
}

pub(crate) fn resolve_window(name: &str) -> Result<WindowRef, HelperError> {
    let needle = canonical_app_query(name);
    if needle.is_empty() {
        return Err(HelperError::not_executed("invalid-params", "app name must not be empty"));
    }
    let windows = list_windows_impl(None)?;
    let mut exact: Vec<WindowRef> = windows
        .iter()
        .filter(|window| {
            normalized_candidates(window)
                .iter()
                .any(|value| value == &needle)
        })
        .cloned()
        .collect();
    if exact.is_empty() {
        exact = windows
            .into_iter()
            .filter(|window| {
                normalized_candidates(window)
                    .iter()
                    .any(|value| value.contains(&needle))
            })
            .collect();
    }
    if exact.is_empty() {
        return Err(HelperError::not_executed("app-not-found", format!("app '{name}' has no visible window")));
    }
    let first_app_id = exact[0].app_id.clone();
    if exact
        .iter()
        .any(|window| !window.app_id.eq_ignore_ascii_case(&first_app_id))
    {
        return Err(HelperError::not_executed("app-ambiguous", format!("app name '{name}' is ambiguous")));
    }
    let foreground = unsafe { GetForegroundWindow() };
    let foreground_window_id = if foreground.0.is_null() {
        None
    } else {
        Some(hwnd_id(foreground))
    };
    Ok(select_preferred_window(
        exact,
        foreground_window_id.as_deref(),
    ))
}

pub fn resolve_app_identity_impl(name: String) -> Result<AppIdentity, HelperError> {
    Ok(identity(&resolve_window(&name)?))
}

pub fn activate_window_impl(window_id: String) -> Result<WindowRef, HelperError> {
    let hwnd = parse_hwnd(&window_id)?;
    let before = inspect_window(hwnd)?;
    if unsafe { GetForegroundWindow() } == hwnd {
        return Ok(before);
    }
    if before.minimized {
        let _ = unsafe { ShowWindowAsync(hwnd, SW_RESTORE) };
    }
    let foreground = unsafe { GetForegroundWindow() };
    let foreground_thread = if foreground.0.is_null() {
        0
    } else {
        unsafe { GetWindowThreadProcessId(foreground, None) }
    };
    let target_thread = unsafe { GetWindowThreadProcessId(hwnd, None) };
    let current_thread = unsafe { GetCurrentThreadId() };
    let attached_foreground = foreground_thread != 0
        && foreground_thread != current_thread
        && unsafe { AttachThreadInput(current_thread, foreground_thread, true) }.as_bool();
    let attached_target = target_thread != 0
        && target_thread != current_thread
        && target_thread != foreground_thread
        && unsafe { AttachThreadInput(current_thread, target_thread, true) }.as_bool();
    let attached_pair = foreground_thread != 0
        && target_thread != 0
        && foreground_thread != target_thread
        && unsafe { AttachThreadInput(foreground_thread, target_thread, true) }.as_bool();
    let _ = unsafe { BringWindowToTop(hwnd) };
    let _ = unsafe { SetActiveWindow(hwnd) };
    let _ = unsafe { SetFocus(hwnd) };
    let _ = unsafe { SetForegroundWindow(hwnd) };
    thread::sleep(Duration::from_millis(25));
    if unsafe { GetForegroundWindow() } != hwnd {
        // Windows can deny SetForegroundWindow while its foreground-lock
        // timeout is active. SwitchToThisWindow is the OS-provided fallback
        // used only for an explicitly selected, already validated HWND.
        if super::input::permit_foreground_activation().is_ok() {
            let _ = unsafe { BringWindowToTop(hwnd) };
            let _ = unsafe { SetActiveWindow(hwnd) };
            let _ = unsafe { SetFocus(hwnd) };
            let _ = unsafe { SetForegroundWindow(hwnd) };
            unsafe { SwitchToThisWindow(hwnd, true) };
        }
    }
    if attached_pair {
        let _ = unsafe { AttachThreadInput(foreground_thread, target_thread, false) };
    }
    if attached_target {
        let _ = unsafe { AttachThreadInput(current_thread, target_thread, false) };
    }
    if attached_foreground {
        let _ = unsafe { AttachThreadInput(current_thread, foreground_thread, false) };
    }
    thread::sleep(Duration::from_millis(100));
    if unsafe { GetForegroundWindow() } != hwnd {
        return Err(HelperError::observe_again("activation-refused", format!("Windows refused to activate '{}'", before.app_name)));
    }
    let after = inspect_window(hwnd)?;
    if after.process_id != before.process_id || !after.app_id.eq_ignore_ascii_case(&before.app_id) {
        return Err(HelperError::observe_again("target-changed", "window identity changed during activation"));
    }
    Ok(after)
}

#[cfg(test)]
mod tests {
    use super::{
        bounds_contain_auxiliary, canonical_app_query, parse_hwnd, select_preferred_window,
        stable_app_id, WindowRef,
    };

    fn window(window_id: &str, bounds: [i32; 4], minimized: bool) -> WindowRef {
        WindowRef {
            app_id: "c:\\program files\\microsoft office\\winword.exe".to_string(),
            app_name: "WINWORD".to_string(),
            window_id: window_id.to_string(),
            process_id: 42,
            title: String::new(),
            bounds,
            executable_path: "C:\\Program Files\\Microsoft Office\\WINWORD.EXE".to_string(),
            minimized,
            signature_status: "valid".to_string(),
            signer_subject: Some("Microsoft Corporation".to_string()),
            package_full_name: None,
        }
    }

    #[test]
    fn app_resolution_prefers_foreground_then_largest_document_window() {
        let auxiliary = window("0x10", [0, 0, 320, 200], false);
        let document = window("0x20", [0, 0, 1600, 900], false);
        let minimized = window("0x30", [0, 0, 1920, 1080], true);

        let largest = select_preferred_window(
            vec![auxiliary.clone(), minimized.clone(), document.clone()],
            None,
        );
        assert_eq!(largest.window_id, document.window_id);

        let foreground_auxiliary = select_preferred_window(
            vec![document, minimized, auxiliary.clone()],
            Some(&auxiliary.window_id),
        );
        assert_eq!(foreground_auxiliary.window_id, auxiliary.window_id);
    }

    #[test]
    fn window_identity_prefers_canonical_aumid_and_exact_path() {
        assert_eq!(
            stable_app_id(
                Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".to_string()),
                "ignored.exe"
            ),
            "aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app",
        );
        assert_eq!(
            stable_app_id(None, "C:\\Program Files\\Vendor\\App.EXE"),
            "c:\\program files\\vendor\\app.exe",
        );
        assert!(parse_hwnd("0x0").is_err());
        assert!(parse_hwnd("not-a-hwnd").is_err());
    }

    #[test]
    fn localized_windows_app_names_resolve_to_stable_executable_names() {
        assert_eq!(canonical_app_query("记事本"), "notepad");
        assert_eq!(canonical_app_query("文件资源管理器"), "explorer");
        assert_eq!(canonical_app_query("Calculator"), "calculator");
    }

    #[test]
    fn only_small_contained_auxiliary_windows_share_a_document_target() {
        let document = [-8, -8, 2576, 1408];
        assert!(bounds_contain_auxiliary(document, [1145, 13, 314, 23]));
        assert!(!bounds_contain_auxiliary(document, [-8, -8, 2576, 1408]));
        assert!(!bounds_contain_auxiliary(document, [2500, 100, 314, 23]));
    }
}

pub fn activate_app_impl(name: String) -> Result<String, HelperError> {
    let window = resolve_window(&name)?;
    let activated = activate_window_impl(window.window_id)?;
    Ok(activated.app_name)
}
