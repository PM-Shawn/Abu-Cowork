use crate::error::HelperError;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetAncestor, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    SetWindowsHookExW, WindowFromPoint, GA_ROOT, HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED,
    LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_MOUSEMOVE,
    WM_SYSKEYDOWN,
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

/// What a physical input event can do to the target, which is not the same as
/// whether the user touched the hardware. A button, wheel or key press can
/// change what is on screen; moving the pointer cannot. The distinction only
/// matters outside `Running`: between actions, and while a consent dialog is
/// open, a bare move must not invalidate the observation the model is about to
/// act on, or the approval the user is reaching across the screen to click.
/// While Abu is actually sending input, every kind still hands control back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PhysicalInputKind {
    /// Button, wheel or key: may change the target's state.
    StateChanging,
    /// Pointer movement with no button held and no wheel.
    PointerMove,
}

#[derive(Debug)]
struct InputLease {
    id: Option<String>,
    phase: LeasePhase,
    resume_phase: LeasePhase,
    consent_owner_process_id: Option<u32>,
    dirty: bool,
    /// Set when a consent pause resumes. The user has just taken their hand
    /// off Abu's own dialog and the pointer is still travelling away from it;
    /// that movement is the tail of the gesture that authorized the action,
    /// not someone grabbing the wheel. Cleared by the first thing they
    /// actually press, and by every phase change that starts fresh.
    pointer_settling_after_consent: bool,
}

impl Default for InputLease {
    fn default() -> Self {
        Self {
            id: None,
            phase: LeasePhase::Idle,
            resume_phase: LeasePhase::Idle,
            consent_owner_process_id: None,
            dirty: false,
            pointer_settling_after_consent: false,
        }
    }
}

impl InputLease {
    /// `interrupted` is the user's explicit stop (ESC). Ordinary input only
    /// counts as a takeover while Abu is actually sending input (`Running`);
    /// between actions it merely dirties the observation. ESC stops in every
    /// phase except when the consent dialog itself has the keyboard — there it
    /// is the dialog's own cancel. Bare pointer movement is ignored outside
    /// `Running`: it changes nothing the model could act on, and treating it
    /// as state change made a hand resting on the mouse abort every
    /// observation, and made reaching for the consent dialog discard the very
    /// action it had just approved.
    ///
    /// `addressed_pid` is the process the event is actually going to: the
    /// window under the pointer for a button or wheel, the foreground process
    /// for a key. The two differ for exactly the event that matters here — the
    /// click that activates the consent dialog. Windows delivers it to the
    /// low-level hook *before* it changes the foreground window, so judging it
    /// by `foreground_pid` alone blamed it on whatever app Abu had just
    /// brought forward, and the approval the user had just granted came back
    /// as "physical user input changed another app during approval".
    fn classify_physical_input(
        &mut self,
        foreground_pid: Option<u32>,
        addressed_pid: Option<u32>,
        kind: PhysicalInputKind,
        interrupted: bool,
    ) -> PhysicalInputDecision {
        let dirty_or_stop = |lease: &mut Self| {
            lease.dirty = true;
            if interrupted {
                PhysicalInputDecision::Publish
            } else {
                PhysicalInputDecision::RecordOnly
            }
        };
        // ESC always arrives from the keyboard, so it is always state changing
        // and can never be filtered out here.
        let moved_only = kind == PhysicalInputKind::PointerMove;
        match self.phase {
            LeasePhase::Idle => PhysicalInputDecision::Ignore,
            LeasePhase::Observing if moved_only => PhysicalInputDecision::Ignore,
            LeasePhase::Observing => dirty_or_stop(self),
            LeasePhase::Running if moved_only && self.pointer_settling_after_consent => {
                PhysicalInputDecision::Ignore
            }
            LeasePhase::Running => {
                self.pointer_settling_after_consent = false;
                PhysicalInputDecision::Publish
            }
            LeasePhase::PausedForConsent => {
                let owner = self.consent_owner_process_id;
                let answers_the_dialog = owner.is_some()
                    && (foreground_pid == owner || addressed_pid == owner);
                if answers_the_dialog || moved_only {
                    PhysicalInputDecision::Ignore
                } else {
                    dirty_or_stop(self)
                }
            }
        }
    }
}

fn input_lease() -> &'static Mutex<InputLease> {
    INPUT_LEASE.get_or_init(|| Mutex::new(InputLease::default()))
}

