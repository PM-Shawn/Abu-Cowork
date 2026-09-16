//! Which documents are open in Office / WPS right now — attach-only.
//!
//! This exists for one product rule: writing a file behind the back of the
//! application the user has it open in either fails outright or discards their
//! unsaved edits. Knowing *that* is what lets the assistant say so and ask,
//! instead of finding out from a `PermissionError` halfway through.
//!
//! # What this module is allowed to do
//!
//! Attach to an already-running instance and read. `GetActiveObject` only ever
//! returns an instance that is already in the running-object table — there is
//! deliberately **no `CoCreateInstance` in this file**, so nothing here can
//! start Excel or WPS on the user's behalf. The late-bound member names are a
//! closed list (`ALLOWED_MEMBERS`): three collections, `Count`, `Item`, and
//! three read-only document properties. Nothing that edits, saves, or closes.
//!
//! # Why a worker thread
//!
//! An Office instance sitting on a modal dialog (a Save As sheet, a "this file
//! is locked" prompt) does not answer automation calls at all — `Invoke`
//! blocks until the user dismisses it. On the helper's own thread that would
//! hang every later command, so the COM work lives on one long-lived STA
//! thread and callers wait with a timeout. If that thread is stuck, later
//! calls time out too and report "could not determine" rather than hanging.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use windows::core::{Interface, IUnknown, BSTR, GUID, PCWSTR, VARIANT};
use windows::Win32::System::Com::{
    CLSIDFromProgID, CoInitializeEx, IDispatch, COINIT_APARTMENTTHREADED, DISPATCH_METHOD,
    DISPATCH_PROPERTYGET, DISPPARAMS,
};
use windows::Win32::System::Ole::GetActiveObject;
use windows::Win32::System::Variant::{VariantChangeType, VAR_CHANGE_FLAGS, VT_UNKNOWN};

use crate::error::HelperError;

/// How long a caller waits for the COM thread before giving up on it. Long
/// enough for a cold automation server to answer, short enough that a stuck
/// Office instance does not become the assistant's problem.
const INSPECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Runaway guard. A real session has a handful of documents open; anything
/// past this is a misbehaving automation server, not a user.
const MAX_DOCUMENTS_PER_HOST: i32 = 200;

/// The only late-bound names this module may ask for. Automation is a fully
/// general remote-call surface — `Workbooks.Item(1).Close` is exactly as
/// reachable as `.Name` — so the reachable surface is written down rather than
/// left implicit in the call sites.
const ALLOWED_MEMBERS: &[&str] = &[
    "Workbooks",
    "Documents",
    "Presentations",
    "Count",
    "Item",
    "FullName",
    "Name",
    "Saved",
];

pub(crate) fn is_allowed_member(name: &str) -> bool {
    ALLOWED_MEMBERS.contains(&name)
}

struct OfficeHost {
    /// ProgID to attach to. WPS renamed its ProgIDs in 2016 (`ET` → `Ket`);
    /// the current names are what a supported install registers.
    prog_id: &'static str,
    /// Reported to the model, so it can say "open in Excel" in the sentence it
    /// writes to the user.
    app: &'static str,
    /// The application's open-document collection.
    collection: &'static str,
}

