use crate::error::HelperError;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HANDLE, POINT};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
    DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyboardLayout, SendInput, VkKeyScanExW, INPUT, INPUT_0, INPUT_KEYBOARD,
    INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_HOME,
    VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_RWIN, VK_SHIFT, VK_SPACE, VK_V,
    VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetSystemMetrics, GetWindowThreadProcessId, WindowFromPoint, GA_ROOT,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::screenshot::get_screenshot_ref;
use super::window::{frontmost_app_identity_impl, hwnd_id, inspect_window};

const ABU_INJECTED_INPUT_MARKER: usize = 0x4142_5543_5553_4532;
static ABU_LEFT_BUTTON_HELD: AtomicBool = AtomicBool::new(false);
static HELD_INPUT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn send(inputs: &[INPUT]) -> Result<(), HelperError> {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        let message = format!(
            "SendInput was blocked after {sent}/{} events (possible UIPI restriction)",
            inputs.len()
        );
        // Nothing injected is a plain refusal; anything injected means the
        // target may have seen part of the batch.
        return Err(if sent == 0 {
            HelperError::not_executed("send-input-failed", message)
        } else {
            HelperError::outcome_unknown("send-input-failed", message)
        });
    }
    Ok(())
}

fn held_input_lock() -> &'static Mutex<()> {
    HELD_INPUT_LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn release_held_inputs() -> Result<(), HelperError> {
    let _guard = held_input_lock()
        .lock()
        .map_err(|_| HelperError::preflight("held input state is unavailable"))?;
    if ABU_LEFT_BUTTON_HELD.swap(false, Ordering::AcqRel) {
        send(&[mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP)])?;
    }
    Ok(())
}

fn input_desktop_is_default() -> Result<(), HelperError> {
    let desktop = unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) }
        .map_err(|_| HelperError::not_executed("secure-desktop", "input desktop is unavailable (locked or secure desktop)"))?;
    let desktop_handle = HANDLE(desktop.0);
    let result = (|| {
        let mut required = 0u32;
        let _ = unsafe {
            GetUserObjectInformationW(desktop_handle, UOI_NAME, None, 0, Some(&mut required))
        };
        if required < 2 || required > 65_536 {
            return Err(HelperError::not_executed("secure-desktop", "input desktop identity is unavailable"));
        }
        let mut buffer = vec![0u16; required.div_ceil(2) as usize];
        unsafe {
            GetUserObjectInformationW(
                desktop_handle,
                UOI_NAME,
                Some(buffer.as_mut_ptr().cast()),
                required,
                Some(&mut required),
            )
        }
        .map_err(|error| HelperError::preflight(format!("input desktop identity failed: {error}")))?;
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        let name = String::from_utf16_lossy(&buffer[..end]);
        if !name.eq_ignore_ascii_case("default") {
            return Err(HelperError::not_executed("secure-desktop", format!("input is blocked on secure desktop '{name}'")));
        }
        Ok(())
    })();
    let _ = unsafe { CloseDesktop(desktop) };
    result
}

fn integrity_level(process_id: u32) -> Result<u32, HelperError> {
    let is_current = process_id == unsafe { GetCurrentProcessId() };
    let process = if is_current {
        unsafe { GetCurrentProcess() }
    } else {
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
            .map_err(|error| HelperError::preflight(format!("OpenProcess({process_id}) for integrity failed: {error}")))?
    };
    let mut token = HANDLE::default();
    let result = (|| {
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .map_err(|error| HelperError::preflight(format!("OpenProcessToken({process_id}) failed: {error}")))?;
        let mut required = 0u32;
        let _ = unsafe { GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut required) };
        if required < size_of::<TOKEN_MANDATORY_LABEL>() as u32 || required > 65_536 {
            return Err(HelperError::preflight("process integrity information is unavailable"));
        }
        let mut buffer = vec![0u8; required as usize];
        unsafe {
            GetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(buffer.as_mut_ptr().cast()),
                required,
                &mut required,
            )
        }
        .map_err(|error| HelperError::preflight(format!("GetTokenInformation({process_id}) failed: {error}")))?;
        let label = unsafe { &*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL) };
        let count = unsafe { *GetSidSubAuthorityCount(label.Label.Sid) } as u32;
        if count == 0 {
            return Err(HelperError::preflight("process integrity SID is invalid"));
        }
        Ok(unsafe { *GetSidSubAuthority(label.Label.Sid, count - 1) })
    })();
    if !token.is_invalid() {
        let _ = unsafe { CloseHandle(token) };
    }
    if !is_current {
        let _ = unsafe { CloseHandle(process) };
    }
    result
}

