//! Re-hosts the Computer Use implementation from src-tauri by `include!`-ing the
//! same Tauri-free source file (DRY — no copy, no rewrite of the enigo/xcap/
//! CoreGraphics logic). See src-tauri/src/computer_use.rs / computer_use_impl.rs
//! for the canonical source.
//!
//! This file is brought in from main.rs as `mod cu;` (unconditional — unlike
//! `mod ax;`, Computer Use input-synth + screen capture are cross-platform, only
//! the exclusion-capture/TCC pieces inside computer_use_impl.rs are internally
//! `#[cfg(target_os = "macos")]`-gated, same as they are in src-tauri).
//!
//! Path resolution from this file (electron/native-helper/src/cu.rs):
//!   electron/native-helper/src/  --(../)-->  electron/native-helper/
//!                                --(../../)-->  electron/
//!                                --(../../../)-->  <repo root>
//!   so "../../../src-tauri/src/..." reaches <repo root>/src-tauri/src/...

// computer_use_impl.rs supplies its own `use` statements (enigo/base64/image/
// xcap, plus macOS-only objc2-core-graphics + extern "C" TCC declarations), so
// this file needs none of its own — including it directly is enough, exactly
// like src-tauri/src/computer_use.rs does.
//
// Some items (e.g. `choose_display_id`, `capture_excluding_impl`) are macOS-only
// and some of the cross-platform impls (e.g. Windows branch of
// `check_macos_permissions_impl`) are unreachable on this build target; silence
// the resulting dead-code noise rather than pruning code we don't own.
#![allow(dead_code)]

include!("../../../src-tauri/src/computer_use_impl.rs");