fn require_lease(lease: &InputLease, lease_id: &str) -> Result<(), HelperError> {
    if lease.id.as_deref() != Some(lease_id) || lease.phase == LeasePhase::Idle {
        return Err(HelperError::not_executed("input-lease", "Computer Use input lease is stale or inactive"));
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

pub fn begin_input_lease(lease_id: &str) -> Result<u64, HelperError> {
    if lease_id.is_empty() || lease_id.len() > 256 {
        return Err(HelperError::not_executed("invalid-params", "Computer Use input lease id is invalid"));
    }
    if !initialize_input_monitoring() {
        return Err(HelperError::not_executed("input-lease", "physical input monitoring is unavailable; input is blocked"));
    }
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
    if lease.phase != LeasePhase::Idle && lease.id.as_deref() != Some(lease_id) {
        return Err(HelperError::not_executed("input-lease", "another Computer Use input lease is already active"));
    }
    lease.id = Some(lease_id.to_string());
    lease.phase = LeasePhase::Observing;
    lease.resume_phase = LeasePhase::Observing;
    lease.consent_owner_process_id = None;
    lease.dirty = false;
    lease.pointer_settling_after_consent = false;
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

pub fn activate_input_lease(lease_id: &str, expected_epoch: u64) -> Result<u64, HelperError> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
    require_lease(&lease, lease_id)?;
    if lease.phase == LeasePhase::PausedForConsent {
        return Err(HelperError::not_executed("input-lease", "Computer Use input lease is paused for consent"));
    }
    let current_epoch = input_epoch();
    if lease.dirty || current_epoch != expected_epoch {
        lease.phase = LeasePhase::Observing;
        return Err(HelperError::observe_again("physical-input", "physical user input occurred during observation; observe again"));
    }
    lease.phase = LeasePhase::Running;
    lease.resume_phase = LeasePhase::Running;
    Ok(current_epoch)
}

/// Commits a completed observation without arming takeover detection. Physical
/// input after this point invalidates the observation epoch, but does not abort
/// the whole agent run while the model is merely thinking or using other tools.
pub fn commit_input_observation(lease_id: &str, expected_epoch: u64) -> Result<u64, HelperError> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
    require_lease(&lease, lease_id)?;
    if lease.phase == LeasePhase::PausedForConsent {
        return Err(HelperError::not_executed("input-lease", "Computer Use input lease is paused for consent"));
    }
    let current_epoch = input_epoch();
    if lease.dirty || current_epoch != expected_epoch {
        lease.phase = LeasePhase::Observing;
        lease.resume_phase = LeasePhase::Observing;
        return Err(HelperError::observe_again("physical-input", "physical user input occurred during observation; observe again"));
    }
    lease.phase = LeasePhase::Observing;
    lease.resume_phase = LeasePhase::Observing;
    lease.dirty = false;
    Ok(current_epoch)
}

/// Leaves the short native-action critical section. Subsequent physical input
/// invalidates state but is not published as takeover until the Host activates
/// the lease again immediately before another native write.
pub fn observe_input_lease(lease_id: &str) -> Result<u64, HelperError> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
    require_lease(&lease, lease_id)?;
    lease.phase = LeasePhase::Observing;
    lease.resume_phase = LeasePhase::Observing;
    lease.consent_owner_process_id = None;
    lease.dirty = false;
    Ok(input_epoch())
}

pub fn pause_input_lease(lease_id: &str, consent_owner_process_id: u32) -> Result<u64, HelperError> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
    require_lease(&lease, lease_id)?;
    if lease.phase != LeasePhase::PausedForConsent {
        lease.resume_phase = lease.phase;
    }
    lease.phase = LeasePhase::PausedForConsent;
    lease.consent_owner_process_id = Some(consent_owner_process_id);
    lease.dirty = false;
    Ok(input_epoch())
}

pub fn resume_input_lease(lease_id: &str) -> Result<(bool, u64), HelperError> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
    require_lease(&lease, lease_id)?;
    if lease.phase != LeasePhase::PausedForConsent {
        return Err(HelperError::not_executed("input-lease", "Computer Use input lease is not paused for consent"));
    }
    let dirty = lease.dirty;
    lease.phase = if dirty {
        LeasePhase::Observing
    } else {
        lease.resume_phase
    };
    lease.consent_owner_process_id = None;
    lease.dirty = false;
    lease.pointer_settling_after_consent = true;
    Ok((dirty, input_epoch()))
}

pub fn end_input_lease(lease_id: &str) -> Result<(), HelperError> {
    let mut lease = input_lease()
        .lock()
        .map_err(|_| HelperError::not_executed("input-lease", "Computer Use input lease is unavailable"))?;
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

fn classify_physical_input(
    foreground_pid: Option<u32>,
    addressed_pid: Option<u32>,
    kind: PhysicalInputKind,
    interrupted: bool,
) -> PhysicalInputDecision {
    let Ok(mut lease) = input_lease().lock() else {
        return PhysicalInputDecision::Publish;
    };
    lease.classify_physical_input(foreground_pid, addressed_pid, kind, interrupted)
}

/// The process owning the top-level window under a screen point. Only called
/// for buttons and wheel ticks: a low-level hook runs on every pointer move
/// and has a Windows-imposed time budget, so the cross-process hit test stays
/// off that path.
fn window_process_id_at(point: POINT) -> Option<u32> {
    let hit = unsafe { WindowFromPoint(point) };
    if hit.0.is_null() {
        return None;
    }
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    let window = if root.0.is_null() { hit } else { root };
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) };
    (process_id != 0).then_some(process_id)
}