/// WPS first, and the order is load-bearing.
///
/// **Measured on a machine with both suites installed:** a running WPS
/// registers itself in the running-object table under *Microsoft's* CLSID as
/// well as its own, so `GetActiveObject("Excel.Application")` hands back the
/// WPS instance — same object, same documents, under Excel's name. Attaching
/// to the Office ProgID first would label every WPS document "Excel" and send
/// the user looking for an application they may not even have installed. The
/// reverse never happens: Microsoft Office does not register under `Ket`.
///
/// Identical objects are then dropped by COM identity in `collect_documents`,
/// so the first host to claim an instance is the one that names it.
const OFFICE_HOSTS: &[OfficeHost] = &[
    OfficeHost { prog_id: "Ket.Application", app: "wps-spreadsheets", collection: "Workbooks" },
    OfficeHost { prog_id: "Kwps.Application", app: "wps-writer", collection: "Documents" },
    OfficeHost {
        prog_id: "Kwpp.Application",
        app: "wps-presentation",
        collection: "Presentations",
    },
    OfficeHost { prog_id: "Excel.Application", app: "excel", collection: "Workbooks" },
    OfficeHost { prog_id: "Word.Application", app: "word", collection: "Documents" },
    OfficeHost {
        prog_id: "PowerPoint.Application",
        app: "powerpoint",
        collection: "Presentations",
    },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OfficeDocument {
    /// Which application, as a stable token (`excel`, `wps-spreadsheets`, …).
    /// A token rather than a display name because this is read back to the
    /// user in their own language, and that translation belongs in the
    /// renderer's i18n, not in a Rust string literal.
    pub app: String,
    /// Full path as the application reports it. Empty for a document that has
    /// never been saved, which is exactly the case where overwriting the path
    /// the user named is safe — there is no file behind it yet.
    pub path: String,
    /// The application's own display name for the document.
    pub name: String,
    /// The document has edits that are not on disk. This is the difference
    /// between "ask them to close it" and "closing it loses their work".
    pub unsaved: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OfficeDocumentsReport {
    pub documents: Vec<OfficeDocument>,
    /// False when the COM thread did not answer in time — the answer is "we
    /// could not tell", which reads very differently from "nothing is open".
    pub complete: bool,
}

/// Enumerate every document open in a running Office or WPS application.
///
/// Applications that are not running, and applications that are not installed,
/// are simply absent: neither is an error, and neither is started.
pub fn office_documents_impl() -> Result<OfficeDocumentsReport, HelperError> {
    match request_inspection() {
        Some(documents) => Ok(OfficeDocumentsReport { documents, complete: true }),
        None => Ok(OfficeDocumentsReport { documents: Vec::new(), complete: false }),
    }
}

// ---------------------------------------------------------------------------
// The COM thread
// ---------------------------------------------------------------------------

type InspectRequest = Sender<Vec<OfficeDocument>>;

/// `None` once the worker thread could not be started; `Some` otherwise. The
/// mutex serializes callers so a second request cannot be queued behind a
/// stuck one and then answer the wrong caller.
static WORKER: OnceLock<Option<Mutex<Sender<InspectRequest>>>> = OnceLock::new();

fn request_inspection() -> Option<Vec<OfficeDocument>> {
    let worker = WORKER.get_or_init(spawn_worker).as_ref()?;
    // A caller that finds the lock held is behind a request that has not come
    // back yet. Waiting would stack the timeouts; reporting "could not tell"
    // immediately is the same answer it would get, sooner.
    let sender = worker.try_lock().ok()?;
    let (reply_tx, reply_rx) = channel();
    sender.send(reply_tx).ok()?;
    // The worker is not reusable once a call into Office wedges it, but it is
    // also not leaked: one thread, parked in COM, answering nobody. Later
    // callers take this same timeout and report the same "could not tell".
    reply_rx.recv_timeout(INSPECT_TIMEOUT).ok()
}

fn spawn_worker() -> Option<Mutex<Sender<InspectRequest>>> {
    let (tx, rx) = channel::<InspectRequest>();
    std::thread::Builder::new()
        .name("office-com".into())
        .spawn(move || worker_loop(rx))
        .ok()?;
    Some(Mutex::new(tx))
}

fn worker_loop(rx: Receiver<InspectRequest>) {
    // Office automation objects are apartment-threaded; an STA is the normal
    // apartment for a client of them. S_FALSE ("already initialized") is `Ok`
    // in windows-rs, the same tolerance the UIA worker relies on.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    while let Ok(reply) = rx.recv() {
        // The caller may already have timed out and gone; that send fails and
        // the loop carries on.
        let _ = reply.send(collect_documents());
    }
}

fn collect_documents() -> Vec<OfficeDocument> {
    let mut documents = Vec::new();
    // One running application can answer to several ProgIDs — see the note on
    // OFFICE_HOSTS. COM's identity rule is the reliable way to notice: for the
    // same object, `QueryInterface(IID_IUnknown)` returns the same pointer,
    // and it does so regardless of which name got us there.
    let mut seen: Vec<*mut std::ffi::c_void> = Vec::new();
    for host in OFFICE_HOSTS {
        // Not installed and not running are both "nothing to report".
        let Some(application) = attach_to(host.prog_id) else { continue };
        let Ok(identity) = application.cast::<IUnknown>() else { continue };
        let pointer = identity.as_raw();
        if seen.contains(&pointer) {
            continue;
        }
        seen.push(pointer);
        documents.extend(documents_of(&application, host));
    }
    documents
}

/// Attach to a running instance, never start one.
fn attach_to(prog_id: &str) -> Option<IDispatch> {
    let wide: Vec<u16> = prog_id.encode_utf16().chain(std::iter::once(0)).collect();
    let clsid: GUID = unsafe { CLSIDFromProgID(PCWSTR(wide.as_ptr())) }.ok()?;
    let mut unknown = None;
    unsafe { GetActiveObject(&clsid, None, &mut unknown) }.ok()?;
    unknown?.cast::<IDispatch>().ok()
}

fn documents_of(application: &IDispatch, host: &OfficeHost) -> Vec<OfficeDocument> {
    let Some(collection) = get_property(application, host.collection).and_then(as_dispatch) else {
        return Vec::new();
    };
    let count = get_property(&collection, "Count")
        .and_then(|value| i32::try_from(&value).ok())
        .unwrap_or(0)
        .min(MAX_DOCUMENTS_PER_HOST);

    let mut documents = Vec::new();
    // Office collections are 1-based.
    for index in 1..=count {
        let Some(document) = get_indexed(&collection, index).and_then(as_dispatch) else {
            continue;
        };
        // A document with no readable name is not something the model can act
        // on, so it is dropped rather than reported as a blank entry.
        let Some(name) = get_string(&document, "Name") else { continue };
        documents.push(OfficeDocument {
            app: host.app.to_string(),
            // An unsaved new document answers `FullName` with just its name on
            // some hosts and errors on others; both mean "no file on disk".
            path: get_string(&document, "FullName")
                .filter(|full| full.contains(['\\', '/']))
                .unwrap_or_default(),
            name,
            // Unreadable `Saved` is treated as unsaved: the cautious answer is
            // the one that makes the assistant ask before destroying work.
            unsaved: !get_property(&document, "Saved")
                .and_then(|value| bool::try_from(&value).ok())
                .unwrap_or(false),
        });
    }
    documents
}

// ---------------------------------------------------------------------------
// Late binding
// ---------------------------------------------------------------------------

fn get_property(object: &IDispatch, name: &str) -> Option<VARIANT> {
    invoke(object, name, &mut [])
}

fn get_indexed(collection: &IDispatch, index: i32) -> Option<VARIANT> {
    invoke(collection, "Item", &mut [VARIANT::from(index)])
}

/// One late-bound call, and the only place a member name reaches COM.
///
/// `arguments` is passed as-is into `DISPPARAMS`, which reads them
/// right-to-left; every call site here passes at most one, so no reversal is
/// needed.
fn invoke(object: &IDispatch, name: &str, arguments: &mut [VARIANT]) -> Option<VARIANT> {
    if !is_allowed_member(name) {
        return None;
    }
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let names = [PCWSTR(wide.as_ptr())];
    let mut dispatch_id = 0i32;
    unsafe {
        object.GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, 0, &mut dispatch_id).ok()?;
    }

    let parameters = DISPPARAMS {
        rgvarg: arguments.as_mut_ptr(),
        cArgs: arguments.len() as u32,
        ..Default::default()
    };
    let mut result = VARIANT::new();
    unsafe {
        object
            .Invoke(
                dispatch_id,
                &GUID::zeroed(),
                0,
                // `Item` is a method on some hosts and a parameterized
                // property on others; asking for both is what late-bound
                // clients do rather than maintaining a per-host table.
                DISPATCH_PROPERTYGET | DISPATCH_METHOD,
                &parameters,
                Some(&mut result),
                None,
                None,
            )
            .ok()?;
    }
    Some(result)
}

