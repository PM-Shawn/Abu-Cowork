//! Windows desktop identity and window targeting primitives.
//!
//! This module is native-helper-only. New Electron product behavior must not
//! be added to the frozen Tauri compatibility path.

mod app_catalog;
mod dpi;
mod input;
mod interaction;
mod screenshot;
mod signature;
mod uia;
mod window;

pub use uia::{
    ax_close_session_impl, ax_perform_action_impl, ax_press_impl, ax_restore_focus_impl,
    ax_set_value_impl, ax_snapshot_impl,
};

pub use app_catalog::{launch_app_impl, list_apps_impl};
pub use dpi::{dpi_awareness, initialize_dpi_awareness};
pub use input::{
    keyboard_press_impl, keyboard_type_impl, mouse_click_impl, mouse_drag_impl, mouse_move_impl,
    mouse_scroll_impl,
};
pub use interaction::{
    activate_input_lease, begin_input_lease, begin_input_observation, commit_input_observation,
    end_input_lease, initialize_input_monitoring, input_monitoring_ready, observe_input_lease,
    pause_input_lease, resume_input_lease,
};
pub use screenshot::capture_screen_state_impl;
pub use window::{
    activate_app_impl, activate_window_impl, frontmost_app_identity_impl,
    frontmost_matches_target_impl, get_window_graph_impl, get_window_impl, list_windows_impl,
    resolve_app_identity_impl, WindowGraph,
};
pub(crate) use window::{parse_hwnd, resolve_window};
