//! F10 spike probe (macOS). Reports the two TCC-gated statuses that the real
//! computer-use/AX family depends on, plus process identity, so we can compare
//! standalone-run vs Electron-spawned and read how macOS attributes TCC.
//!
//!  - AXIsProcessTrusted()             → Accessibility (input synthesis + AX tree)
//!  - CGPreflightScreenCaptureAccess() → Screen Recording (capture_screen)
//!  - CGEventSourceCreate()            → input-synth API is linkable/callable
//!
//! All three calls are READS (no mouse is moved, no screenshot taken), so
//! running this is non-disruptive. NDJSON on stdout, then exits — same stdio
//! shape the real helper binary would use for JSON-RPC.

use std::ffi::c_void;
use std::io::Write;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    // CGEventSourceStateID: 0=Private, 1=CombinedSessionState, 2=HIDSystemState
    fn CGEventSourceCreate(state_id: u32) -> *mut c_void;
    fn CFRelease(cf: *mut c_void);
}

fn main() {
    let ax_trusted = unsafe { AXIsProcessTrusted() };
    let screen_capture = unsafe { CGPreflightScreenCaptureAccess() };

    // Creating an event source doesn't require permission (posting does), but it
    // proves the input-synth framework path links and is callable from here.
    let src = unsafe { CGEventSourceCreate(1) };
    let event_source_ok = !src.is_null();
    if event_source_ok {
        unsafe { CFRelease(src) };
    }

    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let pid = std::process::id();
    // Parent pid via a tiny raw syscall wrapper — no libc dependency.
    extern "C" {
        fn getppid() -> i32;
    }
    let ppid = unsafe { getppid() };

    let out = format!(
        "{{\"ax_trusted\":{},\"screen_capture\":{},\"event_source_ok\":{},\"pid\":{},\"ppid\":{},\"exe\":{:?}}}",
        ax_trusted, screen_capture, event_source_ok, pid, ppid, exe
    );
    println!("{}", out);
    std::io::stdout().flush().ok();
}
