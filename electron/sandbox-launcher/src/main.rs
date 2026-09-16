use serde::Deserialize;
use std::io::{self, Read};
use std::process;

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct LaunchConfig {
    file: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, rename = "sandboxEnabled")]
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    sandbox_enabled: bool,
    #[serde(default, rename = "monitorParent")]
    monitor_parent: bool,
    #[serde(default, rename = "stdioPassthrough")]
    stdio_passthrough: bool,
    #[serde(default, rename = "parentPid")]
    parent_pid: Option<u32>,
}

fn read_config() -> Result<LaunchConfig, String> {
    // One newline-terminated frame leaves stdin open as a parent-liveness
    // channel. Legacy/direct callers may still close stdin without a newline.
    let mut stdin = io::stdin();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = stdin
            .read(&mut chunk)
            .map_err(|err| format!("failed to read launch config: {err}"))?;
        if read == 0 {
            break;
        }
        if let Some(newline) = chunk[..read].iter().position(|byte| *byte == b'\n') {
            buf.extend_from_slice(&chunk[..newline]);
            break;
        }
        buf.extend_from_slice(&chunk[..read]);
        if buf.len() as u64 > MAX_CONFIG_BYTES {
            return Err("launch config too large".to_string());
        }
    }
    if buf.len() as u64 > MAX_CONFIG_BYTES {
        return Err("launch config too large".to_string());
    }

    let cfg: LaunchConfig =
        serde_json::from_slice(&buf).map_err(|err| format!("invalid launch config json: {err}"))?;
    if cfg.file.is_empty() {
        return Err("launch config file must not be empty".to_string());
    }
    Ok(cfg)
}

