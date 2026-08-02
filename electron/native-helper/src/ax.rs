//! Re-hosts the Accessibility (AXUIElement) implementation from src-tauri by
//! `include!`-ing the same two Tauri-free source files (DRY — no copy, no
//! rewrite of the AX FFI). See src-tauri/src/accessibility.rs /
//! accessibility_types.rs / accessibility_macos.rs for the canonical source.
//!
//! This file is brought in from main.rs as `#[cfg(target_os = "macos")] mod
//! ax;`, so this file's top level IS the `ax` module — the `mod macos`
//! declared below therefore lives at `ax::macos`, and its `use super::{...}`
//! (in accessibility_macos.rs) resolves against `ax`, exactly like it
//! resolved against the `accessibility` module in src-tauri.
//!
//! Path resolution from this file (electron/native-helper/src/ax.rs):
//!   electron/native-helper/src/  --(../)-->  electron/native-helper/
//!                                --(../../)-->  electron/
//!                                --(../../../)-->  <repo root>
//!   so "../../../src-tauri/src/..." reaches <repo root>/src-tauri/src/...

// This crate only wires the 6 action/perception RPC methods (ax_snapshot,
// ax_press, ax_set_value, ax_perform_action, ax_close_session, activate_app)
// into the dispatch below — the diagnostic-only pieces (get_ui_snapshot_impl,
// ax_diagnose_impl, ax_probe_text_impl, ax_enable_electron_a11y_impl,
// test_ax_snapshot_impl, AxQualityReport, AxDiagReport, ...) come along for
// free because the whole file is `include!`d verbatim, but stay unused here
// (they're still used from src-tauri's Tauri commands). Silence the resulting
// dead-code noise rather than pruning code we don't own.
#![allow(dead_code)]

// The types file provides `AxDiagReport, AxDiagSnapshot, AxQualityReport,
// AxTextNode, UiElement, UiSnapshot, AxSnapshotResult` at this module's
// scope, which is what accessibility_macos.rs's `use super::{...}` expects.
include!("../../../src-tauri/src/accessibility_types.rs");

#[path = "../../../src-tauri/src/accessibility_macos.rs"]
pub mod macos;
pub use macos::*;
