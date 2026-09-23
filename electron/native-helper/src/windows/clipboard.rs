//! Clipboard round-trip for the `type` paste fallback (contract §2.6/§2.8
//! `input.clipboard_paste`): write → read back → Ctrl+V → restore.
//!
//! The user's clipboard is theirs, and only plain text can be put back
//! exactly as it was. The paste runs anyway when the clipboard holds
//! something else (an image, files, rich text from a browser) — refusing
//! would block the ordinary case, since a copy out of any browser or editor
//! carries extra formats — and the receipt says what could not be restored.
//! `is_plain_text_clipboard` reports that; it does not gate the paste.

use std::thread;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

use crate::error::HelperError;

const CF_TEXT: u32 = 1;
const CF_OEMTEXT: u32 = 7;
const CF_UNICODETEXT: u32 = 13;
const CF_LOCALE: u32 = 16;
const OPEN_ATTEMPTS: usize = 6;
const OPEN_RETRY: Duration = Duration::from_millis(25);

/// Formats Windows synthesizes from CF_UNICODETEXT; a clipboard holding only
/// these is "plain text" and can be restored exactly.
pub fn is_plain_text_clipboard(formats: &[u32]) -> bool {
    formats
        .iter()
        .all(|format| matches!(*format, CF_TEXT | CF_OEMTEXT | CF_UNICODETEXT | CF_LOCALE))
}

/// Markers whose only purpose is to say "do not record this". A password
/// manager stamps them on a copied secret so clipboard history and cloud sync
/// skip it.
const UNCONDITIONAL_EXCLUSION_FORMATS: [&str; 2] = [
    "Clipboard Viewer Ignore",
    "ExcludeClipboardContentFromMonitorProcessing",
];

/// Markers that carry a DWORD: 0 opts out, anything else opts in.
const CONDITIONAL_EXCLUSION_FORMATS: [&str; 2] =
    ["CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"];

/// `RegisterClipboardFormatW` returns the existing id when the format is
/// already registered, which is what we want: it tells us the numeric id to
/// look for. Returns `None` if the call fails.
fn registered_format(name: &str) -> Option<u32> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    match unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) } {
        0 => None,
        id => Some(id),
    }
}

/// An open clipboard, closed on drop.
pub struct Clipboard {
    _private: (),
}

