use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW,
    HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
    WH_MOUSE_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

const ABU_INJECTED_INPUT_MARKER: usize = 0x4142_5543_5553_4532;
static INPUT_EPOCH: AtomicU64 = AtomicU64::new(1);
static READY: AtomicBool = AtomicBool::new(false);
static USER_INPUT_EVENT_PENDING: AtomicBool = AtomicBool::new(false);
static EVENT_SENDER: OnceLock<mpsc::Sender<&'static str>> = OnceLock::new();
static INPUT_LEASE: OnceLock<Mutex<InputLease>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LeasePhase {
    Idle,
    Observing,
    Running,
    PausedForConsent,
}

#[derive(Debug)]
struct InputLease {
    id: Option<String>,
    phase: LeasePhase,
    resume_phase: LeasePhase,
    consent_owner_process_id: Option<u32>,
    dirty: bool,
}

impl Default for InputLease {
    fn default() -> Self {
        Self {
            id: None,
            phase: LeasePhase::Idle,
            resume_phase: LeasePhase::Idle,
            consent_owner_process_id: None,
            dirty: false,
        }
    }
}

impl InputLease {
    fn classify_physical_input(&mut self, foreground_pid: Option<u32>) -> PhysicalInputDecision {
        match self.phase {
            LeasePhase::Idle => PhysicalInputDecision::Ignore,
            LeasePhase::Observing => {
                self.dirty = true;
                PhysicalInputDecision::RecordOnly
            }
            LeasePhase::Running => PhysicalInputDecision::Publish,
            LeasePhase::PausedForConsent => {
                if foreground_pid.is_some() && foreground_pid == self.consent_owner_process_id {
                    PhysicalInputDecision::Ignore
                } else {
                    self.dirty = true;
                    PhysicalInputDecision::RecordOnly
                }
            }
        }
    }
}

fn input_lease() -> &'static Mutex<InputLease> {
    INPUT_LEASE.get_or_init(|| Mutex::new(InputLease::default()))
}

fn require_lease(lease: &InputLease, lease_id: &str) -> Result<(), String> {
    if lease.id.as_deref() != Some(lease_id) || lease.phase == LeasePhase::Idle {
        return Err("Computer Use input lease is stale or inactive".to_string());
    }
    Ok(())
}

pub fn input_epoch() -> u64 {
    INPUT_EPOCH.load(Ordering::Acquire)
}

pub fn input_monitoring_ready() -> bool {
    READY.load(Ordering::Acquire)
}

pub fn input_lease_running() -> bool {
    input_lease()
        .lock()
        .map(|lease| lease.phase == LeasePhase::Running)
        .unwrap_or(false)
}

pub fn begin_input_lease(lease_id: &str) -> Result<u64, String> {
    if lease_id.is_empty() || lease_id.len() > 256 {
        return Err("Computer Use input lease id is invalid".to_string());
    }
    if !initialize_input_monitoring() {
        return Err("physical input monitoring is unavailable; input is blocked".to_string());
    }
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    if lease.phase != LeasePhase::Idle && lease.id.as_deref() != Some(lease_id) {
        return Err("another Computer Use input lease is already active".to_string());
    }
    lease.id = Some(lease_id.to_string());
    lease.phase = LeasePhase::Observing;
    lease.resume_phase = LeasePhase::Observing;
    lease.consent_owner_process_id = None;
    lease.dirty = false;
    Ok(input_epoch())
}

/// Starts an observation boundary. Physical input is recorded but cannot be
/// mistaken for takeover until the Host activates this exact observed epoch.
pub fn begin_input_observation() {
    if let Ok(mut lease) = input_lease().lock() {
        if lease.phase != LeasePhase::Idle && lease.phase != LeasePhase::PausedForConsent {
            lease.phase = LeasePhase::Observing;
            lease.resume_phase = LeasePhase::Observing;
            lease.dirty = false;
        }
    }
}

pub fn activate_input_lease(lease_id: &str, expected_epoch: u64) -> Result<u64, String> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    require_lease(&lease, lease_id)?;
    if lease.phase == LeasePhase::PausedForConsent {
        return Err("Computer Use input lease is paused for consent".to_string());
    }
    let current_epoch = input_epoch();
    if lease.dirty || current_epoch != expected_epoch {
        lease.phase = LeasePhase::Observing;
        return Err("physical user input occurred during observation; observe again".to_string());
    }
    lease.phase = LeasePhase::Running;
    lease.resume_phase = LeasePhase::Running;
    Ok(current_epoch)
}

