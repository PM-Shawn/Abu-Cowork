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