fn assert_integrity(target_process_id: u32) -> Result<(), HelperError> {
    let current = integrity_level(unsafe { GetCurrentProcessId() })?;
    let target = integrity_level(target_process_id)?;
    if !integrity_allows(current, target) {
        return Err(HelperError::not_executed("higher-integrity", "target has higher Windows integrity; input is blocked by UIPI"));
    }
    Ok(())
}

fn integrity_allows(helper_level: u32, target_level: u32) -> bool {
    target_level <= helper_level
}

fn mapped_source_extent(returned: u32, scale_factor: f64) -> u32 {
    (returned as f64 * scale_factor).round().max(0.0) as u32
}

fn coordinate_within(origin: i32, extent: u32, value: i32) -> bool {
    value >= origin && value < origin.saturating_add(extent as i32)
}

fn assert_target(
    expected_app_id: &str,
    expected_process_id: u32,
    expected_window_id: &str,
    expected_input_epoch: u64,
) -> Result<super::window::AppIdentity, HelperError> {
    if !super::interaction::input_monitoring_ready() {
        return Err(HelperError::not_executed("input-lease", "physical input monitoring is unavailable; input is blocked"));
    }
    if !super::interaction::input_lease_running() {
        return Err(HelperError::observe_again("input-lease", "Computer Use input lease is not active; observe again before input"));
    }
    if super::interaction::input_epoch() != expected_input_epoch {
        return Err(HelperError::observe_again("physical-input", "physical user input occurred after observation; observe again"));
    }
    input_desktop_is_default()?;
    let actual = frontmost_app_identity_impl()?;
    if actual.process_id != expected_process_id as i32
        || !actual.bundle_id.eq_ignore_ascii_case(expected_app_id)
        || !super::window::window_ids_related(&actual.window_id, expected_window_id)
    {
        crate::emit_helper_event("window-invalidated", "foreground-target-changed");
        return Err(HelperError::observe_again("target-changed", "frontmost target changed; observe again"));
    }
    let window = inspect_window(super::window::parse_hwnd(&actual.window_id)?)?;
    if window.minimized {
        crate::emit_helper_event("window-invalidated", "target-minimized");
        return Err(HelperError::observe_again("target-minimized", "target window is minimized; observe again"));
    }
    assert_integrity(expected_process_id)?;
    Ok(actual)
}

fn assert_point(
    x: i32,
    y: i32,
    screenshot_id: &str,
    expected_app_id: &str,
    expected_process_id: u32,
    expected_window_id: &str,
    expected_input_epoch: u64,
) -> Result<(), HelperError> {
    let actual = assert_target(
        expected_app_id,
        expected_process_id,
        expected_window_id,
        expected_input_epoch,
    )?;
    if !super::dpi::per_monitor_v2() {
        return Err(HelperError::not_executed(
            "dpi-unaware",
            format!(
                "helper DPI awareness is '{}', not per-monitor-v2; coordinate input is disabled",
                super::dpi::dpi_awareness()
            ),
        ));
    }
    let screenshot = get_screenshot_ref(screenshot_id)?;
    if screenshot.input_epoch != expected_input_epoch {
        return Err(HelperError::observe_again("screenshot-stale", "screenshot was captured before the latest observation; observe again"));
    }
    if screenshot.app_id.as_deref() != Some(expected_app_id)
        || screenshot.process_id != Some(expected_process_id)
        || screenshot.window_id.as_deref() != Some(actual.window_id.as_str())
    {
        return Err(HelperError::observe_again("screenshot-stale", "screenshot_id belongs to a different target window"));
    }
    let current_window = inspect_window(super::window::parse_hwnd(&actual.window_id)?)?;
    if screenshot.window_bounds != Some(current_window.bounds) {
        return Err(HelperError::observe_again("screenshot-stale", "target window moved or resized after the screenshot; observe again"));
    }
    let mapped_width = mapped_source_extent(screenshot.returned_width, screenshot.scale_factor);
    let mapped_height = mapped_source_extent(screenshot.returned_height, screenshot.scale_factor);
    let max_x = screenshot
        .origin_x
        .saturating_add(screenshot.source_width.min(mapped_width) as i32);
    let max_y = screenshot
        .origin_y
        .saturating_add(screenshot.source_height.min(mapped_height) as i32);
    if !coordinate_within(
        screenshot.origin_x,
        max_x.saturating_sub(screenshot.origin_x) as u32,
        x,
    ) || !coordinate_within(
        screenshot.origin_y,
        max_y.saturating_sub(screenshot.origin_y) as u32,
        y,
    ) {
        return Err(HelperError::observe_again("coordinate-out-of-bounds", "input coordinate is outside the screenshot bounds"));
    }
    let hit = unsafe { WindowFromPoint(POINT { x, y }) };
    if hit.0.is_null() {
        return Err(HelperError::observe_again("no-window-at-point", "no window is present at the input coordinate"));
    }
    let root = unsafe { GetAncestor(hit, GA_ROOT) };
    let hit_window = inspect_window(if root.0.is_null() { hit } else { root })?;
    if hit_window.process_id != expected_process_id
        || !hit_window.app_id.eq_ignore_ascii_case(expected_app_id)
    {
        return Err(HelperError::observe_again("occluded", format!(
            "input coordinate is occluded by another app window ({})",
            hwnd_id(if root.0.is_null() { hit } else { root })
        )));
    }
    Ok(())
}