/// Commits a completed observation without arming takeover detection. Physical
/// input after this point invalidates the observation epoch, but does not abort
/// the whole agent run while the model is merely thinking or using other tools.
pub fn commit_input_observation(lease_id: &str, expected_epoch: u64) -> Result<u64, String> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    require_lease(&lease, lease_id)?;
    if lease.phase == LeasePhase::PausedForConsent {
        return Err("Computer Use input lease is paused for consent".to_string());
    }
    let current_epoch = input_epoch();
    if lease.dirty || current_epoch != expected_epoch {
        lease.phase = LeasePhase::Observing;
        lease.resume_phase = LeasePhase::Observing;
        return Err("physical user input occurred during observation; observe again".to_string());
    }
    lease.phase = LeasePhase::Observing;
    lease.resume_phase = LeasePhase::Observing;
    lease.dirty = false;
    Ok(current_epoch)
}

/// Leaves the short native-action critical section. Subsequent physical input
/// invalidates state but is not published as takeover until the Host activates
/// the lease again immediately before another native write.
pub fn observe_input_lease(lease_id: &str) -> Result<u64, String> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    require_lease(&lease, lease_id)?;
    lease.phase = LeasePhase::Observing;
    lease.resume_phase = LeasePhase::Observing;
    lease.consent_owner_process_id = None;
    lease.dirty = false;
    Ok(input_epoch())
}

pub fn pause_input_lease(lease_id: &str, consent_owner_process_id: u32) -> Result<u64, String> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    require_lease(&lease, lease_id)?;
    if lease.phase != LeasePhase::PausedForConsent {
        lease.resume_phase = lease.phase;
    }
    lease.phase = LeasePhase::PausedForConsent;
    lease.consent_owner_process_id = Some(consent_owner_process_id);
    lease.dirty = false;
    Ok(input_epoch())
}

pub fn resume_input_lease(lease_id: &str) -> Result<(bool, u64), String> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    require_lease(&lease, lease_id)?;
    if lease.phase != LeasePhase::PausedForConsent {
        return Err("Computer Use input lease is not paused for consent".to_string());
    }
    let dirty = lease.dirty;
    lease.phase = if dirty {
        LeasePhase::Observing
    } else {
        lease.resume_phase
    };
    lease.consent_owner_process_id = None;
    lease.dirty = false;
    Ok((dirty, input_epoch()))
}

pub fn end_input_lease(lease_id: &str) -> Result<(), String> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| "Computer Use input lease is unavailable".to_string())?;
    require_lease(&lease, lease_id)?;
    *lease = InputLease::default();
    Ok(())
}

fn foreground_process_id() -> Option<u32> {
    let window = unsafe { GetForegroundWindow() };
    if window.0.is_null() {
        return None;
    }
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    (process_id != 0).then_some(process_id)
}

#[derive(Debug, PartialEq, Eq)]
enum PhysicalInputDecision {
    Ignore,
    RecordOnly,
    Publish,
}

fn classify_physical_input(foreground_pid: Option<u32>) -> PhysicalInputDecision {
    let Ok(mut lease) = input_lease().lock() else {
        return PhysicalInputDecision::Publish;
    };
    lease.classify_physical_input(foreground_pid)
}

fn note_physical_input(interrupted: bool) {
    let decision = classify_physical_input(foreground_process_id());
    if matches!(decision, PhysicalInputDecision::Ignore) {
        return;
    }
    INPUT_EPOCH.fetch_add(1, Ordering::AcqRel);
    if matches!(decision, PhysicalInputDecision::RecordOnly) {
        return;
    }

    // Release any button Abu is holding before publishing the event. The Host
    // terminates the Helper on takeover, so cleanup must win that race.
    let _ = super::input::release_held_inputs();
    if let Some(sender) = EVENT_SENDER.get() {
        if interrupted {
            let _ = sender.send("user-interrupted");
        } else if !USER_INPUT_EVENT_PENDING.swap(true, Ordering::AcqRel) {
            let _ = sender.send("user-input-detected");
        }
    }
}

fn is_physical_keyboard_event(event: &KBDLLHOOKSTRUCT) -> bool {
    !event.flags.contains(LLKHF_INJECTED) && event.dwExtraInfo != ABU_INJECTED_INPUT_MARKER
}

