# Compatibility bridge for the one-time Tauri -> Electron Windows update.
#
# tauri-plugin-updater invokes an NSIS update with:
#   /P /R /UPDATE /ARGS <previous application arguments>
# electron-builder normally understands neither /UPDATE nor /R. Without this
# bridge the Tauri process exits after handing off the installer, but the newly
# installed Electron application is not launched.
#
# Keep the old Tauri installation directory intact for one-release rollback.
# electron-builder installs per-user under UserProgramFiles and rewrites the
# Abu shortcuts to the Electron executable.

!ifndef BUILD_UNINSTALLER
  Var abuTauriTransitionUpdate
!endif

!macro customInit
  StrCpy $abuTauriTransitionUpdate "false"
  ${GetParameters} $R8
  ClearErrors
  ${GetOptions} "$R8" "/UPDATE" $R9
  ${IfNot} ${Errors}
    StrCpy $abuTauriTransitionUpdate "true"
  ${EndIf}
!macroend

!macro customInstall
  ${If} $abuTauriTransitionUpdate == "true"
    # Run only after files, registry entries, and shortcuts have been written.
    # ExecShellAsUser keeps the launched app in the current user's session.
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--tauri-transition"
  ${EndIf}
!macroend

# If Electron is later removed, make the preserved Tauri rollback installation
# visible in Windows Installed Apps again. The marker is written only after the
# main process has strictly recognized the historical Tauri registry record.
# This avoids re-parsing environment-dependent Windows paths in NSIS and never
# deletes either application's files or user data.
!macro customUnInstall
  # electron-builder compiles its embedded uninstaller before it adds the
  # APP_64 payload define. Its generic architecture helper therefore leaves
  # that uninstaller on the 32-bit registry view even in an x64-only package.
  # The Electron main process uses 64-bit reg.exe, so select the same view
  # explicitly before reading the transition marker it wrote.
  SetRegView 64
  ReadRegDWORD $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
  ${If} $R0 == 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "SystemComponent"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
  ${EndIf}
!macroend
