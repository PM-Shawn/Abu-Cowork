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
  Var AbuFinalDirectory
  Var AbuHelperResult
  Var AbuRecoveryResult
  Var AbuTransactionStarted
  Var AbuHelperShell
  Var AbuFailed
  Var AbuRetryRequested
!endif

!macro preInit
  !ifndef BUILD_UNINSTALLER
    StrCpy $AbuRetryRequested ""
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} "$0" "/ABURETRYPID=" $1
    ${IfNot} ${Errors}
      System::Call 'kernel32::OpenProcess(i 0x100000, i 0, i r1) p.r2 ?e'
      Pop $3
      ${If} $2 != 0
        System::Call 'kernel32::WaitForSingleObject(p r2, i 15000) i.r3'
        System::Call 'kernel32::CloseHandle(p r2)'
        ${If} $3 != 0
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${ElseIf} $3 != 87
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $AbuRetryRequested "1"
    ${EndIf}
  !endif
!macroend

!macro customHeader
  LangString AbuAppRunning 1033 "Close Abu and try again."
  LangString AbuAppRunning 2052 "请关闭阿布后重试。"
  LangString AbuProcessError 1033 "Unable to check running applications. Installation cannot continue."
  LangString AbuProcessError 2052 "无法检查正在运行的应用，安装无法继续。"
  LangString AbuFinishUpdateFirst 1033 "Run the Abu installer to complete the unfinished update before uninstalling."
  LangString AbuFinishUpdateFirst 2052 "请运行阿布安装器处理未完成的更新，然后再卸载。"
  !ifndef BUILD_UNINSTALLER
    !include "${BUILD_RESOURCES_DIR}\abu-installer-pages.nsh"
    !include "${BUILD_RESOURCES_DIR}\abu-installer-transaction.nsh"
  !endif
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !include "${BUILD_RESOURCES_DIR}\abu-installer-overrides.nsh"
  !endif
  Var /GLOBAL AbuProcessWaitCount
  StrCpy $AbuProcessWaitCount 0
  System::Call 'kernel32::SetEnvironmentVariableW(w "ABU_INSTALLER_DIRECTORY", w "$INSTDIR") i.r0'
  ${If} $0 == 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  abuCheckProcesses:
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; $$root=$$env:ABU_INSTALLER_DIRECTORY.TrimEnd('\') + '\'; $$found=@(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$root,[StringComparison]::OrdinalIgnoreCase) }); if ($$found.Count -gt 0) { exit 4 }; exit 0"`
    Pop $R0
    ${If} $R0 == 4
      ${If} ${isUpdated}
        IntOp $AbuProcessWaitCount $AbuProcessWaitCount + 1
        ${If} $AbuProcessWaitCount < 30
          Sleep 500
          Goto abuCheckProcesses
        ${EndIf}
      ${EndIf}
      ${IfNot} ${Silent}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(AbuAppRunning)" IDRETRY abuCheckProcesses
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${ElseIf} $R0 != 0
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(AbuProcessError)"
      ${EndIf}
      SetErrorLevel 2
      Quit
    ${EndIf}
!macroend

!macro customWelcomePage
  Page custom AbuWelcome AbuWelcomeLeave
!macroend

!macro customFinishPage
  Page custom AbuFinish
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_PRE AbuProgressPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW AbuShowProgress
!macroend

!macro customInit
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "${APP_GUID}-abu-installation") p.r0 ?e'
  Pop $1
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $abuTauriTransitionUpdate "false"
  SetAutoClose true
  ${If} ${isUpdated}
    SetSilent silent
  ${EndIf}
  ${GetParameters} $R8
  ClearErrors
  ${GetOptions} "$R8" "/UPDATE" $R9
  ${IfNot} ${Errors}
    StrCpy $abuTauriTransitionUpdate "true"
    SetSilent silent
  ${EndIf}
  Call AbuInitializeTransaction
  ${If} $AbuFailed == "1"
    Call AbuStopSilentFailure
    Return
  ${EndIf}
  ${If} ${Silent}
    StrCpy $AbuPath $INSTDIR
    Call AbuValidatePath
    ${If} $AbuFailed == "1"
      Call AbuStopSilentFailure
    ${EndIf}
    ${If} $AbuError != ""
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $INSTDIR $AbuPath
  ${EndIf}
!macroend

!macro customInstallMode
  StrCpy $installMode CurrentUser
  SetShellVarContext current
  Abort
!macroend

!macro customInstall
  abuInstallResult:
  ${If} $AbuFailed != "1"
    !insertmacro AbuRunTransaction Commit
    ${If} $AbuHelperResult != 0
    ${AndIf} $AbuHelperResult != 3
      Call AbuRecoverFailure
    ${EndIf}
  ${EndIf}
  ${If} $AbuFailed == "1"
    Call AbuStopSilentFailure
  ${Else}
    StrCpy $AbuTransactionStarted ""
    ${If} $abuTauriTransitionUpdate == "true"
      # Run after files, registry entries, and shortcuts have been verified.
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--tauri-transition"
    ${EndIf}
  ${EndIf}
!macroend

# If Electron is later removed, make the preserved Tauri rollback installation
# visible in Windows Installed Apps again. The marker is written only after the
# main process has strictly recognized the historical Tauri registry record.
# This avoids re-parsing environment-dependent Windows paths in NSIS and never
# deletes either application's files or user data.
!macro restoreLegacyTauriUninstallVisibility
  # electron-builder compiles its embedded uninstaller before it adds the
  # APP_64 payload define. Its generic architecture helper therefore leaves
  # that uninstaller on the 32-bit registry view even in an x64-only package.
  # The Electron main process uses 64-bit reg.exe, so select the same view
  # explicitly before reading the transition marker it wrote.
  SetRegView 64
  ClearErrors
  ReadRegDWORD $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
  ${If} $R0 == 1
    # The marker is proof that this Electron transition hid the entry. Restore
    # visibility first and clear the proof only after the DWORD is confirmed
    # absent. A short retry absorbs registry/endpoint-security contention; a
    # persistent failure aborts the uninstall instead of leaving a misleading
    # half-restored rollback entry.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "SystemComponent"
    ClearErrors
    ReadRegDWORD $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "SystemComponent"
    ${IfNot} ${Errors}
      Sleep 250
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "SystemComponent"
      ClearErrors
      ReadRegDWORD $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "SystemComponent"
      ${IfNot} ${Errors}
        Abort "Could not restore the preserved Abu rollback entry."
      ${EndIf}
    ${EndIf}

    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
    ClearErrors
    ReadRegDWORD $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
    ${IfNot} ${Errors}
      Sleep 250
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
      ClearErrors
      ReadRegDWORD $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu" "AbuElectronTransitionHidden"
      ${IfNot} ${Errors}
        Abort "Could not clear the Abu rollback transition marker."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro restoreLegacyTauriUninstallVisibility
!macroend

!macro customUnInit
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "${APP_GUID}-abu-installation") p.r0 ?e'
  Pop $1
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR.abu-update\*.*"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(AbuFinishUpdateFirst)"
    ${EndIf}
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