/// An object out of a VARIANT, whichever way the server chose to wrap it.
///
/// Office answers `Workbooks` and `Item` with `VT_DISPATCH`, and windows-rs's
/// `TryFrom<&VARIANT> for IUnknown` accepts only `VT_UNKNOWN` — so the obvious
/// spelling silently yields `None` for every document on the machine, which
/// reads downstream as "nothing is open". `VariantChangeType` is the
/// documented conversion between the two and keeps this off the crate's
/// private VARIANT layout.
fn as_dispatch(value: VARIANT) -> Option<IDispatch> {
    if let Ok(dispatch) = IUnknown::try_from(&value).and_then(|unknown| unknown.cast::<IDispatch>())
    {
        return Some(dispatch);
    }
    let mut unknown_variant = VARIANT::new();
    unsafe { VariantChangeType(&mut unknown_variant, &value, VAR_CHANGE_FLAGS(0), VT_UNKNOWN) }
        .ok()?;
    IUnknown::try_from(&unknown_variant).ok()?.cast::<IDispatch>().ok()
}

fn get_string(object: &IDispatch, name: &str) -> Option<String> {
    let value = get_property(object, name)?;
    let text = BSTR::try_from(&value).ok()?.to_string();
    (!text.trim().is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reachable_automation_surface_is_read_only() {
        // The point of the list is what is *not* on it. Anything that edits,
        // saves, closes, or starts something must stay unreachable from here.
        for forbidden in [
            "Close", "Save", "SaveAs", "Quit", "Run", "Activate", "Visible", "Application",
            "Range", "Cells", "Content", "Workbooks.Add", "Open",
        ] {
            assert!(!is_allowed_member(forbidden), "{forbidden} must not be callable");
        }
    }

    #[test]
    fn every_host_collection_is_a_member_this_module_may_ask_for() {
        for host in OFFICE_HOSTS {
            assert!(
                is_allowed_member(host.collection),
                "{} would be refused by invoke()",
                host.collection
            );
        }
    }

    #[test]
    fn both_office_suites_are_covered_for_all_three_document_kinds() {
        let apps: Vec<&str> = OFFICE_HOSTS.iter().map(|host| host.app).collect();
        assert!(apps.iter().any(|app| app.starts_with("wps-")), "WPS is a supported suite here");
        assert_eq!(OFFICE_HOSTS.len(), 6, "two suites x spreadsheet/document/presentation");
    }

    /// A running WPS also answers to Microsoft's ProgIDs (measured), so
    /// whichever suite is asked first is the name every shared instance gets
    /// reported under. Asking Microsoft first labels WPS documents "Excel" on
    /// machines that may not have Excel at all.
    #[test]
    fn wps_is_asked_before_microsoft_so_a_shared_instance_is_named_correctly() {
        let first_wps = OFFICE_HOSTS.iter().position(|host| host.app.starts_with("wps-"));
        let first_microsoft = OFFICE_HOSTS.iter().position(|host| !host.app.starts_with("wps-"));
        assert!(first_wps < first_microsoft, "WPS ProgIDs must be attached first");
    }

    /// The token is what the renderer looks up to say "Excel" or "WPS 表格" in
    /// the user's language; a display name here would ship English into a
    /// Chinese sentence.
    #[test]
    fn app_names_are_lookup_tokens_not_display_names() {
        for host in OFFICE_HOSTS {
            assert_eq!(host.app, host.app.to_lowercase(), "{} is a display name", host.app);
            assert!(!host.app.contains(' '), "{} is a display name", host.app);
        }
    }

    /// Not running and not installed have to stay indistinguishable from
    /// "nothing open" — an assistant that reports an error every time Excel is
    /// closed is worse than one that says nothing.
    #[test]
    fn attaching_to_something_that_is_not_there_is_not_an_error() {
        assert!(attach_to("Abu.NoSuchApplication.Nonexistent").is_none());
    }

    /// Diagnostic, not a gate: an empty document list is the same answer
    /// whether nothing is open or every attach silently failed, and those two
    /// need telling apart on a real machine. Run with
    /// `cargo test office_attach_probe -- --ignored --nocapture`.
    #[test]
    #[ignore = "reports what is open on this machine; depends on the desktop"]
    fn office_attach_probe() {
        // The apartment the *worker* would have. Without it `GetActiveObject`
        // fails with CO_E_NOTINITIALIZED and every host reads as "not
        // running" — which is exactly how a broken attach disguises itself as
        // an empty desktop.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        for host in OFFICE_HOSTS {
            let wide: Vec<u16> =
                host.prog_id.encode_utf16().chain(std::iter::once(0)).collect();
            let clsid = unsafe { CLSIDFromProgID(PCWSTR(wide.as_ptr())) };
            let attach = clsid.as_ref().ok().map(|clsid| {
                let mut unknown = None;
                unsafe { GetActiveObject(clsid, None, &mut unknown) }
                    .map(|()| unknown.is_some())
            });
            println!(
                "{:<24} clsid={:<8} attach={:?} documents={}",
                host.prog_id,
                clsid.is_ok(),
                attach,
                attach_to(host.prog_id)
                    .map(|application| documents_of(&application, host).len() as i64)
                    .unwrap_or(-1),
            );
        }
        println!("{:#?}", office_documents_impl().unwrap());
    }

    #[test]
    fn inspection_answers_even_with_no_office_running() {
        let report = office_documents_impl().expect("inspection must not fail the command");
        if report.complete {
            // Whatever is open on the machine running this, a document that is
            // reported with a path must be reported with a usable one.
            for document in &report.documents {
                assert!(!document.name.is_empty());
                assert!(document.path.is_empty() || document.path.contains(['\\', '/']));
            }
        }
    }
}
