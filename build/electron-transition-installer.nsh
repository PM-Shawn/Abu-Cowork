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
# visible in Windows Installed Apps again. This is deliberately path-checked and
# never deletes either application's files or user data.
!macro customUnInstall
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "InstallLocation"
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "UninstallString"
  ${If} $R0 == "$LOCALAPPDATA\Abu"
  ${OrIf} $R0 == '$\"$LOCALAPPDATA\Abu$\"'
    ${If} $R1 == '$\"$LOCALAPPDATA\Abu\uninstall.exe$\"'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "SystemComponent"
    ${EndIf}
  ${EndIf}
!macroend
