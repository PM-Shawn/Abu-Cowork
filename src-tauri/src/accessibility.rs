//! Accessibility (AXUIElement) perception + execution layer.
//!
//! Phase 3 / Step 1+2 of the Computer Use overhaul.
//!
//! Step 1 (shipped): `get_ui_snapshot` — read-only AX tree snapshot.
//! Step 2 (this file): `ax_snapshot` — snapshot + session cache of live element refs
//!                     `ax_press`    — AXPress on a cached element (no cursor movement)
//!                     `ax_set_value`— AXSetValue on a cached element (no key synthesis)
//!                     `ax_close_session` — release retained element refs
//!
//! All execution actions drive controls directly via AXUIElement APIs — they do NOT
//! move the system cursor and do NOT steal keyboard focus, making the experience
//! "丝滑" (smooth/non-interrupting). Pixel+enigo is the fallback for canvas-only apps.

use serde::Serialize;

/// Quality report returned by `test_ax_snapshot`.
#[derive(Serialize)]
pub struct AxQualityReport {
    /// App title actually captured (may differ from requested if focus slipped).
    pub app: Option<String>,
    /// Interactable elements found.
    pub element_count: usize,
    /// Total AX nodes visited.
    pub total_visited: usize,
    /// Whether the traversal hit a budget cap.
    pub truncated: bool,
    /// Fraction of elements with a non-empty label (0.0 – 1.0).
    pub label_coverage: f64,
    /// Fraction of elements that expose ≥1 action (0.0 – 1.0).
    pub action_coverage: f64,
    /// Count of each AX role in the snapshot.
    pub role_histogram: Vec<(String, usize)>,
    /// First 20 elements, pre-formatted as human-readable strings.
    pub sample: Vec<String>,
    /// Overall verdict: "excellent" / "good" / "partial" / "poor".
    pub verdict: String,
}

/// One interactable UI element discovered in the accessibility tree.
#[derive(Serialize, Clone)]
pub struct UiElement {
    /// Sequential id within this snapshot (the Set-of-Mark "label").
    pub id: u32,
    /// AX role, e.g. "AXButton", "AXTextField", "AXMenuItem".
    pub role: String,
    /// Best human-readable label: AXTitle, else AXDescription.
    pub label: Option<String>,
    /// Current value when it is a string (AXValue).
    pub value: Option<String>,
    /// Global screen bounds in points: [x, y, width, height] (top-left origin).
    pub bounds: [f64; 4],
    /// Actions the element advertises, e.g. ["AXPress"].
    pub actions: Vec<String>,
    /// Depth in the tree (root app = 0).
    pub depth: u32,
}

/// Result of a snapshot: which app, how much was visited, and the elements.
#[derive(Serialize)]
pub struct UiSnapshot {
    /// Focused application title, if available.
    pub app: Option<String>,
    /// Total AX elements visited during traversal (incl. non-interactable).
    pub total_visited: usize,
    /// Whether traversal hit a cap (depth/element budget) — tree may be truncated.
    pub truncated: bool,
    /// The interactable elements that were collected.
    pub elements: Vec<UiElement>,
}

/// Returned by `ax_snapshot`: snapshot data + an opaque session ID for action commands.
///
/// The session keeps live AX element references (CFRetain'd) so that `ax_press` /
/// `ax_set_value` can act on elements by their sequential id without needing to
/// re-walk the tree. Always close the session with `ax_close_session` when done.
#[derive(Serialize)]
pub struct AxSnapshotResult {
    /// Opaque token — pass back to `ax_press` / `ax_set_value` / `ax_close_session`.
    pub session_id: String,
    /// Focused application title, if available.
    pub app: Option<String>,
    /// Total AX elements visited (incl. non-interactable).
    pub total_visited: usize,
    /// Whether traversal hit a budget cap — tree may be truncated.
    pub truncated: bool,
    /// Interactable elements (index == UiElement.id == element_id for action commands).
    pub elements: Vec<UiElement>,
}

