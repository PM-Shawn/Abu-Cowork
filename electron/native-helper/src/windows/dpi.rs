//! Process DPI awareness self-check and display-configuration signature.
//!
//! Everything the helper says about the screen is in physical pixels: WGC
//! frames, UIA bounding rectangles, `GetWindowRect`, `SendInput`. That is only
//! true while this process is Per-Monitor (V2) DPI aware; under any other
//! context Windows virtualizes window and monitor coordinates behind our back
//! on mixed-DPI desktops, and a click computed from a screenshot lands
//! somewhere else. The request for V2 is made once, first thing in `main`;
//! what the process actually got is recorded and declared (contract §2.8
//! `capture.dpi_awareness`), and coordinate input refuses to run under
//! anything else.

use std::fmt::Display;
use std::sync::OnceLock;

use windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, GetAwarenessFromDpiAwarenessContext,
    GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext, DPI_AWARENESS,
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, DPI_AWARENESS_PER_MONITOR_AWARE,
    DPI_AWARENESS_SYSTEM_AWARE, DPI_AWARENESS_UNAWARE,
};
use xcap::Monitor;

use crate::error::HelperError;

pub const DPI_PER_MONITOR_V2: &str = "per-monitor-v2";

static DPI_AWARENESS_LABEL: OnceLock<&'static str> = OnceLock::new();

/// Requests Per-Monitor V2 and records the context the process ended up with.
/// The request's own result is deliberately not the verdict: it fails with
/// "access denied" when a manifest or the launcher already set a context, and
/// that context may or may not be the one we need. Idempotent.
pub fn initialize_dpi_awareness() -> &'static str {
    DPI_AWARENESS_LABEL.get_or_init(|| {
        // SAFETY: plain Win32 calls that take and return handles by value; the
        // context returned by GetThreadDpiAwarenessContext is a pseudo-handle
        // that is never freed.
        let _ =
            unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let context = unsafe { GetThreadDpiAwarenessContext() };
        let per_monitor_v2 = unsafe {
            AreDpiAwarenessContextsEqual(context, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
        }
        .as_bool();
        let awareness = unsafe { GetAwarenessFromDpiAwarenessContext(context) };
        classify_dpi_awareness(per_monitor_v2, awareness)
    })
}

/// The declared value: `per-monitor-v2`, `per-monitor`, `system`, `unaware`
/// or `unknown`. Runs the self-check on first use if `main` has not yet.
pub fn dpi_awareness() -> &'static str {
    initialize_dpi_awareness()
}

pub fn per_monitor_v2() -> bool {
    dpi_awareness() == DPI_PER_MONITOR_V2
}

fn classify_dpi_awareness(per_monitor_v2: bool, awareness: DPI_AWARENESS) -> &'static str {
    if per_monitor_v2 {
        DPI_PER_MONITOR_V2
    } else if awareness == DPI_AWARENESS_PER_MONITOR_AWARE {
        "per-monitor"
    } else if awareness == DPI_AWARENESS_SYSTEM_AWARE {
        "system"
    } else if awareness == DPI_AWARENESS_UNAWARE {
        "unaware"
    } else {
        "unknown"
    }
}

/// One monitor as it matters to coordinate mapping. Scale is kept as an
/// integer so the digest is exact.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct MonitorRow {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_permille: u32,
    primary: bool,
}

fn field_error(name: &str, error: impl Display) -> HelperError {
    HelperError::preflight(format!("monitor {name} failed: {error}"))
}

/// Digest of the current monitor layout (identity, bounds, scale, primary).
/// A screenshot records it at capture time and coordinate input compares it
/// again before mapping: docking, unplugging or rescaling a display in between
/// makes the screenshot stale instead of silently wrong.
pub fn display_signature() -> Result<u64, HelperError> {
    let monitors = Monitor::all().map_err(|error| field_error("enumeration", error))?;
    let mut rows = Vec::with_capacity(monitors.len());
    for monitor in monitors {
        let scale = f64::from(
            monitor
                .scale_factor()
                .map_err(|error| field_error("scale", error))?,
        );
        rows.push(MonitorRow {
            id: monitor.id().map_err(|error| field_error("id", error))?,
            x: monitor.x().map_err(|error| field_error("x", error))?,
            y: monitor.y().map_err(|error| field_error("y", error))?,
            width: monitor
                .width()
                .map_err(|error| field_error("width", error))?,
            height: monitor
                .height()
                .map_err(|error| field_error("height", error))?,
            scale_permille: (scale * 1000.0).round().max(0.0) as u32,
            primary: monitor
                .is_primary()
                .map_err(|error| field_error("primary", error))?,
        });
    }
    Ok(signature_of(rows))
}

fn signature_of(mut rows: Vec<MonitorRow>) -> u64 {
    rows.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    feed(&(rows.len() as u32).to_le_bytes());
    for row in &rows {
        feed(&row.id.to_le_bytes());
        feed(&row.x.to_le_bytes());
        feed(&row.y.to_le_bytes());
        feed(&row.width.to_le_bytes());
        feed(&row.height.to_le_bytes());
        feed(&row.scale_permille.to_le_bytes());
        feed(&[u8::from(row.primary)]);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: u32, x: i32, scale_permille: u32) -> MonitorRow {
        MonitorRow {
            id,
            x,
            y: 0,
            width: 1920,
            height: 1080,
            scale_permille,
            primary: id == 1,
        }
    }

    #[test]
    fn signature_ignores_enumeration_order() {
        assert_eq!(
            signature_of(vec![row(1, 0, 1000), row(2, 1920, 1250)]),
            signature_of(vec![row(2, 1920, 1250), row(1, 0, 1000)])
        );
    }

    #[test]
    fn signature_changes_with_scale_bounds_or_monitor_count() {
        let base = signature_of(vec![row(1, 0, 1000), row(2, 1920, 1250)]);
        assert_ne!(
            base,
            signature_of(vec![row(1, 0, 1000), row(2, 1920, 1500)])
        );
        assert_ne!(
            base,
            signature_of(vec![row(1, 0, 1000), row(2, 2560, 1250)])
        );
        assert_ne!(base, signature_of(vec![row(1, 0, 1000)]));
        assert_ne!(base, signature_of(Vec::new()));
    }

    #[test]
    fn classifies_awareness_with_v2_taking_precedence() {
        assert_eq!(
            classify_dpi_awareness(true, DPI_AWARENESS_PER_MONITOR_AWARE),
            DPI_PER_MONITOR_V2
        );
        assert_eq!(
            classify_dpi_awareness(true, DPI_AWARENESS_UNAWARE),
            DPI_PER_MONITOR_V2
        );
        assert_eq!(
            classify_dpi_awareness(false, DPI_AWARENESS_PER_MONITOR_AWARE),
            "per-monitor"
        );
        assert_eq!(
            classify_dpi_awareness(false, DPI_AWARENESS_SYSTEM_AWARE),
            "system"
        );
        assert_eq!(
            classify_dpi_awareness(false, DPI_AWARENESS_UNAWARE),
            "unaware"
        );
        assert_eq!(classify_dpi_awareness(false, DPI_AWARENESS(99)), "unknown");
    }

    #[test]
    fn self_check_reports_a_declared_vocabulary_value() {
        // The test process may have fixed its context before this runs, so the
        // exact value is checked against the real binary by the contract test
        // (hello); here only the vocabulary and idempotence are pinned.
        let first = initialize_dpi_awareness();
        assert!([
            "per-monitor-v2",
            "per-monitor",
            "system",
            "unaware",
            "unknown"
        ]
        .contains(&first));
        assert_eq!(dpi_awareness(), first);
    }
}
