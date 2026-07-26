//! macOS AXUIElement implementation, extracted from `mod macos` in
//! `accessibility.rs` verbatim (behavior-preserving split — see
//! `docs/...` / P2-1 native-helper AX extraction). Depends only on
//! `super::{AxDiagReport, AxDiagSnapshot, AxQualityReport, AxTextNode,
//! UiElement, UiSnapshot}` (from accessibility_types.rs, included by whichever
//! module hosts this file) + core_foundation/core_foundation_sys/objc2/
//! objc2-app-kit/std — zero Tauri types, so the native-helper crate can
//! `include!` this same file to re-host the AX code without a copy.
//!
//! `accessibility.rs` wires this in via:
//!   #[cfg(target_os = "macos")]
//!   #[path = "accessibility_macos.rs"]
//!   mod macos;
//!
//! electron/native-helper wires this in via (see src/ax.rs):
//!   #[cfg(target_os = "macos")]
//!   mod ax {
//!       include!("../../../src-tauri/src/accessibility_types.rs");
//!       #[path = "../../../src-tauri/src/accessibility_macos.rs"]
//!       mod macos;
//!       pub use macos::*;
//!   }

use super::{AxDiagReport, AxDiagSnapshot, AxQualityReport, AxTextNode, UiElement, UiSnapshot};
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

/// Count entries in an array-valued attribute. -1 = attribute absent, -2 = present but not an array.
unsafe fn attr_array_count(el: CFTypeRef, name: &str) -> i64 {
    match copy_attr(el, name) {
        Some(v) => {
            let count = if CFGetTypeID(v) == CFArrayGetTypeID() {
                CFArrayGetCount(v as CFArrayRef) as i64
            } else {
                -2
            };
            CFRelease(v);
            count
        }
        None => -1,
    }
}