/// Capture a read-only snapshot of the currently focused application's UI tree.
///
/// macOS only. Requires Accessibility permission (the same TCC grant used by the
/// existing Computer Use mouse/keyboard path).
#[tauri::command]
pub fn get_ui_snapshot(app_name: Option<String>) -> Result<UiSnapshot, String> {
    #[cfg(target_os = "macos")]
    {
        macos::get_ui_snapshot_impl(app_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("get_ui_snapshot is only supported on macOS".to_string())
    }
}

/// Open `app_name` (e.g. "Notes", "Finder", "Safari"), wait for it to become
/// focused, then capture an AX snapshot and return a quality report.
///
/// Intended for developer verification — call once from devtools console:
///   `window.__TAURI__.core.invoke('test_ax_snapshot', { appName: 'Notes' })`
///
/// macOS only.
#[tauri::command]
pub async fn test_ax_snapshot(app_name: String) -> Result<AxQualityReport, String> {
    #[cfg(target_os = "macos")]
    {
        macos::test_ax_snapshot_impl(app_name).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("test_ax_snapshot is only supported on macOS".to_string())
    }
}

/// Snapshot the focused app's AX tree AND cache live element references for actions.
///
/// Returns an `AxSnapshotResult` whose `session_id` can be passed to `ax_press`,
/// `ax_set_value`, and `ax_close_session`. The session holds CFRetain'd element
/// refs — call `ax_close_session` when the agent turn is complete to free memory.
#[tauri::command]
pub fn ax_snapshot(app_name: Option<String>) -> Result<AxSnapshotResult, String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_snapshot_impl(app_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app_name;
        Err("ax_snapshot is only supported on macOS".to_string())
    }
}

/// Press (click) a UI element by its session + element id.
///
/// Calls `AXUIElementPerformAction(kAXPressAction)` — does NOT move the system
/// cursor, does NOT steal keyboard focus. Works on buttons, menu items, links,
/// checkboxes, radio buttons, disclosure triangles, etc.
#[tauri::command]
pub fn ax_press(session_id: String, element_id: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_press_impl(session_id, element_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, element_id);
        Err("ax_press is only supported on macOS".to_string())
    }
}

/// Set a text value on a UI element by its session + element id.
///
/// Calls `AXUIElementSetAttributeValue(kAXValueAttribute, CFString)` — does NOT
/// synthesise keystrokes, does NOT steal keyboard focus. Works on text fields,
/// text areas, combo boxes, search fields, etc.
///
/// Prefer this over enigo-based typing whenever possible.
#[tauri::command]
pub fn ax_set_value(session_id: String, element_id: u32, text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_set_value_impl(session_id, element_id, text)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, element_id, text);
        Err("ax_set_value is only supported on macOS".to_string())
    }
}