fn mouse_input(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: ABU_INJECTED_INPUT_MARKER,
            },
        },
    }
}

fn keyboard_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: ABU_INJECTED_INPUT_MARKER,
            },
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KeyboardEvent {
    vk: u16,
    key_up: bool,
}

impl KeyboardEvent {
    fn down(vk: VIRTUAL_KEY) -> Self {
        Self {
            vk: vk.0,
            key_up: false,
        }
    }

    fn up(vk: VIRTUAL_KEY) -> Self {
        Self {
            vk: vk.0,
            key_up: true,
        }
    }

    fn to_input(self) -> INPUT {
        keyboard_input(
            VIRTUAL_KEY(self.vk),
            0,
            if self.key_up {
                KEYEVENTF_KEYUP
            } else {
                KEYBD_EVENT_FLAGS(0)
            },
        )
    }
}

/// A physically held modifier would silently turn any injected key into a
/// chord, so every keyboard path refuses until the user lets go.
fn assert_no_physical_modifier(mut modifier_is_down: impl FnMut(u16) -> bool) -> Result<(), HelperError> {
    for modifier in [VK_CONTROL.0, VK_MENU.0, VK_SHIFT.0, VK_LWIN.0, VK_RWIN.0] {
        if modifier_is_down(modifier) {
            return Err(HelperError::observe_again("physical-input", "physical modifier input is already active; release held modifier and observe again"));
        }
    }
    Ok(())
}

/// Down/up pair for one UTF-16 unit as a Unicode (VK_PACKET) keystroke — the
/// same primitive `type` uses, so the target's keyboard layout and IME
/// composition never see a virtual key.
fn unicode_key_events(unit: u16) -> [INPUT; 2] {
    [
        keyboard_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE),
        keyboard_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
    ]
}

fn send_keyboard_sequence_with(
    events: &[KeyboardEvent],
    modifier_is_down: impl FnMut(u16) -> bool,
    mut sender: impl FnMut(&[KeyboardEvent]) -> usize,
) -> Result<(), HelperError> {
    assert_no_physical_modifier(modifier_is_down)?;

    let sent = sender(events);
    if sent == events.len() {
        return Ok(());
    }

    let mut injected_held = Vec::new();
    for event in events.iter().take(sent.min(events.len())) {
        if event.key_up {
            if let Some(index) = injected_held.iter().position(|vk| *vk == event.vk) {
                injected_held.remove(index);
            }
        } else if !injected_held.contains(&event.vk) {
            injected_held.push(event.vk);
        }
    }
    let cleanup = injected_held
        .into_iter()
        .rev()
        .map(|vk| KeyboardEvent { vk, key_up: true })
        .collect::<Vec<_>>();
    let cleanup_sent = if cleanup.is_empty() {
        0
    } else {
        sender(&cleanup)
    };
    let cleanup_status = if cleanup_sent == cleanup.len() {
        "injected held keys were released"
    } else {
        "injected held-key cleanup was incomplete"
    };
    Err(HelperError::outcome_unknown("send-input-failed", format!(
        "outcome-unknown: SendInput completed {sent}/{} planned events; {cleanup_status}",
        events.len()
    )))
}

fn send_keyboard_sequence(events: &[KeyboardEvent]) -> Result<(), HelperError> {
    send_keyboard_sequence_with(
        events,
        |vk| unsafe { GetAsyncKeyState(vk as i32) < 0 },
        |batch| {
            let inputs = batch
                .iter()
                .copied()
                .map(KeyboardEvent::to_input)
                .collect::<Vec<_>>();
            unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) as usize }
        },
    )
}

pub(crate) fn permit_foreground_activation() -> Result<(), HelperError> {
    // A balanced, marked Alt chord releases Windows' foreground-lock timeout
    // without leaving a modifier pressed. Low-level hooks classify both events
    // as Abu injection, so this cannot invalidate an observation state.
    send(&[
        keyboard_input(VK_MENU, 0, KEYBD_EVENT_FLAGS(0)),
        keyboard_input(VK_MENU, 0, KEYEVENTF_KEYUP),
    ])
}