/// Whether an attribute is present and non-null.
unsafe fn attr_present(el: CFTypeRef, name: &str) -> bool {
    match copy_attr(el, name) {
        Some(v) => {
            CFRelease(v);
            true
        }
        None => false,
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

/// A running GUI app: pid + its localized name + bundle identifier.
struct RunningApp {
    pid: i32,
    /// Localized display name, e.g. "备忘录" on a Chinese system.
    name: String,
    /// Bundle id, e.g. "com.apple.Notes" — useful for matching the model's
    /// English app name against a localized display name.
    bundle_id: String,
    /// True when activationPolicy == Regular: a normal app with a Dock icon and
    /// windows. Background helpers, widget/app extensions (e.g.
    /// "com.apple.Notes.WidgetExtension"), and XPC services are NOT regular and
    /// have no AX window tree — they must be excluded from app-name matching.
    is_regular: bool,
}

/// Enumerate running GUI apps via NSWorkspace.
///
/// Uses the native AppKit API — does NOT require Automation (Apple Events) permission,
/// unlike AppleScript `tell application "System Events"`, which fails with error -1743
/// when that separate TCC grant is missing. We already hold Accessibility permission,
/// which is all that AXUIElementCreateApplication needs.
fn running_apps() -> Vec<RunningApp> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();
    let mut out = Vec::new();
    for app in apps.iter() {
        out.push(RunningApp {
            pid: app.processIdentifier() as i32,
            name: app.localizedName().map(|s| s.to_string()).unwrap_or_default(),
            bundle_id: app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default(),
            is_regular: app.activationPolicy() == NSApplicationActivationPolicy::Regular,
        });
    }
    out
}

/// Get an AX element for a named application process.
///
/// Only considers "regular" apps (Dock icon + windows) — this excludes widget/app
/// extensions like "com.apple.Notes.WidgetExtension" whose localizedName is also
/// "Notes" but which have NO AX window tree (the cause of empty get_ui results).
///
/// Matches `name` (case-insensitive) against BOTH the localized display name and the
/// bundle identifier. This matters on localized systems: on a Chinese macOS, Notes'
/// localizedName is "备忘录", but its bundle id "com.apple.Notes" still contains "notes",
/// so the model's English `app_name: "Notes"` resolves correctly.
fn get_app_element_by_name(name: &str) -> Result<(CFTypeRef, Option<String>), String> {
    let needle = name.to_lowercase();
    let all = running_apps();
    // Only regular apps can be valid targets.
    let apps: Vec<&RunningApp> = all.iter().filter(|a| a.is_regular).collect();

    let name_lc = |a: &RunningApp| a.name.to_lowercase();
    let bundle_lc = |a: &RunningApp| a.bundle_id.to_lowercase();

    // Priority: exact name → exact bundle-leaf → name substring → bundle-id substring.
    // Exact bundle-leaf ("com.apple.Notes" → "notes") beats a substring match so the
    // canonical app wins over any sibling whose name merely contains the needle.
    let matched = apps
        .iter()
        .find(|a| name_lc(a) == needle)
        .or_else(|| {
            apps.iter()
                .find(|a| bundle_lc(a).rsplit('.').next() == Some(needle.as_str()))
        })
        .or_else(|| apps.iter().find(|a| name_lc(a).contains(&needle)))
        .or_else(|| apps.iter().find(|a| bundle_lc(a).contains(&needle)));

    match matched {
        Some(found) => unsafe {
            let app = AXUIElementCreateApplication(found.pid);
            if app.is_null() {
                return Err(format!(
                    "AXUIElementCreateApplication({}) returned null for '{}'",
                    found.pid, found.name
                ));
            }
            let ax_title = attr_string(app, "AXTitle");
            Ok((app, ax_title.or_else(|| Some(found.name.clone()))))
        },
        None => {
            let available: Vec<&str> = apps
                .iter()
                .filter(|a| !a.name.is_empty())
                .map(|a| a.name.as_str())
                .collect();
            Err(format!(
                "未找到名为 '{}' 的运行中应用。当前运行的应用：{}",
                name,
                available.join("、")
            ))
        }
    }
}

/// Bring an app to the foreground via NSRunningApplication.activate (no Automation
/// permission needed). Matches `name` against localizedName + bundle id, regular apps
/// only — same priority order as `get_app_element_by_name`.
pub fn activate_app_impl(name: String) -> Result<String, String> {
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSApplicationActivationPolicy, NSWorkspace,
    };
    let needle = name.to_lowercase();
    let workspace = NSWorkspace::sharedWorkspace();
    let apps = workspace.runningApplications();

    // Collect regular apps with their match keys.
    let regular: Vec<_> = apps
        .iter()
        .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .collect();

    let name_of = |a: &objc2_app_kit::NSRunningApplication| {
        a.localizedName().map(|s| s.to_string()).unwrap_or_default()
    };
    let bundle_of = |a: &objc2_app_kit::NSRunningApplication| {
        a.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default()
    };

    let matched = regular
        .iter()
        .find(|a| name_of(a).to_lowercase() == needle)
        .or_else(|| {
            regular
                .iter()
                .find(|a| bundle_of(a).to_lowercase().rsplit('.').next() == Some(needle.as_str()))
        })
        .or_else(|| regular.iter().find(|a| name_of(a).to_lowercase().contains(&needle)))
        .or_else(|| regular.iter().find(|a| bundle_of(a).to_lowercase().contains(&needle)));

    match matched {
        Some(app) => {
            let display = name_of(app);
            // ActivateAllWindows brings every window of the app forward (cross-app
            // raise that AXRaise can't do). IgnoringOtherApps is deprecated on macOS 14+.
            let ok = app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
            if ok {
                Ok(display)
            } else {
                Err(format!("activateWithOptions 返回 false（{}）", display))
            }
        }
        None => {
            let available: Vec<String> = regular
                .iter()
                .map(|a| name_of(a))
                .filter(|n| !n.is_empty())
                .collect();
            Err(format!(
                "未找到名为 '{}' 的运行中应用。当前运行的应用：{}",
                name,
                available.join("、")
            ))
        }
    }
}