fn note_physical_input(kind: PhysicalInputKind, interrupted: bool, addressed_pid: Option<u32>) {
    let foreground_pid = foreground_process_id();
    let decision = classify_physical_input(
        foreground_pid,
        addressed_pid.or(foreground_pid),
        kind,
        interrupted,
    );
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

/// `WH_MOUSE_LL` delivers movement as its own message, separate from every
/// button and wheel message. Only movement is harmless to an observation.
fn mouse_input_kind(message: u32) -> PhysicalInputKind {
    if message == WM_MOUSEMOVE {
        PhysicalInputKind::PointerMove
    } else {
        PhysicalInputKind::StateChanging
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && (wparam.0 as u32 == WM_KEYDOWN || wparam.0 as u32 == WM_SYSKEYDOWN) {
        let event = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if is_physical_keyboard_event(event) {
            note_physical_input(
                PhysicalInputKind::StateChanging,
                event.vkCode == VK_ESCAPE.0 as u32,
                None,
            );
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let event = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        if is_physical_mouse_event(event) {
            let kind = mouse_input_kind(wparam.0 as u32);
            let addressed_pid = match kind {
                PhysicalInputKind::StateChanging => window_process_id_at(event.pt),
                PhysicalInputKind::PointerMove => None,
            };
            note_physical_input(kind, false, addressed_pid);
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
            pointer_settling_after_consent: false,
        };
        assert!(require_lease(&lease, "lease-a").is_ok());
        assert!(require_lease(&lease, "lease-b").is_err());
        lease.phase = LeasePhase::Idle;
        assert!(require_lease(&lease, "lease-a").is_err());
    }

    /// The click that activates the consent dialog reaches the low-level hook
    /// while the app Abu just brought forward is still the foreground window.
    /// Judging it by the foreground alone reported the user's own approval as
    /// a foreign takeover and threw the approved action away.
    #[test]
    fn the_click_that_answers_the_consent_dialog_is_not_a_takeover() {
        let mut lease = InputLease {
            id: Some("lease-a".to_string()),
            phase: LeasePhase::PausedForConsent,
            resume_phase: LeasePhase::Running,
            consent_owner_process_id: Some(42),
            dirty: false,
            pointer_settling_after_consent: false,
        };
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(42), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::Ignore,
        );
        assert!(!lease.dirty);
        // A click that lands on neither the dialog nor the foreground is still
        // the user going somewhere else.
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(77), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
    }

    /// A lease with no consent owner recorded must not treat an unknown
    /// window (`None`) as the dialog.
    #[test]
    fn unknown_input_target_is_not_mistaken_for_an_absent_consent_owner() {
        let mut lease = InputLease {
            id: Some("lease-a".to_string()),
            phase: LeasePhase::PausedForConsent,
            resume_phase: LeasePhase::Running,
            consent_owner_process_id: None,
            dirty: false,
            pointer_settling_after_consent: false,
        };
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
    }

    #[test]
    fn consent_owner_input_is_ignored_but_external_input_dirties_the_lease() {
        let mut lease = InputLease {
            id: Some("lease-a".to_string()),
            phase: LeasePhase::PausedForConsent,
            resume_phase: LeasePhase::Running,
            consent_owner_process_id: Some(42),
            dirty: false,
            pointer_settling_after_consent: false,
        };
        assert_eq!(
            lease.classify_physical_input(Some(42), Some(42), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::Ignore,
        );
        assert!(!lease.dirty);
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
    }

    fn lease_in(phase: LeasePhase) -> InputLease {
        InputLease {
            id: Some("lease-a".to_string()),
            phase,
            resume_phase: phase,
            consent_owner_process_id: None,
            dirty: false,
            pointer_settling_after_consent: false,
        }
    }

    #[test]
    fn only_movement_messages_are_treated_as_harmless_pointer_motion() {
        assert_eq!(mouse_input_kind(WM_MOUSEMOVE), PhysicalInputKind::PointerMove);
        // Every other WH_MOUSE_LL message is a button or a wheel.
        for message in [0x0201u32, 0x0202, 0x0204, 0x0205, 0x0207, 0x0208, 0x020A, 0x020B, 0x020E] {
            assert_eq!(
                mouse_input_kind(message),
                PhysicalInputKind::StateChanging,
                "message {message:#06x} must count as state changing",
            );
        }
    }

    #[test]
    fn a_hand_resting_on_the_mouse_does_not_invalidate_an_observation() {
        let mut lease = lease_in(LeasePhase::Observing);
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::PointerMove, false),
            PhysicalInputDecision::Ignore,
        );
        assert!(!lease.dirty, "a bare move changes nothing the model could act on");

        // A click during the same phase still invalidates it.
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
    }

    #[test]
    fn reaching_for_the_consent_dialog_does_not_discard_the_approved_action() {
        // The pointer crosses the target app on its way to the dialog, so the
        // foreground is not yet the consent owner when the moves arrive.
        let mut lease = InputLease {
            consent_owner_process_id: Some(42),
            ..lease_in(LeasePhase::PausedForConsent)
        };
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::PointerMove, false),
            PhysicalInputDecision::Ignore,
        );
        assert!(!lease.dirty, "the approval the user is reaching for must survive the reach");

        // Clicking a different app while the dialog waits is a real change.
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
    }

    /// Measured 2026-09-15: approving a QQ send killed the send. The click on
    /// the dialog is ignored, but the lease then activates and the hand still
    /// travelling away from the dialog lands in `Running`, where every kind of
    /// input — movement included — published a takeover. So a consequential
    /// action approved with the mouse could not complete at all.
    #[test]
    fn the_hand_leaving_the_consent_dialog_does_not_abort_the_action_it_approved() {
        let mut lease = lease_in(LeasePhase::Running);
        lease.pointer_settling_after_consent = true;
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::PointerMove, false),
            PhysicalInputDecision::Ignore,
        );
        // Still travelling: the exemption is not spent by one event.
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::PointerMove, false),
            PhysicalInputDecision::Ignore,
        );
    }

    /// The exemption covers movement only. Anything the user actually presses
    /// while Abu is mid-action is still a takeover, which is what the safety
    /// case tests.
    #[test]
    fn pressing_something_after_consent_still_hands_control_back() {
        let mut lease = lease_in(LeasePhase::Running);
        lease.pointer_settling_after_consent = true;
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::Publish,
        );
        assert!(!lease.pointer_settling_after_consent, "spent by the first press");
        // And once spent, movement is a takeover again.
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::PointerMove, false),
            PhysicalInputDecision::Publish,
        );
    }

    /// ESC is state changing, so it stops even while the pointer is settling.
    #[test]
    fn escape_still_stops_while_the_pointer_is_settling() {
        let mut lease = lease_in(LeasePhase::Running);
        lease.pointer_settling_after_consent = true;
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::StateChanging, true),
            PhysicalInputDecision::Publish,
        );
    }

    #[test]
    fn moving_the_mouse_still_hands_control_back_while_abu_is_typing() {
        let mut lease = lease_in(LeasePhase::Running);
        assert_eq!(
            lease.classify_physical_input(None, None, PhysicalInputKind::PointerMove, false),
            PhysicalInputDecision::Publish,
        );
    }

    #[test]
    fn escape_still_stops_every_phase_it_used_to() {
        for phase in [LeasePhase::Observing, LeasePhase::Running] {
            let mut lease = lease_in(phase);
            assert_eq!(
                lease.classify_physical_input(None, None, PhysicalInputKind::StateChanging, true),
                PhysicalInputDecision::Publish,
                "ESC must stop in {phase:?}",
            );
        }
    }

    #[test]
    fn only_running_lease_publishes_takeover() {
        let mut lease = InputLease::default();
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::Ignore,
        );
        lease.phase = LeasePhase::Observing;
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        lease.phase = LeasePhase::Running;
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
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
            pointer_settling_after_consent: false,
        };
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::RecordOnly,
        );
        assert!(lease.dirty);
        lease.dirty = false;
        lease.phase = LeasePhase::Running;
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, false),
            PhysicalInputDecision::Publish,
        );
    }

    #[test]
    fn escape_stops_in_every_phase_except_inside_the_consent_dialog() {
        let mut lease = InputLease::default();
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, true),
            PhysicalInputDecision::Ignore,
        );
        lease.phase = LeasePhase::Observing;
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, true),
            PhysicalInputDecision::Publish,
        );
        assert!(lease.dirty);
        lease.phase = LeasePhase::Running;
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, true),
            PhysicalInputDecision::Publish,
        );
        lease.phase = LeasePhase::PausedForConsent;
        lease.consent_owner_process_id = Some(42);
        assert_eq!(
            lease.classify_physical_input(Some(42), Some(42), PhysicalInputKind::StateChanging, true),
            PhysicalInputDecision::Ignore,
        );
        assert_eq!(
            lease.classify_physical_input(Some(99), Some(99), PhysicalInputKind::StateChanging, true),
            PhysicalInputDecision::Publish,
        );
    }
}