fn move_event(x: i32, y: i32) -> Result<INPUT, HelperError> {
    let left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    if width <= 1 || height <= 1 {
        return Err(HelperError::preflight("virtual desktop bounds are unavailable"));
    }
    let dx = absolute_coordinate(x, left, width)?;
    let dy = absolute_coordinate(y, top, height)?;
    Ok(mouse_input(
        dx,
        dy,
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    ))
}

fn absolute_coordinate(value: i32, origin: i32, span: i32) -> Result<i32, HelperError> {
    if span <= 1 {
        return Err(HelperError::preflight("virtual desktop span is invalid"));
    }
    Ok(
        ((value.saturating_sub(origin)) as i64 * 65_535 / (span - 1) as i64).clamp(0, 65_535)
            as i32,
    )
}

pub fn mouse_move_impl(
    x: i32,
    y: i32,
    screenshot_id: String,
    app_id: String,
    process_id: u32,
    window_id: String,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    assert_point(
        x,
        y,
        &screenshot_id,
        &app_id,
        process_id,
        &window_id,
        expected_input_epoch,
    )?;
    send(&[move_event(x, y)?])?;
    Ok(format!("moved to ({x}, {y})"))
}

pub fn mouse_click_impl(
    x: i32,
    y: i32,
    button: Option<String>,
    screenshot_id: String,
    app_id: String,
    process_id: u32,
    window_id: String,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    assert_point(
        x,
        y,
        &screenshot_id,
        &app_id,
        process_id,
        &window_id,
        expected_input_epoch,
    )?;
    let (down, up, count) = match button
        .as_deref()
        .unwrap_or("left")
        .to_ascii_lowercase()
        .as_str()
    {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 1),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 1),
        "double" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 2),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 1),
    };
    let mut inputs = vec![move_event(x, y)?];
    for _ in 0..count {
        inputs.push(mouse_input(0, 0, 0, down));
        inputs.push(mouse_input(0, 0, 0, up));
    }
    send(&inputs)?;
    Ok(format!("clicked at ({x}, {y})"))
}

pub fn mouse_scroll_impl(
    x: i32,
    y: i32,
    direction: String,
    amount: Option<i32>,
    screenshot_id: String,
    app_id: String,
    process_id: u32,
    window_id: String,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    assert_point(
        x,
        y,
        &screenshot_id,
        &app_id,
        process_id,
        &window_id,
        expected_input_epoch,
    )?;
    let amount = amount.unwrap_or(3).clamp(1, 100);
    let horizontal = matches!(direction.as_str(), "left" | "right");
    let sign = if matches!(direction.as_str(), "down" | "left") {
        -1
    } else {
        1
    };
    let flags = if horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    send(&[
        move_event(x, y)?,
        mouse_input(0, 0, (sign * amount * 120) as u32, flags),
    ])?;
    Ok(format!("scrolled {direction} at ({x}, {y})"))
}

pub fn mouse_drag_impl(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    screenshot_id: String,
    app_id: String,
    process_id: u32,
    window_id: String,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    assert_point(
        start_x,
        start_y,
        &screenshot_id,
        &app_id,
        process_id,
        &window_id,
        expected_input_epoch,
    )?;
    assert_point(
        end_x,
        end_y,
        &screenshot_id,
        &app_id,
        process_id,
        &window_id,
        expected_input_epoch,
    )?;
    let start_move = move_event(start_x, start_y)?;
    {
        let _guard = held_input_lock()
            .lock()
            .map_err(|_| HelperError::preflight("held input state is unavailable"))?;
        ABU_LEFT_BUTTON_HELD.store(true, Ordering::Release);
        if let Err(error) = send(&[start_move, mouse_input(0, 0, 0, MOUSEEVENTF_LEFTDOWN)]) {
            ABU_LEFT_BUTTON_HELD.store(false, Ordering::Release);
            return Err(error);
        }
    }
    for step in 1..=16 {
        if super::interaction::input_epoch() != expected_input_epoch {
            let _ = release_held_inputs();
            return Err(HelperError::outcome_unknown("physical-input", "physical user input interrupted the drag"));
        }
        let x = start_x + (end_x - start_x) * step / 16;
        let y = start_y + (end_y - start_y) * step / 16;
        if let Err(error) = send(&[move_event(x, y).map_err(HelperError::after_dispatch)?]) {
            let _ = release_held_inputs();
            return Err(error.after_dispatch());
        }
        thread::sleep(Duration::from_millis(8));
    }
    release_held_inputs().map_err(HelperError::after_dispatch)?;
    Ok(format!("dragged to ({end_x}, {end_y})"))
}