/// Get an AX element for the visually frontmost application.
///
/// Uses `NSWorkspace.frontmostApplication` (native AppKit — no Automation permission)
/// to get the frontmost app's PID, then `AXUIElementCreateApplication(pid)`.
/// Falls back to `AXFocusedApplication` (keyboard focus) if NSWorkspace returns nothing.
///
/// Returns the element (caller must CFRelease) and the app name, or an error string.
fn get_frontmost_app_element() -> Result<(CFTypeRef, Option<String>), String> {
    use objc2_app_kit::NSWorkspace;

    // Primary: NSWorkspace.frontmostApplication — the visually-front app.
    let workspace = NSWorkspace::sharedWorkspace();
    let front: Option<(i32, Option<String>)> = workspace.frontmostApplication().map(|app| {
        let pid = app.processIdentifier() as i32;
        let name = app.localizedName().map(|s| s.to_string());
        (pid, name)
    });

    if let Some((pid, name)) = front {
        unsafe {
            let app = AXUIElementCreateApplication(pid);
            if !app.is_null() {
                let ax_title = attr_string(app, "AXTitle");
                return Ok((app, ax_title.or(name)));
            }
        }
    }

    // Fallback: AXFocusedApplication (keyboard focus).
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return Err("AXUIElementCreateSystemWide returned null".to_string());
        }
        match copy_attr(sys, "AXFocusedApplication") {
            Some(app) => {
                CFRelease(sys);
                let app_name = attr_string(app, "AXTitle");
                Ok((app, app_name))
            }
            None => {
                CFRelease(sys);
                Err(
                    "no frontmost app found (NSWorkspace.frontmostApplication and \
                     AXFocusedApplication both empty)."
                        .to_string(),
                )
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

/// Observe the app element's structural attributes for a given pid.
fn observe_app(pid: i32) -> AxDiagSnapshot {
    use objc2_app_kit::NSRunningApplication;
    let is_active = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .map(|a| a.isActive())
        .unwrap_or(false);
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return AxDiagSnapshot {
                is_active,
                ax_role: None,
                ax_title: None,
                ax_children_count: -1,
                ax_windows_count: -1,
                has_main_window: false,
                has_focused_window: false,
                walk_elements: 0,
            };
        }
        let ax_role = attr_string(app, "AXRole");
        let ax_title = attr_string(app, "AXTitle");
        let ax_children_count = attr_array_count(app, "AXChildren");
        let ax_windows_count = attr_array_count(app, "AXWindows");
        let has_main_window = attr_present(app, "AXMainWindow");
        let has_focused_window = attr_present(app, "AXFocusedWindow");
        let mut st = WalkState {
            elements: Vec::new(),
            visited: 0,
            truncated: false,
        };
        walk(app, 0, &mut st);
        CFRelease(app);
        AxDiagSnapshot {
            is_active,
            ax_role,
            ax_title,
            ax_children_count,
            ax_windows_count,
            has_main_window,
            has_focused_window,
            walk_elements: st.elements.len(),
        }
    }
}

