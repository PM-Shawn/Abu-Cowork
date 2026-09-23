use crate::windows_backend::WindowGraph;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct RangeValueState {
    pub value: f64,
    pub minimum: f64,
    pub maximum: f64,
    pub small_change: f64,
    pub large_change: f64,
    pub read_only: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScrollState {
    pub horizontally_scrollable: bool,
    pub horizontal_scroll_percent: f64,
    pub horizontal_view_size: f64,
    pub vertically_scrollable: bool,
    pub vertical_scroll_percent: f64,
    pub vertical_view_size: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct UiElement {
    pub id: u32,
    /// Opaque, session-stable identity derived from the UIA RuntimeId; None
    /// when the platform cannot attest one. Upper tiers compare it and never
    /// parse or display it — the model keeps addressing elements by `id`.
    #[serde(rename = "ref")]
    pub element_ref: Option<String>,
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub value_read_only: Option<bool>,
    pub range_value: Option<RangeValueState>,
    pub toggle_state: Option<String>,
    pub selected: Option<bool>,
    pub expand_collapse_state: Option<String>,
    pub scroll_state: Option<ScrollState>,
    pub bounds: [f64; 4],
    pub patterns: Vec<String>,
    pub actions: Vec<String>,
    pub depth: u32,
    pub automation_id: Option<String>,
    pub class_name: Option<String>,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
}

#[derive(Debug, Serialize)]
pub struct AxSnapshotResult {
    pub session_id: String,
    pub app: Option<String>,
    pub total_visited: usize,
    pub truncated: bool,
    pub focused_element_id: Option<u32>,
    pub elements: Vec<UiElement>,
    pub window_id: String,
    pub process_id: u32,
    pub accessibility_revision: u64,
    pub input_epoch: u64,
    pub modal: bool,
    pub modal_window_id: Option<String>,
    pub window_graph: WindowGraph,
}