pub fn keyboard_type_impl(
    text: String,
    method: String,
    app_id: String,
    process_id: u32,
    window_id: String,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    assert_target(&app_id, process_id, &window_id, expected_input_epoch)?;
    let unit_count = text.encode_utf16().count();
    if unit_count > 32_768 {
        return Err(HelperError::not_executed("text-too-long", "text input exceeds the 32768 UTF-16 unit safety limit"));
    }
    if contains_blocked_control(&text) {
        return Err(HelperError::not_executed(
            "invalid-params",
            "text contains control characters; use key for named keys",
        ));
    }
    match method.as_str() {
        "unicode" | "" => {}
        "paste" => return paste_via_clipboard(&text, &app_id, process_id, &window_id, expected_input_epoch),
        other => {
            return Err(HelperError::not_executed(
                "invalid-params",
                format!("unsupported type method '{other}'; use unicode or paste"),
            ))
        }
    }
    let mut inputs = Vec::with_capacity(unit_count * 2);
    for unit in text.encode_utf16() {
        inputs.push(keyboard_input(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE));
        inputs.push(keyboard_input(
            VIRTUAL_KEY(0),
            unit,
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
        ));
    }
    for chunk in inputs.chunks(64) {
        assert_target(&app_id, process_id, &window_id, expected_input_epoch)?;
        send(chunk)?;
    }
    Ok(format!("typed {} UTF-16 units", inputs.len() / 2))
}

/// The Ctrl+V chord, sent through the same guarded path as any other chord.
fn paste_events() -> [KeyboardEvent; 4] {
    [
        KeyboardEvent::down(VK_CONTROL),
        KeyboardEvent::down(VK_V),
        KeyboardEvent::up(VK_V),
        KeyboardEvent::up(VK_CONTROL),
    ]
}

/// `type` fallback for targets that ignore injected keystrokes (contract
/// §2.6): write the text to the clipboard, read it back, press Ctrl+V, restore
/// what was there. Refuses when the clipboard holds anything but plain text —
/// an image, files or rich text cannot be put back exactly, and the user's
/// clipboard is not ours to lose.
fn paste_via_clipboard(
    text: &str,
    app_id: &str,
    process_id: u32,
    window_id: &str,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    assert_no_physical_modifier(|vk| unsafe { GetAsyncKeyState(vk as i32) < 0 })?;
    let previous = {
        let clipboard = super::clipboard::Clipboard::open()?;
        let formats = clipboard.formats();
        if !super::clipboard::is_plain_text_clipboard(&formats) {
            return Err(HelperError::not_executed(
                "clipboard-busy",
                "clipboard holds non-text content that could not be restored; type with the unicode method instead",
            ));
        }
        let previous = clipboard.read_unicode_text();
        clipboard.set_unicode_text(text)?;
        if clipboard.read_unicode_text().as_deref() != Some(text) {
            let _ = match &previous {
                Some(value) => clipboard.set_unicode_text(value),
                None => clipboard.empty(),
            };
            return Err(HelperError::not_executed(
                "clipboard-write-failed",
                "clipboard did not read back the text that was written",
            ));
        }
        previous
    };
    // Everything up to here touched only the clipboard. The chord below is
    // the dispatch; its own partial-send classification stands.
    assert_target(app_id, process_id, window_id, expected_input_epoch)?;
    let sent = send_keyboard_sequence(&paste_events());
    // Let the target read the clipboard before it changes back.
    thread::sleep(Duration::from_millis(150));
    let restored = super::clipboard::Clipboard::open()
        .and_then(|clipboard| match &previous {
            Some(value) => clipboard.set_unicode_text(value),
            None => clipboard.empty(),
        })
        .is_ok();
    sent?;
    Ok(format!(
        "pasted {} UTF-16 units via clipboard{}",
        text.encode_utf16().count(),
        if restored { "" } else { " (previous clipboard content could not be restored)" }
    ))
}

fn named_key(key: &str) -> Option<VIRTUAL_KEY> {
    match key.to_ascii_lowercase().as_str() {
        "return" | "enter" => Some(VK_RETURN),
        "tab" => Some(VK_TAB),
        "escape" | "esc" => Some(VK_ESCAPE),
        "backspace" => Some(VK_BACK),
        "delete" => Some(VK_DELETE),
        "left" | "arrowleft" => Some(VK_LEFT),
        "right" | "arrowright" => Some(VK_RIGHT),
        "up" | "arrowup" => Some(VK_UP),
        "down" | "arrowdown" => Some(VK_DOWN),
        "home" => Some(VK_HOME),
        "end" => Some(VK_END),
        "pageup" => Some(VK_PRIOR),
        "pagedown" => Some(VK_NEXT),
        "space" => Some(VK_SPACE),
        value if value.starts_with('f') => value[1..]
            .parse::<u16>()
            .ok()
            .filter(|value| (1..=12).contains(value))
            .map(|value| VIRTUAL_KEY(VK_F1.0 + value - 1)),
        _ => None,
    }
}