/// Diagnostic: observe an app's AX structure before and after activating it.
pub async fn ax_diagnose_impl(app_name: String) -> Result<AxDiagReport, String> {
    let needle = app_name.to_lowercase();
    let all = running_apps();
    // Same Regular-app filter as get_app_element_by_name so the diagnostic targets
    // the real app, not a widget/extension sibling.
    let apps: Vec<&RunningApp> = all.iter().filter(|a| a.is_regular).collect();
    let found = apps
        .iter()
        .find(|a| a.name.to_lowercase() == needle)
        .or_else(|| {
            apps.iter()
                .find(|a| a.bundle_id.to_lowercase().rsplit('.').next() == Some(needle.as_str()))
        })
        .or_else(|| apps.iter().find(|a| a.name.to_lowercase().contains(&needle)))
        .or_else(|| apps.iter().find(|a| a.bundle_id.to_lowercase().contains(&needle)))
        .ok_or_else(|| format!("App '{}' not running (regular apps only)", app_name))?;
    let pid = found.pid;

    // Observe WITHOUT activating.
    let before = observe_app(pid);

    // Activate (bring to front) via `open` — system-level, works on all macOS versions
    // (NSRunningApplication.activate is restricted/deprecated on macOS 14+). Prefer
    // bundle id, fall back to localized name.
    if !found.bundle_id.is_empty() {
        let _ = std::process::Command::new("open")
            .args(["-b", &found.bundle_id])
            .status();
    } else if !found.name.is_empty() {
        let _ = std::process::Command::new("open")
            .args(["-a", &found.name])
            .status();
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;

    // Observe AFTER activating.
    let after = observe_app(pid);

    Ok(AxDiagReport {
        pid,
        localized_name: found.name.clone(),
        bundle_id: found.bundle_id.clone(),
        before,
        after,
    })
}

/// Walk EVERY node (no role filter) collecting any with non-empty text. Caps output
/// at MAX_ELEMENTS text nodes / MAX_VISITED visited to stay bounded.
unsafe fn walk_text(el: CFTypeRef, depth: u32, out: &mut Vec<AxTextNode>, visited: &mut usize) {
    if depth > MAX_DEPTH || out.len() >= MAX_ELEMENTS || *visited >= MAX_VISITED {
        return;
    }
    *visited += 1;

    let role = attr_string(el, "AXRole").unwrap_or_default();
    // Probe text from the three usual carriers, in priority order.
    let (text, source) = if let Some(v) = attr_string(el, "AXValue") {
        (v, "AXValue")
    } else if let Some(t) = attr_string(el, "AXTitle") {
        (t, "AXTitle")
    } else if let Some(d) = attr_string(el, "AXDescription") {
        (d, "AXDescription")
    } else {
        (String::new(), "")
    };

    if !text.is_empty() {
        let pressable = action_names(el).iter().any(|a| a == "AXPress");
        out.push(AxTextNode {
            role: role.clone(),
            text,
            source: source.to_string(),
            depth,
            pressable,
        });
    }

    let kids = children(el);
    for k in kids {
        walk_text(k, depth + 1, out, visited);
        CFRelease(k);
    }
}

/// Diagnostic: dump all text-bearing nodes for the target app (or frontmost).
pub fn ax_probe_text_impl(target_app: Option<String>) -> Result<Vec<AxTextNode>, String> {
    unsafe {
        if !ax_is_trusted_with_prompt() {
            return Err("需要辅助功能权限".to_string());
        }
        let (app, _name) = if let Some(ref name) = target_app {
            get_app_element_by_name(name)?
        } else {
            get_frontmost_app_element()?
        };
        let mut out = Vec::new();
        let mut visited = 0usize;
        walk_text(app, 0, &mut out, &mut visited);
        CFRelease(app);
        Ok(out)
    }
}

/// Set a boolean AX attribute on an element (best-effort; ignores errors).
unsafe fn set_bool_attr(el: CFTypeRef, name: &str, val: bool) {
    let attr = CFString::new(name);
    let b = if val { CFBoolean::true_value() } else { CFBoolean::false_value() };
    AXUIElementSetAttributeValue(
        el,
        attr.as_concrete_TypeRef(),
        b.as_concrete_TypeRef() as CFTypeRef,
    );
}

/// Find a Regular app's pid by name/bundle (same matching as get_app_element_by_name).
fn find_regular_app_pid(name: &str) -> Option<i32> {
    let needle = name.to_lowercase();
    let all = running_apps();
    let apps: Vec<&RunningApp> = all.iter().filter(|a| a.is_regular).collect();
    apps.iter()
        .find(|a| a.name.to_lowercase() == needle)
        .or_else(|| {
            apps.iter()
                .find(|a| a.bundle_id.to_lowercase().rsplit('.').next() == Some(needle.as_str()))
        })
        .or_else(|| apps.iter().find(|a| a.name.to_lowercase().contains(&needle)))
        .or_else(|| apps.iter().find(|a| a.bundle_id.to_lowercase().contains(&needle)))
        .map(|a| a.pid)
}

/// Diagnostic: force Chromium/Electron to build its accessibility tree, then dump text.
/// Note: must not hold a raw CFTypeRef across .await (non-Send) — so we resolve the pid,
/// do CF work in sync blocks, and re-create the element from the pid after the sleep.
pub async fn ax_enable_electron_a11y_impl(app_name: String) -> Result<Vec<AxTextNode>, String> {
    unsafe {
        if !ax_is_trusted_with_prompt() {
            return Err("需要辅助功能权限".to_string());
        }
    }
    let pid = find_regular_app_pid(&app_name)
        .ok_or_else(|| format!("App '{}' not running (regular apps only)", app_name))?;

    // Set the Chromium switch (AXManualAccessibility) + the older AppKit one. Sync block.
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if !app.is_null() {
            set_bool_attr(app, "AXManualAccessibility", true);
            set_bool_attr(app, "AXEnhancedUserInterface", true);
            CFRelease(app);
        }
    }

    // Chromium needs a moment to build the tree after the flag flips.
    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;

    // Re-create the element and dump text. Sync block.
    let out = unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Err(format!("AXUIElementCreateApplication({}) returned null", pid));
        }
        let mut out = Vec::new();
        let mut visited = 0usize;
        walk_text(app, 0, &mut out, &mut visited);
        CFRelease(app);
        out
    };
    Ok(out)
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

/// Perform any named AX action on the cached element.
pub fn ax_perform_action_impl(session_id: String, element_id: u32, action_name: String) -> Result<(), String> {
    let cache = session_cache().lock().unwrap();
    let session = cache
        .get(&session_id)
        .ok_or_else(|| format!("Session '{}' not found — call ax_snapshot first.", session_id))?;
    let el_ref = session
        .refs
        .get(element_id as usize)
        .ok_or_else(|| format!("element_id {} out of range (session has {} elements).", element_id, session.refs.len()))?;

    unsafe {
        let action = CFString::new(&action_name);
        let err = AXUIElementPerformAction(el_ref.0, action.as_concrete_TypeRef());
        if err != 0 {
            return Err(format!(
                "AX action '{}' on element {} failed: {} ({})",
                action_name, element_id, err, ax_err_str(err)
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
