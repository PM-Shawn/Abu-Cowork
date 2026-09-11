use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, OnceLock};
use std::thread;

use windows::core::BSTR;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationRangeValuePattern, IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
    UIA_ExpandCollapsePatternId, UIA_InvokePatternId, UIA_RangeValuePatternId,
    UIA_ScrollItemPatternId, UIA_ScrollPatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId,
    UIA_ValuePatternId,
};

use crate::windows_backend::{get_window_graph_impl, get_window_impl, parse_hwnd, resolve_window};

use super::cache::{CachedElement, UiaSession};
use super::snapshot::{build_snapshot, runtime_id_for_validation};
use super::types::AxSnapshotResult;

static WORKER: OnceLock<UiaWorker> = OnceLock::new();
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

enum Command {
    Snapshot {
        app_name: String,
        expected_app_id: Option<String>,
        expected_process_id: Option<u32>,
        expected_window_id: Option<String>,
        reply: mpsc::Sender<Result<AxSnapshotResult, String>>,
    },
    Press {
        session_id: String,
        element_id: u32,
        reply: mpsc::Sender<Result<(), String>>,
    },
    SetValue {
        session_id: String,
        element_id: u32,
        value: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Perform {
        session_id: String,
        element_id: u32,
        action: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    RestoreFocus {
        session_id: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    Close {
        session_id: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
}

struct UiaWorker {
    sender: mpsc::Sender<Command>,
}

fn session_id() -> String {
    format!(
        "uia-{}-{}",
        std::process::id(),
        SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn validate_cached_element(session: &UiaSession, element: &CachedElement) -> Result<(), String> {
    if !super::super::interaction::input_monitoring_ready() {
        return Err("physical input monitoring is unavailable; UIA action is blocked".to_string());
    }
    if !super::super::interaction::input_lease_running() {
        return Err(
            "Computer Use input lease is not active; observe again before UIA action".to_string(),
        );
    }
    if session.input_epoch != super::super::interaction::input_epoch() {
        return Err("physical user input occurred after observation; observe again".to_string());
    }
    let window = get_window_impl(session.window_id.clone())?;
    if window.process_id != session.process_id
        || !window.app_id.eq_ignore_ascii_case(&session.app_id)
    {
        crate::emit_helper_event("window-invalidated", "uia-target-changed");
        return Err("UIA target window identity changed; observe again".to_string());
    }
    if element.process_id != session.process_id {
        crate::emit_helper_event("window-invalidated", "uia-element-process-changed");
        return Err("UIA element process changed; observe again".to_string());
    }
    let actual_process = unsafe { element.native.CurrentProcessId() }
        .map_err(|error| format!("UIA element is stale: {error}"))?;
    if actual_process != session.process_id as i32 {
        return Err("UIA element no longer belongs to the target process".to_string());
    }
    let actual_runtime = runtime_id_for_validation(&element.native);
    if !runtime_id_matches(&element.runtime_id, &actual_runtime) {
        crate::emit_helper_event("window-invalidated", "uia-runtime-id-changed");
        return Err("UIA Runtime ID changed; observe again".to_string());
    }
    let rect = unsafe { element.native.CurrentBoundingRectangle() }
        .map_err(|error| format!("UIA element bounds are unavailable: {error}"))?;
    let actual_bounds = [
        rect.left as f64,
        rect.top as f64,
        rect.right.saturating_sub(rect.left) as f64,
        rect.bottom.saturating_sub(rect.top) as f64,
    ];
    if actual_bounds != element.bounds {
        crate::emit_helper_event("window-invalidated", "uia-element-bounds-changed");
        return Err("UIA element bounds changed; observe again".to_string());
    }
    Ok(())
}

fn runtime_id_matches(expected: &[i32], actual: &[i32]) -> bool {
    !expected.is_empty() && expected == actual
}

fn get_session_element<'a>(
    sessions: &'a HashMap<String, UiaSession>,
    session_id: &str,
    element_id: u32,
) -> Result<(&'a UiaSession, &'a CachedElement), String> {
    let session = sessions
        .get(session_id)
        .ok_or_else(|| "UIA session is unavailable; observe again".to_string())?;
    let element = session.element(element_id)?;
    validate_cached_element(session, element)?;
    Ok((session, element))
}

fn run_worker(receiver: mpsc::Receiver<Command>) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let automation: Result<IUIAutomation, String> = if initialized {
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("create Windows UI Automation failed: {error}"))
    } else {
        Err("initialize Windows UI Automation COM apartment failed".to_string())
    };
    let mut sessions: HashMap<String, UiaSession> = HashMap::new();
    let mut revision = 0u64;
    while let Ok(command) = receiver.recv() {
        match command {
            Command::Snapshot {
                app_name,
                expected_app_id,
                expected_process_id,
                expected_window_id,
                reply,
            } => {
                let result = (|| {
                    let automation = automation.as_ref().map_err(Clone::clone)?;
                    let lookup = expected_app_id.as_deref().unwrap_or(&app_name);
                    let window = if let Some(window_id) = expected_window_id.as_deref() {
                        get_window_impl(window_id.to_string())?
                    } else {
                        resolve_window(lookup)?
                    };
                    if expected_app_id.as_ref().is_some_and(|expected| {
                        !window.app_id.eq_ignore_ascii_case(expected.trim())
                    }) {
                        return Err("UIA target app identity changed".to_string());
                    }
                    if expected_process_id.is_some_and(|expected| expected != window.process_id) {
                        return Err("UIA target process changed".to_string());
                    }
                    let root =
                        unsafe { automation.ElementFromHandle(parse_hwnd(&window.window_id)?) }
                            .map_err(|error| format!("UIA root lookup failed: {error}"))?;
                    let built = build_snapshot(
                        automation,
                        root,
                        window.app_id.clone(),
                        window.process_id,
                        window.window_id.clone(),
                    )?;
                    let id = session_id();
                    revision = revision.wrapping_add(1).max(1);
                    let window_graph = get_window_graph_impl(
                        window.app_id.clone(),
                        window.process_id,
                        window.window_id.clone(),
                    )?;
                    let result = AxSnapshotResult {
                        session_id: id.clone(),
                        app: Some(window.app_name),
                        total_visited: built.total_visited,
                        truncated: built.truncated,
                        focused_element_id: built.focused_element_id,
                        elements: built.session.public_elements.clone(),
                        window_id: built.session.window_id.clone(),
                        process_id: built.session.process_id,
                        accessibility_revision: revision,
                        input_epoch: built.session.input_epoch,
                        modal: built.modal,
                        modal_window_id: built.modal_window_id,
                        window_graph,
                    };
                    sessions.insert(id, built.session);
                    Ok(result)
                })();
                let _ = reply.send(result);
            }
            Command::Press {
                session_id,
                element_id,
                reply,
            } => {
                let result = (|| {
                    let (_, element) = get_session_element(&sessions, &session_id, element_id)?;
                    unsafe {
                        if let Ok(pattern) = element
                            .native
                            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        {
                            return pattern
                                .Invoke()
                                .map_err(|error| format!("UIA Invoke failed: {error}"));
                        }
                        if let Ok(pattern) = element
                            .native
                            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                                UIA_SelectionItemPatternId,
                            )
                        {
                            return pattern
                                .Select()
                                .map_err(|error| format!("UIA Select failed: {error}"));
                        }
                        element
                            .native
                            .SetFocus()
                            .map_err(|error| format!("UIA focus failed: {error}"))
                    }
                })();
                let _ = reply.send(result);
            }
            Command::SetValue {
                session_id,
                element_id,
                value,
                reply,
            } => {
                let result = (|| {
                    let (_, element) = get_session_element(&sessions, &session_id, element_id)?;
                    if let Ok(pattern) = unsafe {
                        element
                            .native
                            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    } {
                        if unsafe { pattern.CurrentIsReadOnly() }
                            .map_or(true, |value| value.as_bool())
                        {
                            return Err("UIA value is read-only".to_string());
                        }
                        return unsafe { pattern.SetValue(&BSTR::from(value)) }
                            .map_err(|error| format!("UIA SetValue failed: {error}"));
                    }
                    let numeric = value
                        .parse::<f64>()
                        .map_err(|_| "UIA RangeValue requires a numeric value".to_string())?;
                    let pattern = unsafe {
                        element
                            .native
                            .GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(
                                UIA_RangeValuePatternId,
                            )
                    }
                    .map_err(|_| {
                        "UIA element supports neither ValuePattern nor RangeValuePattern"
                            .to_string()
                    })?;
                    if unsafe { pattern.CurrentIsReadOnly() }.map_or(true, |value| value.as_bool())
                    {
                        return Err("UIA range value is read-only".to_string());
                    }
                    let minimum = unsafe { pattern.CurrentMinimum() }
                        .map_err(|error| format!("UIA range minimum unavailable: {error}"))?;
                    let maximum = unsafe { pattern.CurrentMaximum() }
                        .map_err(|error| format!("UIA range maximum unavailable: {error}"))?;
                    if !numeric.is_finite() || numeric < minimum || numeric > maximum {
                        return Err(format!(
                            "UIA range value must be between {minimum} and {maximum}"
                        ));
                    }
                    unsafe { pattern.SetValue(numeric) }
                        .map_err(|error| format!("UIA RangeValue failed: {error}"))
                })();
                let _ = reply.send(result);
            }
            Command::Perform {
                session_id,
                element_id,
                action,
                reply,
            } => {
                let result = (|| {
                    let (_, element) = get_session_element(&sessions, &session_id, element_id)?;
                    let action = action.trim().to_ascii_lowercase();
                    if action == "focus" {
                        let automation = automation.as_ref().map_err(Clone::clone)?;
                        unsafe { element.native.SetFocus() }
                            .map_err(|error| format!("UIA focus failed: {error}"))?;
                        let focused =
                            unsafe { automation.GetFocusedElement() }.map_err(|error| {
                                format!("UIA focused element check failed: {error}")
                            })?;
                        if !runtime_id_matches(
                            &element.runtime_id,
                            &runtime_id_for_validation(&focused),
                        ) {
                            return Err(
                                "UIA focus did not reach the requested element; input is blocked"
                                    .to_string(),
                            );
                        }
                        return Ok(());
                    }
                    unsafe {
                        match action.as_str() {
                            "invoke" | "axpress" | "press" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(
                                    UIA_InvokePatternId,
                                )
                                .map_err(|error| format!("UIA InvokePattern unavailable: {error}"))?
                                .Invoke(),
                            "toggle" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(
                                    UIA_TogglePatternId,
                                )
                                .map_err(|error| format!("UIA TogglePattern unavailable: {error}"))?
                                .Toggle(),
                            "select" | "axpick" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                                    UIA_SelectionItemPatternId,
                                )
                                .map_err(|error| {
                                    format!("UIA SelectionItemPattern unavailable: {error}")
                                })?
                                .Select(),
                            "expand" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                                    UIA_ExpandCollapsePatternId,
                                )
                                .map_err(|error| {
                                    format!("UIA ExpandCollapsePattern unavailable: {error}")
                                })?
                                .Expand(),
                            "collapse" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                                    UIA_ExpandCollapsePatternId,
                                )
                                .map_err(|error| {
                                    format!("UIA ExpandCollapsePattern unavailable: {error}")
                                })?
                                .Collapse(),
                            "scrollintoview" | "scroll_into_view" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(
                                    UIA_ScrollItemPatternId,
                                )
                                .map_err(|error| {
                                    format!("UIA ScrollItemPattern unavailable: {error}")
                                })?
                                .ScrollIntoView(),
                            "scrollup" | "scroll_up" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationScrollPattern>(
                                    UIA_ScrollPatternId,
                                )
                                .map_err(|error| format!("UIA ScrollPattern unavailable: {error}"))?
                                .Scroll(ScrollAmount_NoAmount, ScrollAmount_LargeDecrement),
                            "scrolldown" | "scroll_down" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationScrollPattern>(
                                    UIA_ScrollPatternId,
                                )
                                .map_err(|error| format!("UIA ScrollPattern unavailable: {error}"))?
                                .Scroll(ScrollAmount_NoAmount, ScrollAmount_LargeIncrement),
                            "scrollleft" | "scroll_left" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationScrollPattern>(
                                    UIA_ScrollPatternId,
                                )
                                .map_err(|error| format!("UIA ScrollPattern unavailable: {error}"))?
                                .Scroll(ScrollAmount_LargeDecrement, ScrollAmount_NoAmount),
                            "scrollright" | "scroll_right" => element
                                .native
                                .GetCurrentPatternAs::<IUIAutomationScrollPattern>(
                                    UIA_ScrollPatternId,
                                )
                                .map_err(|error| format!("UIA ScrollPattern unavailable: {error}"))?
                                .Scroll(ScrollAmount_LargeIncrement, ScrollAmount_NoAmount),
                            _ => return Err(format!("unsupported UIA action '{action}'")),
                        }
                    }
                    .map_err(|error| format!("UIA action failed: {error}"))
                })();
                let _ = reply.send(result);
            }
            Command::RestoreFocus { session_id, reply } => {
                let result = (|| {
                    let session = sessions
                        .get(&session_id)
                        .ok_or_else(|| "UIA session is unavailable; observe again".to_string())?;
                    let Some(element) = session.focused_element.as_ref() else {
                        return Ok(false);
                    };
                    validate_cached_element(session, element)?;
                    unsafe { element.native.SetFocus() }
                        .map_err(|error| format!("UIA focus restore failed: {error}"))?;
                    Ok(true)
                })();
                let _ = reply.send(result);
            }
            Command::Close { session_id, reply } => {
                sessions.remove(&session_id);
                let _ = reply.send(Ok(()));
            }
        }
    }
}