fn is_physical_mouse_event(event: &MSLLHOOKSTRUCT) -> bool {
    event.flags & LLMHF_INJECTED == 0 && event.dwExtraInfo != ABU_INJECTED_INPUT_MARKER
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
        let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if is_physical_keyboard_event(event) {
            note_physical_input(event.vkCode == VK_ESCAPE.0 as u32);
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        if is_physical_mouse_event(event) {
            note_physical_input(false);
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub fn initialize_input_monitoring() -> bool {
    if input_monitoring_ready() {
        return true;
    }
    let (events, receiver) = mpsc::channel();
    let _ = EVENT_SENDER.set(events);
    thread::Builder::new()
        .name("abu-input-events".to_string())
        .spawn(move || {
            while let Ok(event) = receiver.recv() {
                crate::emit_helper_event(event, "physical-input");
                if event == "user-input-detected" {
                    USER_INPUT_EVENT_PENDING.store(false, Ordering::Release);
                }
            }
        })
        .ok();
    let (started, ready) = mpsc::sync_channel(1);
    if thread::Builder::new()
        .name("abu-input-monitor".to_string())
        .spawn(move || {
            let keyboard = unsafe {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), HINSTANCE::default(), 0)
            };
            let mouse = unsafe {
                SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), HINSTANCE::default(), 0)
            };
            let ok = keyboard.is_ok() && mouse.is_ok();
            READY.store(ok, Ordering::Release);
            let _ = started.send(ok);
            if !ok {
                return;
            }
            let mut message = MSG::default();
            while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {}
        })
        .is_err()
    {
        return false;
    }
    ready.recv().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_injected_and_abu_marked_keyboard_input() {
        let mut event = KBDLLHOOKSTRUCT::default();
        assert!(is_physical_keyboard_event(&event));
        event.flags = LLKHF_INJECTED;
        assert!(!is_physical_keyboard_event(&event));
        event.flags = Default::default();
        event.dwExtraInfo = ABU_INJECTED_INPUT_MARKER;
        assert!(!is_physical_keyboard_event(&event));
    }

    #[test]
    fn ignores_injected_and_abu_marked_mouse_input() {
        let mut event = MSLLHOOKSTRUCT::default();
        assert!(is_physical_mouse_event(&event));
        event.flags = LLMHF_INJECTED;
        assert!(!is_physical_mouse_event(&event));
        event.flags = 0;
        event.dwExtraInfo = ABU_INJECTED_INPUT_MARKER;
        assert!(!is_physical_mouse_event(&event));
    }

    #[test]
    fn lease_rejects_stale_id_and_idle_state() {
        let mut lease = InputLease {
            id: Some("lease-a".to_string()),
            phase: LeasePhase::Observing,
            resume_phase: LeasePhase::Observing,
            consent_owner_process_id: None,
            dirty: false,
        };
        assert!(require_lease(&lease, "lease-a").is_ok());
        assert!(require_lease(&lease, "lease-b").is_err());
        lease.phase = LeasePhase::Idle;
        assert!(require_lease(&lease, "lease-a").is_err());
    }

    #[test]
    fn consent_owner_input_is_ignored_but_external_input_dirties_the_lease() {
        let mut lease = InputLease {
            id: Some("lease-a".to_string()),
            phase: LeasePhase::PausedForConsent,
            resume_phase: LeasePhase::Running,
            consent_owner_process_id: Some(42),
            dirty: false,
        };
        assert_eq!(
            lease.classify_physical_input(Some(42)),
            PhysicalInputDecision::Ignore,
        );
        assert!(!lease.dirty);
        assert_eq!(
            lease.classify_physical_input(Some(99)),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
    }

    #[test]
    fn only_running_lease_publishes_takeover() {
        let mut lease = InputLease::default();
        assert_eq!(
            lease.classify_physical_input(Some(99)),
            PhysicalInputDecision::Ignore,
        );
        lease.phase = LeasePhase::Observing;
        assert_eq!(
            lease.classify_physical_input(Some(99)),
            PhysicalInputDecision::RecordOnly,
        );
        lease.phase = LeasePhase::Running;
        assert_eq!(
            lease.classify_physical_input(Some(99)),
            PhysicalInputDecision::Publish,
        );
    }

    #[test]
    fn committed_observation_stays_non_takeover_until_a_native_action_runs() {
        let mut lease = InputLease {
            id: Some("lease-a".to_string()),
            phase: LeasePhase::Observing,
            resume_phase: LeasePhase::Observing,
            consent_owner_process_id: None,
            dirty: false,
        };
        assert_eq!(
            lease.classify_physical_input(Some(99)),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
        lease.dirty = false;
        lease.phase = LeasePhase::Running;
        assert_eq!(
            lease.classify_physical_input(Some(99)),
            PhysicalInputDecision::Publish,
        );
    }
}