#[cfg(any(windows, test))]
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .bytes()
            .any(|b| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'"'))
    {
        return arg.to_string();
    }

    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
        } else if ch == '"' {
            quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
            quoted.push('"');
            backslashes = 0;
        } else {
            quoted.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
            quoted.push(ch);
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

/// Describe an NTSTATUS-style exit code so a native loader crash (which the OS
/// reports only as a huge exit code plus, at best, a dialog box) leaves a
/// diagnosable line on stderr. Only error-severity values (0xC…) qualify;
/// ordinary exit codes and warning-severity NTSTATUS values return None.
#[cfg(any(windows, test))]
fn ntstatus_exit_hint(code: u32) -> Option<String> {
    if code < 0xC000_0000 {
        return None;
    }
    let name = match code {
        0xC000_0005 => Some("STATUS_ACCESS_VIOLATION"),
        0xC000_0017 => Some("STATUS_NO_MEMORY"),
        0xC000_007B => Some("STATUS_INVALID_IMAGE_FORMAT"),
        0xC000_0135 => Some("STATUS_DLL_NOT_FOUND"),
        0xC000_0139 => Some("STATUS_ENTRYPOINT_NOT_FOUND"),
        0xC000_013A => Some("STATUS_CONTROL_C_EXIT"),
        0xC000_0142 => Some("STATUS_DLL_INIT_FAILED"),
        0xC000_0374 => Some("STATUS_HEAP_CORRUPTION"),
        0xC000_0409 => Some("STATUS_STACK_BUFFER_OVERRUN"),
        _ => None,
    };
    Some(match name {
        Some(name) => format!("[launcher] child exited with NTSTATUS 0x{code:08X} ({name})"),
        None => format!("[launcher] child exited with NTSTATUS 0x{code:08X}"),
    })
}

#[cfg(any(windows, test))]
fn build_windows_command_line(cfg: &LaunchConfig) -> String {
    let mut parts = Vec::with_capacity(cfg.args.len() + 1);
    parts.push(quote_windows_arg(&cfg.file));
    parts.extend(cfg.args.iter().map(|arg| quote_windows_arg(arg)));
    parts.join(" ")
}

#[cfg(unix)]
fn run(cfg: LaunchConfig) -> Result<i32, String> {
    use std::os::unix::process::CommandExt;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    let mut command = Command::new(&cfg.file);
    command
        .args(&cfg.args)
        // Ordinary commands reserve stdin for the liveness channel. MCP uses
        // stdio passthrough and monitors the Electron parent by PID instead.
        .stdin(if cfg.stdio_passthrough {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to spawn target: {err}"))?;
    let target_pgid = child.id() as i32;
    let parent_lost = Arc::new(AtomicBool::new(false));

    if cfg.stdio_passthrough {
        eprintln!("[sandbox-launcher-ready] {}", child.id());
    }

    if cfg.monitor_parent {
        let parent_lost = Arc::clone(&parent_lost);
        thread::spawn(move || {
            let mut stdin = io::stdin();
            let mut byte = [0u8; 1];
            loop {
                match stdin.read(&mut byte) {
                    Ok(0) | Err(_) => {
                        parent_lost.store(true, Ordering::Release);
                        unsafe {
                            let _ = libc::kill(-target_pgid, libc::SIGKILL);
                        }
                        break;
                    }
                    Ok(_) => {}
                }
            }
        });
    }

    if let Some(parent_pid) = cfg.parent_pid.filter(|pid| *pid > 0) {
        let parent_lost = Arc::clone(&parent_lost);
        thread::spawn(move || loop {
            let still_parent = unsafe { libc::getppid() == parent_pid as i32 };
            let parent_alive = unsafe { libc::kill(parent_pid as i32, 0) == 0 }
                || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
            if !still_parent || !parent_alive {
                parent_lost.store(true, Ordering::Release);
                unsafe {
                    let _ = libc::kill(-target_pgid, libc::SIGKILL);
                }
                break;
            }
            thread::sleep(Duration::from_millis(100));
        });
    }

    let status = child
        .wait()
        .map_err(|err| format!("failed to wait for target: {err}"))?;

    // The direct target can exit after spawning a same-group background child.
    // Keep the launcher (and therefore commandHost's registry entry) alive until
    // every process in the owned group is gone.
    loop {
        let alive = unsafe { libc::kill(-target_pgid, 0) == 0 };
        if !alive {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ESRCH) {
                break;
            }
        }
        thread::sleep(Duration::from_millis(25));
    }

    if parent_lost.load(Ordering::Acquire) {
        return Ok(137);
    }

    if let Some(code) = status.code() {
        Ok(code)
    } else if let Some(sig) = status.signal() {
        Ok(128 + sig)
    } else {
        Ok(1)
    }
}

#[cfg(windows)]
fn run(cfg: LaunchConfig) -> Result<i32, String> {
    windows::run_with_job_object(cfg)
}

#[cfg(windows)]
mod windows {
    use super::LaunchConfig;
    use core::ffi::c_void;
    use std::ffi::OsStr;
    use std::io::{self, Read};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use std::sync::Arc;
    use std::thread;
    use windows_sys::Win32::Foundation::{
        CloseHandle, DuplicateHandle, GetHandleInformation, GetLastError, DUPLICATE_SAME_ACCESS,
        HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_FAILED,
    };
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, CreateWellKnownSid, WinBuiltinAdministratorsSid,
        WinBuiltinBackupOperatorsSid, WinBuiltinPowerUsersSid, DISABLE_MAX_PRIVILEGE,
        SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_QUERY,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING, SYNCHRONIZE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcess, OpenProcessToken,
        ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
        EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    struct OwnedHandle(HANDLE);

    unsafe impl Send for OwnedHandle {}
    unsafe impl Sync for OwnedHandle {}

    impl OwnedHandle {
        fn new(handle: HANDLE) -> Result<Self, String> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                Err(format!("Win32 handle creation failed: {}", unsafe {
                    GetLastError()
                }))
            } else {
                Ok(Self(handle))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn wide_null(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }

    struct ProcThreadAttributeList {
        _storage: Vec<usize>,
        ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl ProcThreadAttributeList {
        fn for_handles(handles: &[HANDLE]) -> Result<Self, String> {
            let mut bytes = 0usize;
            unsafe {
                let _ = InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err(format!(
                    "InitializeProcThreadAttributeList sizing failed: {}",
                    unsafe { GetLastError() }
                ));
            }

            let words = bytes.div_ceil(size_of::<usize>());
            let mut storage = vec![0usize; words];
            let ptr = storage.as_mut_ptr().cast::<c_void>();
            let initialized = unsafe { InitializeProcThreadAttributeList(ptr, 1, 0, &mut bytes) };
            if initialized == 0 {
                return Err(format!(
                    "InitializeProcThreadAttributeList failed: {}",
                    unsafe { GetLastError() }
                ));
            }

            let updated = unsafe {
                UpdateProcThreadAttribute(
                    ptr,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr().cast::<c_void>(),
                    std::mem::size_of_val(handles),
                    null_mut(),
                    null(),
                )
            };
            if updated == 0 {
                unsafe {
                    DeleteProcThreadAttributeList(ptr);
                }
                return Err(format!(
                    "UpdateProcThreadAttribute(HANDLE_LIST) failed: {}",
                    unsafe { GetLastError() }
                ));
            }

            Ok(Self {
                _storage: storage,
                ptr,
            })
        }
    }

    impl Drop for ProcThreadAttributeList {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr);
            }
        }
    }

    fn duplicate_inheritable_handle(source: HANDLE, label: &str) -> Result<OwnedHandle, String> {
        if source.is_null() || source == INVALID_HANDLE_VALUE {
            return Err(format!("{label} is not a valid Win32 handle"));
        }

        let mut source_flags = 0u32;
        if unsafe { GetHandleInformation(source, &mut source_flags) } == 0 {
            return Err(format!(
                "GetHandleInformation({label}) failed: {}",
                unsafe { GetLastError() }
            ));
        }

        let current_process = unsafe { GetCurrentProcess() };
        let mut duplicate = null_mut();
        let duplicated = unsafe {
            DuplicateHandle(
                current_process,
                source,
                current_process,
                &mut duplicate,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if duplicated == 0 {
            return Err(format!("DuplicateHandle({label}) failed: {}", unsafe {
                GetLastError()
            }));
        }
        let duplicate = OwnedHandle::new(duplicate)?;

        let mut duplicate_flags = 0u32;
        if unsafe { GetHandleInformation(duplicate.raw(), &mut duplicate_flags) } == 0 {
            return Err(format!(
                "GetHandleInformation(duplicated {label}) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        if duplicate_flags & HANDLE_FLAG_INHERIT == 0 {
            return Err(format!("duplicated {label} is not inheritable"));
        }

        Ok(duplicate)
    }

    fn inherited_std_handles(stdio_passthrough: bool) -> Result<[OwnedHandle; 3], String> {
        let stdin = if stdio_passthrough {
            duplicate_inheritable_handle(
                unsafe { GetStdHandle(STD_INPUT_HANDLE) },
                "standard input",
            )?
        } else {
            let null_name = wide_null(OsStr::new("NUL"));
            let null_stdin = OwnedHandle::new(unsafe {
                CreateFileW(
                    null_name.as_ptr(),
                    FILE_GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            })?;
            duplicate_inheritable_handle(null_stdin.raw(), "NUL standard input")?
        };
        let stdout = duplicate_inheritable_handle(
            unsafe { GetStdHandle(STD_OUTPUT_HANDLE) },
            "standard output",
        )?;
        let stderr = duplicate_inheritable_handle(
            unsafe { GetStdHandle(STD_ERROR_HANDLE) },
            "standard error",
        )?;
        Ok([stdin, stdout, stderr])
    }

    fn create_restricted_primary_token() -> Result<OwnedHandle, String> {
        let mut process_token = null_mut();
        let opened = unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY,
                &mut process_token,
            )
        };
        if opened == 0 {
            return Err(format!("OpenProcessToken failed: {}", unsafe {
                GetLastError()
            }));
        }
        let process_token = OwnedHandle::new(process_token)?;

        // Keep ordinary user/group access for tool compatibility, but remove
        // token privileges and make elevated local groups deny-only.
        let sid_types = [
            WinBuiltinAdministratorsSid,
            WinBuiltinPowerUsersSid,
            WinBuiltinBackupOperatorsSid,
        ];
        let mut sid_storage = [[0u8; SECURITY_MAX_SID_SIZE as usize]; 3];
        let mut deny_only_sids = Vec::with_capacity(sid_types.len());
        for (sid_type, storage) in sid_types.into_iter().zip(sid_storage.iter_mut()) {
            let mut sid_bytes = storage.len() as u32;
            let created = unsafe {
                CreateWellKnownSid(
                    sid_type,
                    null_mut(),
                    storage.as_mut_ptr().cast::<c_void>(),
                    &mut sid_bytes,
                )
            };
            if created == 0 {
                return Err(format!("CreateWellKnownSid failed: {}", unsafe {
                    GetLastError()
                }));
            }
            deny_only_sids.push(SID_AND_ATTRIBUTES {
                Sid: storage.as_mut_ptr().cast::<c_void>(),
                Attributes: 0,
            });
        }

        let mut restricted_token = null_mut();
        let restricted = unsafe {
            CreateRestrictedToken(
                process_token.raw(),
                DISABLE_MAX_PRIVILEGE,
                deny_only_sids.len() as u32,
                deny_only_sids.as_ptr(),
                0,
                null(),
                0,
                null(),
                &mut restricted_token,
            )
        };
        if restricted == 0 {
            return Err(format!("CreateRestrictedToken failed: {}", unsafe {
                GetLastError()
            }));
        }
        OwnedHandle::new(restricted_token)
    }

    fn create_kill_on_close_job() -> Result<OwnedHandle, String> {
        let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(format!(
                "SetInformationJobObject(KILL_ON_JOB_CLOSE) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(job)
    }

    fn active_job_processes(job: HANDLE) -> Result<u32, String> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast::<c_void>(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        if queried == 0 {
            return Err(format!(
                "QueryInformationJobObject(BasicAccounting) failed: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(info.ActiveProcesses)
    }

    pub fn run_with_job_object(cfg: LaunchConfig) -> Result<i32, String> {
        let job = Arc::new(create_kill_on_close_job()?);
        let command_line_string = super::build_windows_command_line(&cfg);
        let mut command_line = wide_null(OsStr::new(&command_line_string));
        let std_handles = inherited_std_handles(cfg.stdio_passthrough)?;
        let handle_values = [
            std_handles[0].raw(),
            std_handles[1].raw(),
            std_handles[2].raw(),
        ];
        let attributes = ProcThreadAttributeList::for_handles(&handle_values)?;
        let restricted_token = if cfg.sandbox_enabled {
            Some(create_restricted_primary_token()?)
        } else {
            None
        };

        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handle_values[0];
        startup.StartupInfo.hStdOutput = handle_values[1];
        startup.StartupInfo.hStdError = handle_values[2];
        startup.lpAttributeList = attributes.ptr;
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        let creation_flags = CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT;

        // A null lpApplicationName makes Windows resolve the first, quoted
        // command-line token through its normal executable search and append
        // .exe when appropriate. Passing a short name as lpApplicationName
        // would skip PATH lookup and was the original launch failure.
        let ok = unsafe {
            if let Some(token) = restricted_token.as_ref() {
                CreateProcessAsUserW(
                    token.raw(),
                    null(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    creation_flags,
                    null(),
                    null(),
                    &startup.StartupInfo,
                    &mut process_info,
                )
            } else {
                CreateProcessW(
                    null(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    creation_flags,
                    null(),
                    null(),
                    &startup.StartupInfo,
                    &mut process_info,
                )
            }
        };
        if ok == 0 {
            let api = if restricted_token.is_some() {
                "CreateProcessAsUserW"
            } else {
                "CreateProcessW"
            };
            return Err(format!("{api} failed: {}", unsafe { GetLastError() }));
        }

        let process_handle = OwnedHandle::new(process_info.hProcess)?;
        let thread_handle = OwnedHandle::new(process_info.hThread)?;

        let assigned = unsafe { AssignProcessToJobObject(job.raw(), process_handle.raw()) };
        if assigned == 0 {
            unsafe {
                let _ = windows_sys::Win32::System::Threading::TerminateProcess(
                    process_handle.raw(),
                    1,
                );
            }
            return Err(format!("AssignProcessToJobObject failed: {}", unsafe {
                GetLastError()
            }));
        }

        if unsafe { ResumeThread(thread_handle.raw()) } == u32::MAX {
            unsafe {
                let _ = windows_sys::Win32::System::Threading::TerminateProcess(
                    process_handle.raw(),
                    1,
                );
            }
            return Err(format!("ResumeThread failed: {}", unsafe {
                GetLastError()
            }));
        }

        if cfg.stdio_passthrough {
            eprintln!("[sandbox-launcher-ready] {}", process_info.dwProcessId);
        }

        if cfg.monitor_parent {
            let parent_job = Arc::clone(&job);
            thread::spawn(move || {
                let mut stdin = io::stdin();
                let mut byte = [0u8; 1];
                loop {
                    match stdin.read(&mut byte) {
                        Ok(0) | Err(_) => {
                            unsafe {
                                let _ = TerminateJobObject(parent_job.raw(), 1);
                            }
                            break;
                        }
                        Ok(_) => {}
                    }
                }
            });
        }

        if let Some(parent_pid) = cfg.parent_pid.filter(|pid| *pid > 0) {
            let parent_handle =
                OwnedHandle::new(unsafe { OpenProcess(SYNCHRONIZE, 0, parent_pid) })?;
            let parent_job = Arc::clone(&job);
            thread::spawn(move || {
                let wait = unsafe { WaitForSingleObject(parent_handle.raw(), INFINITE) };
                if wait != WAIT_FAILED {
                    unsafe {
                        let _ = TerminateJobObject(parent_job.raw(), 1);
                    }
                }
            });
        }

        let wait = unsafe { WaitForSingleObject(process_handle.raw(), INFINITE) };
        if wait == WAIT_FAILED {
            return Err(format!("WaitForSingleObject failed: {}", unsafe {
                GetLastError()
            }));
        }

        let mut exit_code = 1u32;
        let got = unsafe { GetExitCodeProcess(process_handle.raw(), &mut exit_code) };
        if got == 0 {
            return Err(format!("GetExitCodeProcess failed: {}", unsafe {
                GetLastError()
            }));
        }

        // A loader/init crash (e.g. 0xC0000142) produces no stderr of its own;
        // this line is the only in-band evidence the child never ran.
        if let Some(hint) = super::ntstatus_exit_hint(exit_code) {
            eprintln!("{hint}");
        }

        // Keep the last Job handle alive after the direct target exits. Shells
        // such as PowerShell can launch a background child and return
        // immediately; closing KILL_ON_JOB_CLOSE here would kill a successfully
        // started service and make Windows background semantics differ from
        // Unix. Parent-liveness termination drives this count to zero too.
        while active_job_processes(job.raw())? > 0 {
            thread::sleep(std::time::Duration::from_millis(25));
        }
        Ok(exit_code as i32)
    }
}

fn main() {
    match read_config().and_then(run) {
        Ok(code) => process::exit(code),
        Err(err) => {
            eprintln!("[sandbox-launcher] {err}");
            process::exit(127);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_windows_command_line, ntstatus_exit_hint, quote_windows_arg, LaunchConfig};

    #[test]
    fn maps_known_ntstatus_exit_codes_to_structured_hints() {
        assert_eq!(
            ntstatus_exit_hint(0xC0000142).as_deref(),
            Some("[launcher] child exited with NTSTATUS 0xC0000142 (STATUS_DLL_INIT_FAILED)")
        );
        assert_eq!(
            ntstatus_exit_hint(0xC0000135).as_deref(),
            Some("[launcher] child exited with NTSTATUS 0xC0000135 (STATUS_DLL_NOT_FOUND)")
        );
        assert_eq!(
            ntstatus_exit_hint(0xC0000005).as_deref(),
            Some("[launcher] child exited with NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION)")
        );
    }

    #[test]
    fn unknown_ntstatus_error_codes_still_get_a_hex_hint() {
        assert_eq!(
            ntstatus_exit_hint(0xC0FFEE00).as_deref(),
            Some("[launcher] child exited with NTSTATUS 0xC0FFEE00")
        );
    }

    #[test]
    fn ordinary_exit_codes_get_no_ntstatus_hint() {
        assert_eq!(ntstatus_exit_hint(0), None);
        assert_eq!(ntstatus_exit_hint(1), None);
        assert_eq!(ntstatus_exit_hint(127), None);
        assert_eq!(ntstatus_exit_hint(137), None);
        // Warning-severity NTSTATUS values are not crash exits.
        assert_eq!(ntstatus_exit_hint(0x8000_0003), None);
    }

    #[test]
    fn parses_camel_case_sandbox_flag() {
        let cfg: LaunchConfig =
            serde_json::from_str(r#"{"file":"node","args":["--version"],"sandboxEnabled":true}"#)
                .expect("valid launch config");
        assert_eq!(cfg.file, "node");
        assert_eq!(cfg.args, ["--version"]);
        assert!(cfg.sandbox_enabled);
    }

    #[test]
    fn sandbox_flag_defaults_to_false_for_legacy_callers() {
        let cfg: LaunchConfig =
            serde_json::from_str(r#"{"file":"node","args":[]}"#).expect("valid launch config");
        assert!(!cfg.sandbox_enabled);
    }

    #[test]
    fn quotes_windows_arguments_using_command_line_to_argv_rules() {
        assert_eq!(quote_windows_arg("node"), "node");
        assert_eq!(quote_windows_arg(""), r#""""#);
        assert_eq!(quote_windows_arg(r#"two words"#), r#""two words""#);
        assert_eq!(quote_windows_arg(r#"a"b"#), r#""a\"b""#);
        assert_eq!(
            quote_windows_arg(r#"C:\path with space\"#),
            r#""C:\path with space\\""#
        );
    }

    #[test]
    fn command_line_quotes_executable_paths_and_preserves_argument_order() {
        let cfg = LaunchConfig {
            file: r#"C:\Program Files\nodejs\node.exe"#.to_string(),
            args: vec!["--eval".to_string(), "console.log('ok')".to_string()],
            sandbox_enabled: false,
            monitor_parent: false,
            stdio_passthrough: false,
            parent_pid: None,
        };
        assert_eq!(
            build_windows_command_line(&cfg),
            r#""C:\Program Files\nodejs\node.exe" --eval console.log('ok')"#
        );
    }

    #[test]
    fn parses_stdio_parent_monitoring_fields() {
        let cfg: LaunchConfig =
            serde_json::from_str(r#"{"file":"node","stdioPassthrough":true,"parentPid":1234}"#)
                .expect("valid launch config");
        assert!(cfg.stdio_passthrough);
        assert_eq!(cfg.parent_pid, Some(1234));
        assert!(!cfg.monitor_parent);
    }
}