fn worker() -> &'static UiaWorker {
    WORKER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("abu-windows-uia".to_string())
            .spawn(move || run_worker(receiver))
            .expect("spawn Windows UIA worker");
        UiaWorker { sender }
    })
}

fn round_trip<T>(
    build: impl FnOnce(mpsc::Sender<Result<T, String>>) -> Command,
) -> Result<T, String> {
    let (reply, receive) = mpsc::channel();
    worker()
        .sender
        .send(build(reply))
        .map_err(|_| "Windows UIA worker stopped".to_string())?;
    receive
        .recv()
        .map_err(|_| "Windows UIA worker response was lost".to_string())?
}

pub fn ax_snapshot_impl(
    app_name: String,
    expected_app_id: Option<String>,
    expected_process_id: Option<u32>,
    expected_window_id: Option<String>,
) -> Result<AxSnapshotResult, String> {
    round_trip(|reply| Command::Snapshot {
        app_name,
        expected_app_id,
        expected_process_id,
        expected_window_id,
        reply,
    })
}

pub fn ax_press_impl(session_id: String, element_id: u32) -> Result<(), String> {
    round_trip(|reply| Command::Press {
        session_id,
        element_id,
        reply,
    })
}

pub fn ax_set_value_impl(session_id: String, element_id: u32, value: String) -> Result<(), String> {
    if value.encode_utf16().count() > 32_768 {
        return Err("UIA value exceeds the 32768 UTF-16 unit safety limit".to_string());
    }
    round_trip(|reply| Command::SetValue {
        session_id,
        element_id,
        value,
        reply,
    })
}

pub fn ax_perform_action_impl(
    session_id: String,
    element_id: u32,
    action: String,
) -> Result<(), String> {
    round_trip(|reply| Command::Perform {
        session_id,
        element_id,
        action,
        reply,
    })
}

pub fn ax_restore_focus_impl(session_id: String) -> Result<bool, String> {
    round_trip(|reply| Command::RestoreFocus { session_id, reply })
}

pub fn ax_close_session_impl(session_id: String) {
    let _ = round_trip(|reply| Command::Close { session_id, reply });
}

#[cfg(test)]
mod tests {
    use super::runtime_id_matches;

    #[test]
    fn runtime_id_validation_rejects_empty_or_changed_elements() {
        assert!(runtime_id_matches(&[42, 7, -1], &[42, 7, -1]));
        assert!(!runtime_id_matches(&[], &[]));
        assert!(!runtime_id_matches(&[42, 7], &[42, 8]));
    }
}
