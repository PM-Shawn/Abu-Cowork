// Types shared by `accessibility.rs` (Tauri command wrappers) and
// `accessibility_macos.rs` (the Tauri-free AX implementation), plus the
// native-helper crate, which `include!`s this same file verbatim (see
// electron/native-helper/src/ax.rs). Kept dependency-free (only `serde`) and
// with fully-qualified derive paths so it is `include!`-safe in either crate
// without requiring a `use serde::...` line at the top of this file.

/// Quality report returned by `test_ax_snapshot`.
#[derive(serde::Serialize)]
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
#[derive(serde::Serialize, Clone)]
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
#[derive(serde::Serialize)]
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
#[derive(serde::Serialize)]
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

/// Stable identity for one running desktop application.
///
/// Computer Use authorization binds to this identity rather than a model-
/// supplied display name, which may be localized or ambiguous.
#[derive(serde::Serialize)]
pub struct AppIdentity {
    pub app_name: String,
    pub bundle_id: String,
    pub process_id: i32,
}

/// Diagnostic: probe why an app's AX tree may be empty. Reports the app element's
/// attributes BEFORE and AFTER activating (bringing it to front), so we can tell
/// whether empty `AXChildren` is caused by the app not being active (→ activate fix)
/// or by `AXChildren` being the wrong attribute (→ AXWindows fallback fix).
#[derive(serde::Serialize)]
pub struct AxDiagReport {
    pub pid: i32,
    pub localized_name: String,
    pub bundle_id: String,
    /// State observed without activating the app first.
    pub before: AxDiagSnapshot,
    /// State observed after NSRunningApplication.activate + short wait.
    pub after: AxDiagSnapshot,
}

/// One observation of the app element's structural attributes.
#[derive(serde::Serialize)]
pub struct AxDiagSnapshot {
    /// NSRunningApplication.isActive at observation time.
    pub is_active: bool,
    /// AXRole of the app element (expected "AXApplication").
    pub ax_role: Option<String>,
    /// AXTitle of the app element.
    pub ax_title: Option<String>,
    /// Number of children under AXChildren (the attribute walk() currently uses).
    pub ax_children_count: i64,
    /// Number of windows under AXWindows (candidate fallback attribute).
    pub ax_windows_count: i64,
    /// Whether AXMainWindow is present.
    pub has_main_window: bool,
    /// Whether AXFocusedWindow is present.
    pub has_focused_window: bool,
    /// Total interactable elements a full walk would collect right now.
    pub walk_elements: usize,
}

/// Diagnostic: one text-bearing node found anywhere in the tree (no role filter).
/// Used to discover whether semantic text (contact names, message bodies) exists
/// in a poorly-labelled Electron app's AX tree but is being filtered out by the
/// normal interactable-only walk.
#[derive(serde::Serialize)]
pub struct AxTextNode {
    pub role: String,
    /// Non-empty text from AXValue / AXTitle / AXDescription (whichever hit first).
    pub text: String,
    /// Which attribute the text came from: "AXValue" / "AXTitle" / "AXDescription".
    pub source: String,
    pub depth: u32,
    /// Whether this node itself advertises AXPress (directly clickable).
    pub pressable: bool,
}