pub(crate) fn resolve_character_key(
    scan: i16,
    explicit: &[u16],
) -> Result<(u16, Vec<u16>), HelperError> {
    if scan == -1 {
        return Err(HelperError::not_executed("key-unavailable", "key is unavailable in the target layout"));
    }
    let scan = scan as u16;
    let layout_modifiers = scan >> 8;
    if layout_modifiers & !0x07 != 0 {
        return Err(HelperError::not_executed("key-unavailable", "key requires unsupported target-layout modifiers"));
    }

    let mut control = explicit.contains(&VK_CONTROL.0);
    let mut alt = explicit.contains(&VK_MENU.0);
    let mut shift = explicit.contains(&VK_SHIFT.0);
    let win = explicit.contains(&VK_LWIN.0);
    shift |= layout_modifiers & 0x01 != 0;
    control |= layout_modifiers & 0x02 != 0;
    alt |= layout_modifiers & 0x04 != 0;

    let mut modifiers = Vec::with_capacity(4);
    for (required, vk) in [
        (control, VK_CONTROL.0),
        (alt, VK_MENU.0),
        (shift, VK_SHIFT.0),
        (win, VK_LWIN.0),
    ] {
        if required {
            modifiers.push(vk);
        }
    }
    Ok((scan & 0xff, modifiers))
}

fn character_layout_error(_key: &str, error: &HelperError) -> HelperError {
    HelperError::not_executed(
        "key-unavailable",
        format!("target keyboard layout cannot resolve requested key: {}", error.message),
    )
}

/// Modifier names → virtual keys, deduplicated: `["alt", "alt"]` presses Alt
/// once and `["win", "meta"]` is one Win key. A duplicated modifier would
/// otherwise spell a chord the Host blocklist never saw.
fn modifier_virtual_keys(modifiers: &[String]) -> Result<Vec<VIRTUAL_KEY>, HelperError> {
    let mut keys = Vec::new();
    for modifier in modifiers {
        let vk = match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => VK_CONTROL,
            "shift" => VK_SHIFT,
            "alt" | "option" => VK_MENU,
            "meta" | "win" | "super" => VK_LWIN,
            _ => {
                return Err(HelperError::not_executed(
                    "invalid-params",
                    format!("unsupported modifier '{modifier}'"),
                ))
            }
        };
        if !keys.contains(&vk) {
            keys.push(vk);
        }
    }
    Ok(keys)
}

/// C0/DEL controls other than tab, line feed and carriage return: never
/// something a model can want typed. The Host refuses them first; this is
/// the helper's own line.
fn contains_blocked_control(text: &str) -> bool {
    text.chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r'))
}

pub fn keyboard_press_impl(
    key: String,
    modifiers: Vec<String>,
    app_id: String,
    process_id: u32,
    window_id: String,
    expected_input_epoch: u64,
) -> Result<String, HelperError> {
    let actual = assert_target(&app_id, process_id, &window_id, expected_input_epoch)?;
    if contains_blocked_control(&key) {
        return Err(HelperError::not_executed(
            "invalid-params",
            "key contains a control character; use a key name",
        ));
    }
    let mut modifier_keys = modifier_virtual_keys(&modifiers)?;
    let vk = if let Some(value) = named_key(&key) {
        value
    } else {
        let mut units = key.encode_utf16();
        let unit = units.next().ok_or_else(|| HelperError::not_executed("invalid-params", "key is empty"))?;
        if units.next().is_some() {
            return Err(HelperError::not_executed("invalid-params", "key must be one character or a supported key name"));
        }
        if modifier_keys.is_empty() {
            // A plain character is text, not a key. Resolving it through the
            // target layout and pressing the virtual key hands it to the IME:
            // measured on Microsoft Pinyin (2026-09-11), `!:?` came out
            // full-width and letters vanished into an uncommitted composition.
            // Unicode injection is what `type` does and is IME-neutral.
            // Chords keep the virtual-key route below — Ctrl+C needs a real C.
            assert_no_physical_modifier(|vk| unsafe { GetAsyncKeyState(vk as i32) < 0 })?;
            send(&unicode_key_events(unit))?;
            return Ok(format!("pressed {key}"));
        }
        let target = super::window::parse_hwnd(&actual.window_id)?;
        let target_thread = unsafe { GetWindowThreadProcessId(target, None) };
        if target_thread == 0 {
            return Err(HelperError::preflight("target window keyboard thread is unavailable"));
        }
        let target_layout = unsafe { GetKeyboardLayout(target_thread) };
        if target_layout.0.is_null() {
            return Err(HelperError::preflight("target window keyboard layout is unavailable"));
        }
        let scan = unsafe { VkKeyScanExW(unit, target_layout) };
        let explicit = modifier_keys
            .iter()
            .map(|value| value.0)
            .collect::<Vec<_>>();
        let (vk, resolved_modifiers) = resolve_character_key(scan, &explicit)
            .map_err(|error| character_layout_error(&key, &error))?;
        modifier_keys = resolved_modifiers.into_iter().map(VIRTUAL_KEY).collect();
        VIRTUAL_KEY(vk)
    };
    let mut inputs = Vec::new();
    for modifier in &modifier_keys {
        inputs.push(KeyboardEvent::down(*modifier));
    }
    inputs.push(KeyboardEvent::down(vk));
    inputs.push(KeyboardEvent::up(vk));
    for modifier in modifier_keys.iter().rev() {
        inputs.push(KeyboardEvent::up(*modifier));
    }
    send_keyboard_sequence(&inputs)?;
    Ok(format!("pressed {key}"))
}

