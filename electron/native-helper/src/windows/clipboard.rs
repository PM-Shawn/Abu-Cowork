//! Clipboard round-trip for the `type` paste fallback (contract §2.6/§2.8
//! `input.clipboard_paste`): write → read back → Ctrl+V → restore.
//!
//! The user's clipboard is theirs. Only plain text can be put back exactly as
//! it was, so the fallback refuses to run when the clipboard holds anything
//! else (an image, files, rich text from a browser) instead of quietly
//! replacing it; the model is told to type instead.

use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
    SetClipboardData,
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
        Err(HelperError::not_executed(
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
    use super::is_plain_text_clipboard;

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