/// Release all CFRetain'd element references held by this session.
///
/// Must be called when the agent turn is done (or on error bailout) to avoid
/// leaking AX element references. Silently succeeds if the session is not found.
#[tauri::command]
pub fn ax_close_session(session_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::ax_close_session_impl(session_id);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = session_id;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{AxQualityReport, UiElement, UiSnapshot};
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::array::{
        CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef,
    };
    use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef};
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
    use std::collections::HashMap;
    use std::os::raw::c_void;

    // Traversal budgets — AX trees can be huge; keep snapshots bounded.
    const MAX_DEPTH: u32 = 40;
    const MAX_ELEMENTS: usize = 500;
    const MAX_VISITED: usize = 8000;

    // AXValueType values (stable across SDK renames). CGPoint=1, CGSize=2.
    const K_AX_VALUE_CGPOINT: u32 = 1;
    const K_AX_VALUE_CGSIZE: u32 = 2;

    // Roles worth surfacing even if they advertise no actions (containers like rows
    // still help the model orient). Anything with actions is always surfaced.
    const INTERESTING_ROLES: &[&str] = &[
        "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
        "AXMenuItem", "AXMenuButton", "AXPopUpButton", "AXLink", "AXTab",
        "AXComboBox", "AXSlider", "AXIncrementor", "AXStepper", "AXDisclosureTriangle",
        "AXSearchField", "AXCell", "AXRow", "AXColumnHeader", "AXSegmentedControl",
        "AXToolbarButton", "AXSwitch",
    ];

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        /// AXIsProcessTrustedWithOptions: when called with AXTrustedCheckOptionPrompt=true,
        /// shows the system dialog that correctly registers the binary in TCC (by bundle ID
        /// or code-signing identity), avoiding the binary-hash mismatch problem that
        /// affects manually-added unsigned debug binaries.
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        /// Create an AX element for a specific process by PID.
        /// Use instead of AXFocusedApplication when you need the visually frontmost
        /// window regardless of which app holds keyboard focus.
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(
            element: CFTypeRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementCopyActionNames(element: CFTypeRef, names: *mut CFArrayRef) -> i32;
        fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
        /// Step 2: perform a named action (e.g. kAXPressAction = "AXPress") on an element.
        fn AXUIElementPerformAction(element: CFTypeRef, action: CFStringRef) -> i32;
        /// Step 2: set an attribute value (e.g. kAXValueAttribute = "AXValue") on an element.
        fn AXUIElementSetAttributeValue(
            element: CFTypeRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> i32;
    }

    // ── Session cache ─────────────────────────────────────────────────────────
    // After `ax_snapshot_impl` walks the tree it CFRetains every interactable
    // element and stores the raw pointers here, keyed by a session UUID-like id.
    // The element's index in `refs` equals its `UiElement.id`, so action commands
    // can look up the live CFTypeRef in O(1) without re-walking the tree.
    //
    // CFTypeRef is *const c_void — not Send by default. We wrap it to assert
    // thread-safety: CF types use atomic retain/release and AX actions are safe
    // from any thread (tested; consistent with Codex SkyComputerUseClient design).

    struct AXElemRef(CFTypeRef);
    unsafe impl Send for AXElemRef {}
    unsafe impl Sync for AXElemRef {}

    impl Drop for AXElemRef {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    #[allow(dead_code)] // `app` is kept for future logging / TTL display
    struct AXSession {
        refs: Vec<AXElemRef>, // index == UiElement.id
        app: Option<String>,
        created_ms: u128,     // for future TTL/GC
    }

    use std::sync::{Mutex, OnceLock};
    static SESSION_CACHE: OnceLock<Mutex<HashMap<String, AXSession>>> = OnceLock::new();

    fn session_cache() -> &'static Mutex<HashMap<String, AXSession>> {
        SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn new_session_id() -> String {
        // Nanosecond timestamp is unique within a single process lifetime.
        format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )
    }

    /// Map an AX API i32 return code to a human-readable description.
    fn ax_err_str(code: i32) -> &'static str {
        match code {
            0 => "success",
            -25200 => "kAXErrorFailure",
            -25201 => "kAXErrorIllegalArgument",
            -25202 => "kAXErrorInvalidUIElement",
            -25204 => "kAXErrorCannotComplete",
            -25205 => "kAXErrorAttributeUnsupported",
            -25206 => "kAXErrorActionUnsupported",
            -25211 => "kAXErrorAPIDisabled",
            -25212 => "kAXErrorNoValue",
            _ => "unknown AXError",
        }
    }

    /// Check accessibility trust, prompting the user via the system dialog if not yet granted.
    ///
    /// `AXIsProcessTrustedWithOptions` with `AXTrustedCheckOptionPrompt=true` is the
    /// Apple-recommended API (10.9+). When not yet trusted it opens System Settings
    /// directly to the Accessibility pane and registers the correct TCC entry — avoiding
    /// the binary-content-hash mismatch that happens when manually adding an unsigned
    /// debug binary that was later rebuilt by cargo.
    ///
    /// Returns `true` if already trusted (caller may proceed). Returns `false` if not
    /// yet trusted (System Settings was opened; the user must grant and **restart** the app).
    unsafe fn ax_is_trusted_with_prompt() -> bool {
        let pairs = [(
            CFString::new("AXTrustedCheckOptionPrompt"),
            CFBoolean::true_value(),
        )];
        let options: CFDictionary<CFString, CFBoolean> = CFDictionary::from_CFType_pairs(&pairs);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }

    /// Copy an AX attribute as an owned CFTypeRef (Create rule — caller releases).
    unsafe fn copy_attr(el: CFTypeRef, name: &str) -> Option<CFTypeRef> {
        let attr = CFString::new(name);
        let mut out: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut out);
        if err == 0 && !out.is_null() {
            Some(out)
        } else {
            None
        }
    }

    /// Read a string-valued attribute (None if missing or not a CFString).
    unsafe fn attr_string(el: CFTypeRef, name: &str) -> Option<String> {
        let v = copy_attr(el, name)?;
        if CFGetTypeID(v) == CFStringGetTypeID() {
            // wrap_under_create_rule takes ownership and releases on drop.
            let s = CFString::wrap_under_create_rule(v as CFStringRef).to_string();
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        } else {
            CFRelease(v);
            None
        }
    }

    /// Read a CGPoint/CGSize-style AXValue attribute as (a, b).
    unsafe fn attr_pair(el: CFTypeRef, name: &str, ty: u32) -> Option<(f64, f64)> {
        let v = copy_attr(el, name)?;
        let mut buf = [0f64; 2]; // CGPoint{x,y} and CGSize{w,h} are both 2 x f64
        let ok = AXValueGetValue(v, ty, buf.as_mut_ptr() as *mut c_void);
        CFRelease(v);
        if ok != 0 {
            Some((buf[0], buf[1]))
        } else {
            None
        }
    }

    /// Action names the element advertises (e.g. "AXPress").
    unsafe fn action_names(el: CFTypeRef) -> Vec<String> {
        let mut out = Vec::new();
        let mut arr: CFArrayRef = std::ptr::null();
        let err = AXUIElementCopyActionNames(el, &mut arr);
        if err == 0 && !arr.is_null() {
            let n = CFArrayGetCount(arr);
            for i in 0..n {
                let s = CFArrayGetValueAtIndex(arr, i) as CFStringRef; // Get rule
                if !s.is_null() {
                    out.push(CFString::wrap_under_get_rule(s).to_string());
                }
            }
            CFRelease(arr as CFTypeRef);
        }
        out
    }

    /// Children elements (each CFRetain'd — caller must CFRelease every entry).
    unsafe fn children(el: CFTypeRef) -> Vec<CFTypeRef> {
        let mut out = Vec::new();
        if let Some(v) = copy_attr(el, "AXChildren") {
            if CFGetTypeID(v) == CFArrayGetTypeID() {
                let arr = v as CFArrayRef;
                let n = CFArrayGetCount(arr);
                for i in 0..n {
                    let child = CFArrayGetValueAtIndex(arr, i); // owned by array (Get rule)
                    if !child.is_null() {
                        CFRetain(child); // keep alive past array release
                        out.push(child);
                    }
                }
            }
            CFRelease(v); // release the array (Create rule)
        }
        out
    }

    struct WalkState {
        elements: Vec<UiElement>,
        visited: usize,
        truncated: bool,
    }

    unsafe fn walk(el: CFTypeRef, depth: u32, st: &mut WalkState) {
        if depth > MAX_DEPTH || st.elements.len() >= MAX_ELEMENTS || st.visited >= MAX_VISITED {
            st.truncated = true;
            return;
        }
        st.visited += 1;

        let role = attr_string(el, "AXRole").unwrap_or_default();
        let label = attr_string(el, "AXTitle").or_else(|| attr_string(el, "AXDescription"));
        let value = attr_string(el, "AXValue");
        let actions = action_names(el);
        let pos = attr_pair(el, "AXPosition", K_AX_VALUE_CGPOINT);
        let size = attr_pair(el, "AXSize", K_AX_VALUE_CGSIZE);

        let interesting = !actions.is_empty() || INTERESTING_ROLES.contains(&role.as_str());
        if interesting {
            if let (Some((x, y)), Some((w, h))) = (pos, size) {
                // Skip zero-area / offscreen-ish elements.
                if w > 0.0 && h > 0.0 {
                    let id = st.elements.len() as u32;
                    st.elements.push(UiElement {
                        id,
                        role: role.clone(),
                        label,
                        value,
                        bounds: [x, y, w, h],
                        actions,
                        depth,
                    });
                }
            }
        }

        let kids = children(el);
        for k in kids {
            walk(k, depth + 1, st);
            CFRelease(k); // release the retain from children()
        }
    }

    /// Like `WalkState` but also CFRetains each interactable element for the session cache.
    struct WalkStateWithCache {
        elements: Vec<UiElement>,
        refs: Vec<AXElemRef>, // parallel — index == UiElement.id
        visited: usize,
        truncated: bool,
    }

    unsafe fn walk_and_cache(el: CFTypeRef, depth: u32, st: &mut WalkStateWithCache) {
        if depth > MAX_DEPTH || st.elements.len() >= MAX_ELEMENTS || st.visited >= MAX_VISITED {
            st.truncated = true;
            return;
        }
        st.visited += 1;

        let role = attr_string(el, "AXRole").unwrap_or_default();
        let label = attr_string(el, "AXTitle").or_else(|| attr_string(el, "AXDescription"));
        let value = attr_string(el, "AXValue");
        let actions = action_names(el);
        let pos = attr_pair(el, "AXPosition", K_AX_VALUE_CGPOINT);
        let size = attr_pair(el, "AXSize", K_AX_VALUE_CGSIZE);

        let interesting = !actions.is_empty() || INTERESTING_ROLES.contains(&role.as_str());
        if interesting {
            if let (Some((x, y)), Some((w, h))) = (pos, size) {
                if w > 0.0 && h > 0.0 {
                    // Extra CFRetain — this reference will be owned by the session cache.
                    CFRetain(el);
                    let id = st.elements.len() as u32;
                    st.refs.push(AXElemRef(el));
                    st.elements.push(UiElement {
                        id,
                        role: role.clone(),
                        label,
                        value,
                        bounds: [x, y, w, h],
                        actions,
                        depth,
                    });
                }
            }
        }

        let kids = children(el);
        for k in kids {
            walk_and_cache(k, depth + 1, st);
            CFRelease(k);
        }
    }

    /// Get an AX element for a named application process (by partial, case-insensitive name).
    ///
    /// The app does NOT need to be in the foreground — AX APIs work on any running process.
    /// This is the primary path when the model specifies `app_name` in a `get_ui` call,
    /// which lets the user continue using their computer while Abu controls a background app.
    fn get_app_element_by_name(name: &str) -> Result<(CFTypeRef, Option<String>), String> {
        // AppleScript: find the first application process whose name contains `name`.
        // `unix id` returns the POSIX PID; we then create an AX element for that PID.
        let script = format!(
            r#"tell application "System Events"
    set appProcs to every application process whose name contains "{name}"
    if (count of appProcs) is 0 then
        error "No running application found matching: {name}"
    end if
    set foundApp to item 1 of appProcs
    return (unix id of foundApp) as text
end tell"#,
            name = name.replace('"', "")  // sanitise — no escaping in AppleScript strings
        );

        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("osascript failed to launch: {}", e))?;

        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();

        if output.status.success() && !pid_str.is_empty() {
            if let Ok(pid) = pid_str.parse::<i32>() {
                unsafe {
                    let app = AXUIElementCreateApplication(pid);
                    if !app.is_null() {
                        let app_name = attr_string(app, "AXTitle");
                        return Ok((app, app_name));
                    }
                }
            }
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "App '{}' not found or not running. stderr: {:?}",
            name, stderr
        ))
    }

    /// Get an AX element for the visually frontmost application.
    ///
    /// Uses `AXUIElementCreateApplication(pid)` with the PID of the frontmost process,
    /// obtained via AppleScript (same "application process whose frontmost is true"
    /// pattern used by window_info::get_active_window).
    ///
    /// Falls back to `AXFocusedApplication` if the AppleScript path fails (e.g. when
    /// Automation → System Events permission has not been granted yet).
    ///
    /// Returns the element (caller must CFRelease) and the app name, or an error string.
    fn get_frontmost_app_element() -> Result<(CFTypeRef, Option<String>), String> {
        // Multi-line AppleScript matching the pattern in window_info::get_active_window.
        // One-liner form ("tell … to …") can return empty on some macOS versions / permission
        // states; block form is more robust.
        let script = r#"tell application "System Events"
    set frontApp to first application process whose frontmost is true
    return (unix id of frontApp) as text
end tell"#;

        let output = std::process::Command::new("osascript")
            .args(["-e", script])
            .output()
            .map_err(|e| format!("osascript failed to launch: {}", e))?;

        let pid_str = String::from_utf8_lossy(&output.stdout).trim().to_string();

        // If AppleScript succeeded and returned a PID, use it.
        if output.status.success() && !pid_str.is_empty() {
            if let Ok(pid) = pid_str.parse::<i32>() {
                unsafe {
                    let app = AXUIElementCreateApplication(pid);
                    if !app.is_null() {
                        let app_name = attr_string(app, "AXTitle");
                        return Ok((app, app_name));
                    }
                }
            }
        }

        // Fallback: AXFocusedApplication (tracks keyboard focus — less ideal but works
        // when System Events Automation permission is absent or when the AppleScript
        // returns something unexpected).
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        unsafe {
            let sys = AXUIElementCreateSystemWide();
            if sys.is_null() {
                return Err(format!(
                    "osascript returned {:?} (stderr: {:?}); AXUIElementCreateSystemWide also null",
                    pid_str, stderr
                ));
            }
            match copy_attr(sys, "AXFocusedApplication") {
                Some(app) => {
                    CFRelease(sys);
                    let app_name = attr_string(app, "AXTitle");
                    Ok((app, app_name))
                }
                None => {
                    CFRelease(sys);
                    Err(format!(
                        "osascript returned {:?} (stderr: {:?}); AXFocusedApplication also null — \
                         no app appears to be in focus. Click the target app window and try again.",
                        pid_str, stderr
                    ))
                }
            }
        }
    }

    /// `target_app`: optional app name to target (e.g. "Notes"). When provided, the app does
    /// NOT need to be in the foreground — AX works on any running process.
    /// When None, falls back to the visually frontmost app.
    pub fn get_ui_snapshot_impl(target_app: Option<String>) -> Result<UiSnapshot, String> {
        unsafe {
            // Use AXIsProcessTrustedWithOptions(prompt=true) — the Apple-recommended
            // API that opens System Settings and writes the correct TCC entry.
            // Avoids the manual-add hash-mismatch problem with unsigned dev binaries.
            if !ax_is_trusted_with_prompt() {
                return Err(
                    "需要辅助功能权限 — 系统设置已自动打开。\n\
                     请在辅助功能列表中开启当前应用的开关，然后重启应用（Ctrl+C → 重新运行）。\n\n\
                     Accessibility permission required — System Settings opened.\n\
                     Enable the toggle for this app, then restart (Ctrl+C → re-run)."
                        .to_string(),
                );
            }

            let (app, app_name) = if let Some(ref name) = target_app {
                get_app_element_by_name(name).map_err(|e| {
                    format!("get_ui 不可用：{}。请确认应用名称正确且已在运行。", e)
                })?
            } else {
                get_frontmost_app_element().map_err(|e| {
                    format!(
                        "get_ui 不可用：{}。\
                         提示：可以在 get_ui 调用中加 app_name 参数（如 app_name: \"Notes\"）\
                         直接指定目标应用，无需切换前台。",
                        e
                    )
                })?
            };

            let mut st = WalkState {
                elements: Vec::new(),
                visited: 0,
                truncated: false,
            };
            walk(app, 0, &mut st);

            CFRelease(app);

            Ok(UiSnapshot {
                app: app_name,
                total_visited: st.visited,
                truncated: st.truncated,
                elements: st.elements,
            })
        }
    }

    /// Launch `app_name`, wait for it to gain focus, snapshot its AX tree, and
    /// return a quality report. Uses tokio::time so it must be called from an
    /// async context (Tauri command executor).
    pub async fn test_ax_snapshot_impl(app_name: String) -> Result<AxQualityReport, String> {
        // 1. Launch / bring to front via `open -a <name>`.
        let status = std::process::Command::new("open")
            .arg("-a")
            .arg(&app_name)
            .status()
            .map_err(|e| format!("open -a {} failed: {}", app_name, e))?;

        if !status.success() {
            return Err(format!(
                "`open -a {}` returned non-zero exit: {:?}. App may not be installed.",
                app_name, status.code()
            ));
        }

        // 2. Wait for the app to gain keyboard focus. Poll up to 4 s in 200 ms
        //    steps; fall back to flat sleep if polling sees nothing useful.
        let app_lower = app_name.to_lowercase();
        for _ in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // Quick read of focused app title — all CF ops must be on the same
            // thread; tokio may re-use threads so this is safe.
            let title: Option<String> = unsafe {
                let sys = AXUIElementCreateSystemWide();
                if sys.is_null() {
                    None
                } else {
                    let t = copy_attr(sys, "AXFocusedApplication")
                        .and_then(|a| {
                            let s = attr_string(a, "AXTitle");
                            CFRelease(a);
                            s
                        });
                    CFRelease(sys);
                    t
                }
            };
            if let Some(t) = title {
                // Case-insensitive substring match, e.g. "Notes" ↔ "Notes".
                if t.to_lowercase().contains(&app_lower)
                    || app_lower.contains(&t.to_lowercase())
                {
                    break;
                }
            }
        }

        // 3. One more short pause to let the UI settle (window draw, first layout).
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;

        // 4. Capture the snapshot — app is already frontmost after the open+wait above.
        let snap = get_ui_snapshot_impl(Some(app_name.clone()))?;

        // 5. Compute quality metrics.
        let n = snap.elements.len();

        let labeled = snap.elements.iter().filter(|e| e.label.is_some()).count();
        let actioned = snap.elements.iter().filter(|e| !e.actions.is_empty()).count();

        let label_coverage = if n == 0 { 0.0 } else { labeled as f64 / n as f64 };
        let action_coverage = if n == 0 { 0.0 } else { actioned as f64 / n as f64 };

        // Role histogram, sorted by count desc.
        let mut hist: HashMap<String, usize> = HashMap::new();
        for el in &snap.elements {
            *hist.entry(el.role.clone()).or_insert(0) += 1;
        }
        let mut role_histogram: Vec<(String, usize)> = hist.into_iter().collect();
        role_histogram.sort_by(|a, b| b.1.cmp(&a.1));

        // Sample: first 20 elements as readable strings.
        let sample: Vec<String> = snap
            .elements
            .iter()
            .take(20)
            .map(|e| {
                let lbl = e.label.as_deref().unwrap_or("—");
                let val = e.value.as_deref().unwrap_or("");
                let acts = e.actions.join(", ");
                let b = &e.bounds;
                format!(
                    "[{:>3}] {:25} label={:<30} val={:<20} actions=[{}]  bounds=({:.0},{:.0} {:.0}×{:.0})",
                    e.id, e.role, lbl, val, acts, b[0], b[1], b[2], b[3]
                )
            })
            .collect();

        // Verdict heuristic.
        let verdict = if n >= 20 && label_coverage >= 0.6 && action_coverage >= 0.4 {
            "excellent"
        } else if n >= 10 && label_coverage >= 0.4 {
            "good"
        } else if n >= 5 {
            "partial"
        } else {
            "poor"
        }
        .to_string();

        Ok(AxQualityReport {
            app: snap.app,
            element_count: n,
            total_visited: snap.total_visited,
            truncated: snap.truncated,
            label_coverage,
            action_coverage,
            role_histogram,
            sample,
            verdict,
        })
    }

    // ── Step 2 implementations ────────────────────────────────────────────────

    /// Snapshot the target app and cache live element refs for action commands.
    /// `target_app`: optional app name. When provided the app need not be in the foreground.
    pub fn ax_snapshot_impl(target_app: Option<String>) -> Result<super::AxSnapshotResult, String> {
        unsafe {
            if !ax_is_trusted_with_prompt() {
                return Err(
                    "需要辅助功能权限 — 系统设置已自动打开。\n\
                     请在辅助功能列表中开启当前应用的开关，然后重启应用（Ctrl+C → 重新运行）。\n\n\
                     Accessibility permission required — System Settings opened.\n\
                     Enable the toggle for this app, then restart (Ctrl+C → re-run)."
                        .to_string(),
                );
            }

            let (app, app_name) = if let Some(ref name) = target_app {
                get_app_element_by_name(name).map_err(|e| {
                    format!("get_ui 不可用：{}。请确认应用名称正确且已在运行。", e)
                })?
            } else {
                get_frontmost_app_element().map_err(|e| {
                    format!(
                        "get_ui 不可用：{}。\
                         提示：可以在 get_ui 调用中加 app_name 参数（如 app_name: \"Notes\"）\
                         直接指定目标应用，无需切换前台。",
                        e
                    )
                })?
            };

            let mut st = WalkStateWithCache {
                elements: Vec::new(),
                refs: Vec::new(),
                visited: 0,
                truncated: false,
            };
            walk_and_cache(app, 0, &mut st);

            CFRelease(app);

            // Store in the global session cache.
            let session_id = new_session_id();
            {
                let mut cache = session_cache().lock().unwrap();
                // Prune sessions older than 10 minutes to prevent unbounded growth.
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                cache.retain(|_, v| now_ms.saturating_sub(v.created_ms) < 600_000);
                cache.insert(
                    session_id.clone(),
                    AXSession {
                        refs: st.refs,
                        app: app_name.clone(),
                        created_ms: now_ms,
                    },
                );
            }

            Ok(super::AxSnapshotResult {
                session_id,
                app: app_name,
                total_visited: st.visited,
                truncated: st.truncated,
                elements: st.elements,
            })
        }
    }

    /// Perform AXPress on the cached element. Returns Ok(()) on success.
    pub fn ax_press_impl(session_id: String, element_id: u32) -> Result<(), String> {
        let cache = session_cache().lock().unwrap();
        let session = cache
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found — call ax_snapshot first.", session_id))?;
        let el_ref = session
            .refs
            .get(element_id as usize)
            .ok_or_else(|| format!("element_id {} out of range (session has {} elements).", element_id, session.refs.len()))?;

        unsafe {
            let action = CFString::new("AXPress");
            let err = AXUIElementPerformAction(el_ref.0, action.as_concrete_TypeRef());
            if err != 0 {
                return Err(format!(
                    "AXPress on element {} failed: {} ({})",
                    element_id, err, ax_err_str(err)
                ));
            }
        }
        Ok(())
    }

    /// Set AXValue (text) on the cached element. Returns Ok(()) on success.
    pub fn ax_set_value_impl(session_id: String, element_id: u32, text: String) -> Result<(), String> {
        let cache = session_cache().lock().unwrap();
        let session = cache
            .get(&session_id)
            .ok_or_else(|| format!("Session '{}' not found — call ax_snapshot first.", session_id))?;
        let el_ref = session
            .refs
            .get(element_id as usize)
            .ok_or_else(|| format!("element_id {} out of range (session has {} elements).", element_id, session.refs.len()))?;

        unsafe {
            let attr = CFString::new("AXValue");
            let val = CFString::new(&text);
            let err = AXUIElementSetAttributeValue(
                el_ref.0,
                attr.as_concrete_TypeRef(),
                val.as_concrete_TypeRef() as CFTypeRef,
            );
            if err != 0 {
                return Err(format!(
                    "AXSetValue on element {} failed: {} ({})",
                    element_id, err, ax_err_str(err)
                ));
            }
        }
        Ok(())
    }

    /// Release the session and CFRelease all retained element refs.
    pub fn ax_close_session_impl(session_id: String) {
        let mut cache = session_cache().lock().unwrap();
        cache.remove(&session_id);
        // AXElemRef::drop() calls CFRelease for each element ref automatically.
    }
}