#[cfg(test)]
mod tests {
    use crate::error::HelperError;
    use windows::Win32::UI::Input::KeyboardAndMouse::{VK_CONTROL, VK_LWIN, VK_MENU, VK_V};
    use super::{
        absolute_coordinate, assert_no_physical_modifier, character_layout_error,
        contains_blocked_control, modifier_virtual_keys, paste_events,
        coordinate_within, integrity_allows, mapped_source_extent, resolve_character_key,
        send_keyboard_sequence_with, unicode_key_events, KeyboardEvent,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, KEYEVENTF_UNICODE};

    #[test]
    fn plain_character_becomes_a_unicode_packet_pair_with_no_virtual_key() {
        let events = unicode_key_events(0x4e2d); // '中'
        let down = unsafe { events[0].Anonymous.ki };
        let up = unsafe { events[1].Anonymous.ki };
        assert_eq!(down.wVk.0, 0);
        assert_eq!(up.wVk.0, 0);
        assert_eq!(down.wScan, 0x4e2d);
        assert_eq!(up.wScan, 0x4e2d);
        assert_eq!(down.dwFlags, KEYEVENTF_UNICODE);
        assert_eq!(up.dwFlags, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
    }

    #[test]
    fn held_physical_modifier_refuses_before_any_injection() {
        let error = assert_no_physical_modifier(|vk| vk == 0x11).unwrap_err();
        assert_eq!(error.code, "physical-input");
        assert_eq!(error.execution, crate::error::Execution::NotExecuted);
        assert!(error.retryable);
        assert!(assert_no_physical_modifier(|_| false).is_ok());
    }

    #[test]
    fn keyboard_sequence_snapshot_sends_the_complete_batch_once() {
        let events = [
            KeyboardEvent::down(super::VK_SHIFT),
            KeyboardEvent::up(super::VK_SHIFT),
        ];
        let mut batches = Vec::new();
        send_keyboard_sequence_with(
            &events,
            |_| false,
            |batch| {
                batches.push(batch.to_vec());
                batch.len()
            },
        )
        .unwrap();
        assert_eq!(batches, vec![events.to_vec()]);
    }

    #[test]
    fn partial_keyboard_send_returns_unknown_and_releases_only_injected_held_keys() {
        let events = [
            KeyboardEvent::down(super::VK_SHIFT),
            KeyboardEvent::down(super::VK_RETURN),
            KeyboardEvent::up(super::VK_RETURN),
            KeyboardEvent::up(super::VK_SHIFT),
        ];
        let mut batches = Vec::new();
        let error = send_keyboard_sequence_with(
            &events,
            |_| false,
            |batch| {
                batches.push(batch.to_vec());
                if batches.len() == 1 {
                    2
                } else {
                    batch.len()
                }
            },
        )
        .unwrap_err();

        assert!(error.message.contains("outcome-unknown"));
        assert_eq!(error.code, "send-input-failed");
        assert_eq!(error.execution, crate::error::Execution::OutcomeUnknown);
        assert_eq!(
            batches,
            vec![
                events.to_vec(),
                vec![
                    KeyboardEvent::up(super::VK_RETURN),
                    KeyboardEvent::up(super::VK_SHIFT),
                ],
            ]
        );
    }

    #[test]
    fn held_user_modifier_blocks_keyboard_send_before_dispatch() {
        let events = [
            KeyboardEvent::down(super::VK_RETURN),
            KeyboardEvent::up(super::VK_RETURN),
        ];
        let mut sends = 0;
        let error = send_keyboard_sequence_with(
            &events,
            |vk| vk == super::VK_SHIFT.0,
            |batch| {
                sends += 1;
                batch.len()
            },
        )
        .unwrap_err();

        assert!(error.message.contains("release held modifier"));
        assert_eq!(error.code, "physical-input");
        assert_eq!(error.execution, crate::error::Execution::NotExecuted);
        assert!(error.retryable);
        assert_eq!(sends, 0);
    }

    #[test]
    fn zero_keyboard_events_sent_is_still_outcome_unknown() {
        let events = [
            KeyboardEvent::down(super::VK_RETURN),
            KeyboardEvent::up(super::VK_RETURN),
        ];
        let mut sends = 0;
        let error = send_keyboard_sequence_with(
            &events,
            |_| false,
            |_| {
                sends += 1;
                0
            },
        )
        .unwrap_err();

        assert!(error.message.contains("outcome-unknown"));
        assert_eq!(error.code, "send-input-failed");
        assert_eq!(error.execution, crate::error::Execution::OutcomeUnknown);
        assert_eq!(sends, 1);
    }

    #[test]
    fn resolves_layout_required_modifiers_and_rejects_unsupported_scans() {
        assert_eq!(resolve_character_key(443, &[]).unwrap(), (187, vec![16]));
        assert_eq!(resolve_character_key(187, &[]).unwrap(), (187, vec![]));
        assert_eq!(resolve_character_key(443, &[16]).unwrap(), (187, vec![16]));
        assert_eq!(
            resolve_character_key(443, &[17]).unwrap(),
            (187, vec![17, 16])
        );
        assert_eq!(
            resolve_character_key(0x07bb, &[91, 16, 18, 17, 17]).unwrap(),
            (187, vec![17, 18, 16, 91])
        );
        assert!(resolve_character_key(-1, &[]).is_err());
        assert!(resolve_character_key(0x08bb, &[]).is_err());
    }

    #[test]
    fn character_layout_errors_do_not_expose_the_requested_key() {
        let raw_key = "private-layout-key";
        let cause = HelperError::not_executed("key-unavailable", "unsupported keyboard layout modifiers");
        let error = character_layout_error(raw_key, &cause);

        assert!(!error.message.contains(raw_key));
        assert_eq!(
            error.message,
            "target keyboard layout cannot resolve requested key: unsupported keyboard layout modifiers"
        );
        assert_eq!(error.code, "key-unavailable");
        assert_eq!(error.execution, crate::error::Execution::NotExecuted);
    }

    #[test]
    fn maps_negative_origin_virtual_desktops_to_sendinput_space() {
        assert_eq!(absolute_coordinate(-1920, -1920, 3840).unwrap(), 0);
        assert_eq!(absolute_coordinate(1919, -1920, 3840).unwrap(), 65_535);
        assert!(absolute_coordinate(0, 0, 1).is_err());
    }

    #[test]
    fn maps_scaled_screenshot_pixels_back_at_supported_dpi_ratios() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            assert_eq!(mapped_source_extent(800, scale), (800.0 * scale) as u32);
        }
        assert!(coordinate_within(-1920, 1920, -1));
        assert!(!coordinate_within(-1920, 1920, 0));
    }

    #[test]
    fn rejects_higher_integrity_targets() {
        assert!(integrity_allows(0x2000, 0x1000));
        assert!(integrity_allows(0x2000, 0x2000));
        assert!(!integrity_allows(0x2000, 0x3000));
    }

    #[test]
    fn paste_chord_is_ctrl_v_released_in_reverse_order() {
        let events = paste_events();
        assert_eq!(events.len(), 4);
        assert!(!events[0].key_up && events[0].vk == VK_CONTROL.0);
        assert!(!events[1].key_up && events[1].vk == VK_V.0);
        assert!(events[2].key_up && events[2].vk == VK_V.0);
        assert!(events[3].key_up && events[3].vk == VK_CONTROL.0);
    }

    #[test]
    fn deduplicates_modifier_virtual_keys() {
        let keys = modifier_virtual_keys(&[
            "alt".to_string(),
            "ALT".to_string(),
            "win".to_string(),
            "meta".to_string(),
        ])
        .unwrap();
        assert_eq!(keys, vec![VK_MENU, VK_LWIN]);
        assert_eq!(
            modifier_virtual_keys(&["hyper".to_string()]).unwrap_err().code,
            "invalid-params"
        );
    }

    #[test]
    fn blocks_control_characters_except_whitespace_controls() {
        assert!(!contains_blocked_control("plain text\twith\r\nbreaks"));
        assert!(contains_blocked_control("a\u{3}b"));
        assert!(contains_blocked_control("del\u{7f}"));
    }
}