impl Clipboard {
    /// Another process may hold the clipboard for a moment (browsers do
    /// after a copy); retry briefly before giving up.
    pub fn open() -> Result<Self, HelperError> {
        let mut last = None;
        for attempt in 0..OPEN_ATTEMPTS {
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(Self { _private: () }),
                Err(error) => {
                    last = Some(error);
                    if attempt + 1 < OPEN_ATTEMPTS {
                        thread::sleep(OPEN_RETRY);
                    }
                }
            }
        }
        // Another process held it through all the retries. That is a moment
        // in time, not a verdict: observing again and trying once more is the
        // right recovery, so this must not be classified as a refusal that a
        // retry would only repeat.
        Err(HelperError::observe_again(
            "clipboard-busy",
            format!(
                "clipboard could not be opened: {}",
                last.map(|e| e.to_string()).unwrap_or_default()
            ),
        ))
    }

    pub fn formats(&self) -> Vec<u32> {
        let mut formats = Vec::new();
        let mut format = unsafe { EnumClipboardFormats(0) };
        while format != 0 {
            formats.push(format);
            format = unsafe { EnumClipboardFormats(format) };
        }
        formats
    }

    /// Whether the source asked for this content not to be recorded.
    ///
    /// It matters because we cannot put such content back the way we found
    /// it: restoring through `SetClipboardData(CF_UNICODETEXT)` writes the
    /// bytes without the marker, and Windows would then record in clipboard
    /// history exactly the secret the marker existed to keep out of it. So
    /// when this is true the caller must neither read the content nor restore
    /// it — leaving the clipboard empty loses one copy the user can repeat,
    /// which is the cheaper mistake.
    pub fn excludes_recording(&self) -> bool {
        let formats = self.formats();
        for name in UNCONDITIONAL_EXCLUSION_FORMATS {
            if registered_format(name).is_some_and(|id| formats.contains(&id)) {
                return true;
            }
        }
        for name in CONDITIONAL_EXCLUSION_FORMATS {
            let Some(id) = registered_format(name) else { continue };
            if formats.contains(&id) && self.read_dword(id) == Some(0) {
                return true;
            }
        }
        false
    }

    fn read_dword(&self, format: u32) -> Option<u32> {
        let handle = unsafe { GetClipboardData(format) }.ok()?;
        if handle.is_invalid() {
            return None;
        }
        let global = HGLOBAL(handle.0);
        let pointer = unsafe { GlobalLock(global) } as *const u32;
        if pointer.is_null() {
            return None;
        }
        let value = unsafe { *pointer };
        let _ = unsafe { GlobalUnlock(global) };
        Some(value)
    }

    pub fn read_unicode_text(&self) -> Option<String> {
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT) }.ok()?;
        if handle.is_invalid() {
            return None;
        }
        let global = HGLOBAL(handle.0);
        let pointer = unsafe { GlobalLock(global) } as *const u16;
        if pointer.is_null() {
            return None;
        }
        let mut length = 0usize;
        // Bounded by the allocation: SetClipboardData callers write a NUL.
        while unsafe { *pointer.add(length) } != 0 {
            length += 1;
        }
        let units = unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec();
        let _ = unsafe { GlobalUnlock(global) };
        Some(String::from_utf16_lossy(&units))
    }

    pub fn set_unicode_text(&self, text: &str) -> Result<(), HelperError> {
        let units: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = units.len() * std::mem::size_of::<u16>();
        unsafe { EmptyClipboard() }.map_err(|error| {
            HelperError::not_executed(
                "clipboard-write-failed",
                format!("EmptyClipboard failed: {error}"),
            )
        })?;
        let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }.map_err(|error| {
            HelperError::not_executed(
                "clipboard-write-failed",
                format!("GlobalAlloc failed: {error}"),
            )
        })?;
        let pointer = unsafe { GlobalLock(global) } as *mut u16;
        if pointer.is_null() {
            let _ = unsafe { GlobalFree(global) };
            return Err(HelperError::not_executed(
                "clipboard-write-failed",
                "GlobalLock failed",
            ));
        }
        unsafe { std::ptr::copy_nonoverlapping(units.as_ptr(), pointer, units.len()) };
        let _ = unsafe { GlobalUnlock(global) };
        // On success the system owns the block; on failure it is still ours.
        if let Err(error) = unsafe { SetClipboardData(CF_UNICODETEXT, HANDLE(global.0)) } {
            let _ = unsafe { GlobalFree(global) };
            return Err(HelperError::not_executed(
                "clipboard-write-failed",
                format!("SetClipboardData failed: {error}"),
            ));
        }
        Ok(())
    }

    pub fn empty(&self) -> Result<(), HelperError> {
        unsafe { EmptyClipboard() }.map_err(|error| {
            HelperError::not_executed(
                "clipboard-write-failed",
                format!("EmptyClipboard failed: {error}"),
            )
        })
    }
}

impl Drop for Clipboard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_plain_text_clipboard, registered_format, CONDITIONAL_EXCLUSION_FORMATS,
        UNCONDITIONAL_EXCLUSION_FORMATS,
    };

    #[test]
    fn exclusion_markers_resolve_to_stable_distinct_format_ids() {
        // The whole "do not launder a copied password" guard rests on being
        // able to name these formats and get back the same numeric id the
        // password manager registered. If that ever stops holding, the guard
        // silently stops guarding.
        let mut ids = Vec::new();
        for name in UNCONDITIONAL_EXCLUSION_FORMATS
            .iter()
            .chain(CONDITIONAL_EXCLUSION_FORMATS.iter())
        {
            let id = registered_format(name).expect("format name should register");
            assert_eq!(registered_format(name), Some(id), "id must be stable for {name}");
            // Registered formats live above the predefined range, so they can
            // never collide with CF_UNICODETEXT and friends.
            assert!(id >= 0xC000, "{name} should be a registered format, got {id}");
            assert!(!ids.contains(&id), "{name} collided with another marker");
            ids.push(id);
        }
    }

    #[test]
    fn only_text_and_its_synthesized_formats_count_as_plain_text() {
        assert!(is_plain_text_clipboard(&[]));
        assert!(is_plain_text_clipboard(&[13]));
        assert!(is_plain_text_clipboard(&[13, 16, 1, 7]));
        assert!(!is_plain_text_clipboard(&[13, 49_161])); // "HTML Format" alongside text
        assert!(!is_plain_text_clipboard(&[15])); // CF_HDROP: files
        assert!(!is_plain_text_clipboard(&[2, 8])); // bitmap / DIB
    }
}
