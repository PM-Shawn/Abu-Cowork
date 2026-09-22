//! Windows session boundaries the helper can recognise before touching the
//! desktop (contract §2.8 `boundaries`, proposal §4.2 "平台边界明确提示"):
//!
//! * **Session 0** — the services session has no interactive desktop; nothing
//!   Abu does there is visible or receives input.
//! * **Disconnected remote session** — after the RDP client disconnects (or
//!   is minimised on some clients) the session is not rendered: captures
//!   freeze and injected input lands on a screen nobody sees.
//!
//! Both are refused up front with their own code so the user gets one plain
//! sentence instead of a stale screenshot or a silent no-op.

use windows::core::PWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSConnectState, WTSDisconnected, WTSFreeMemory,
    WTSQuerySessionInformationW, WTS_CURRENT_SESSION,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};

use crate::error::HelperError;

pub const SESSION_ZERO: &str = "session-zero";
pub const REMOTE_SESSION_DISCONNECTED: &str = "remote-session-disconnected";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Console,
    Remote,
    Disconnected,
    SessionZero,
}

/// Codes this driver can identify and refuse before dispatch. Declared in
/// hello so the Host and the model know which boundaries are recognised.
pub fn boundaries() -> Vec<&'static str> {
    vec![
        "secure-desktop",
        "higher-integrity",
        SESSION_ZERO,
        REMOTE_SESSION_DISCONNECTED,
    ]
}

fn current_session_id() -> Option<u32> {
    let mut id = 0u32;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut id) }
        .ok()
        .map(|_| id)
}

fn current_session_disconnected() -> bool {
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    let queried = unsafe {
        WTSQuerySessionInformationW(
            HANDLE::default(),
            WTS_CURRENT_SESSION,
            WTSConnectState,
            &mut buffer,
            &mut bytes,
        )
    };
    if queried.is_err() || buffer.is_null() || (bytes as usize) < std::mem::size_of::<i32>() {
        return false;
    }
    let state = unsafe { *(buffer.0 as *const i32) };
    unsafe { WTSFreeMemory(buffer.0.cast()) };
    state == WTSDisconnected.0
}

pub fn session_state() -> SessionState {
    if current_session_id() == Some(0) {
        return SessionState::SessionZero;
    }
    if current_session_disconnected() {
        return SessionState::Disconnected;
    }
    if unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0 {
        SessionState::Remote
    } else {
        SessionState::Console
    }
}

/// Refuses input and capture in a session where they cannot be seen.
pub fn assert_session_usable() -> Result<(), HelperError> {
    refusal_for(session_state())
}

fn refusal_for(state: SessionState) -> Result<(), HelperError> {
    match state {
        SessionState::SessionZero => Err(HelperError::not_executed(
            SESSION_ZERO,
            "helper runs in Session 0, which has no interactive desktop; input and capture are unavailable",
        )),
        SessionState::Disconnected => Err(HelperError::not_executed(
            REMOTE_SESSION_DISCONNECTED,
            "the remote desktop session is disconnected; the screen is not rendered and input would not be visible",
        )),
        SessionState::Console | SessionState::Remote => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_boundaries_include_the_session_codes() {
        let declared = boundaries();
        assert!(declared.contains(&"secure-desktop"));
        assert!(declared.contains(&"higher-integrity"));
        assert!(declared.contains(&SESSION_ZERO));
        assert!(declared.contains(&REMOTE_SESSION_DISCONNECTED));
    }

    #[test]
    fn only_unusable_sessions_are_refused_and_never_retryable() {
        assert!(refusal_for(SessionState::Console).is_ok());
        assert!(refusal_for(SessionState::Remote).is_ok());
        let zero = refusal_for(SessionState::SessionZero).unwrap_err();
        assert_eq!(zero.code, SESSION_ZERO);
        assert_eq!(zero.execution, crate::error::Execution::NotExecuted);
        assert!(!zero.retryable);
        let gone = refusal_for(SessionState::Disconnected).unwrap_err();
        assert_eq!(gone.code, REMOTE_SESSION_DISCONNECTED);
        assert!(!gone.retryable);
    }

    #[test]
    fn this_test_process_is_in_an_interactive_session() {
        // cargo test runs on a logged-in desktop: never Session 0, and its
        // own session cannot be disconnected while it is running here.
        assert!(matches!(
            session_state(),
            SessionState::Console | SessionState::Remote
        ));
    }
}
