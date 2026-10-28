!include "LogicLib.nsh"

!macro AbuEnvironment NAME VALUE
  System::Call 'kernel32::SetEnvironmentVariableW(w "${NAME}", w "${VALUE}") i.r0'
  ${If} $0 == 0
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro AbuRunTransaction ACTION
  SetOutPath $PLUGINSDIR
  nsExec::Exec `"$AbuHelperShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\abu-installer-transaction.ps1" -Action ${ACTION}`
  Pop $AbuHelperResult
!macroend

Function AbuInitializeTransaction
  StrCpy $AbuFailed ""
  StrCpy $AbuRecoveryResult 0
  StrCpy $AbuTransactionStarted ""
  StrCpy $AbuPreviousUsable ""
  StrCpy $AbuFailureCode 2
  ReadRegStr $AbuExistingLocation HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  File "${BUILD_RESOURCES_DIR}\abu-installer-transaction.ps1"
  File "${BUILD_RESOURCES_DIR}\abu-installer-job.cs"
  File /oname=7za.exe "${BUILD_RESOURCES_DIR}\..\.agent\installer-tools\7za.exe"
  File "${BUILD_RESOURCES_DIR}\..\.agent\installer-tools\7zip-LICENSE.txt"
  File "${BUILD_RESOURCES_DIR}\..\.agent\installer-tools\7zip-COPYING"
  StrCpy $AbuHelperShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  StrCpy $AbuFinalDirectory $INSTDIR
  !insertmacro AbuEnvironment "ABU_INSTALLER_DIRECTORY" "$AbuFinalDirectory"
  !insertmacro AbuEnvironment "ABU_INSTALLER_ID" "${APP_GUID}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_EXE" "${APP_EXECUTABLE_FILENAME}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_UNINSTALLER" "${UNINSTALL_FILENAME}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_REGISTRY" "${INSTALL_REGISTRY_KEY}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_UNINSTALL_KEY" "${UNINSTALL_REGISTRY_KEY}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_VERSION" "${VERSION}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_LINKS" "[]"
  !insertmacro AbuEnvironment "ABU_INSTALLER_EXTRACTOR" "$PLUGINSDIR\7za.exe"
  !insertmacro AbuEnvironment "ABU_INSTALLER_CACHE" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
  !insertmacro AbuEnvironment "ABU_INSTALLER_SOURCE" "$EXEPATH"
  !insertmacro AbuEnvironment "ABU_INSTALLER_UNPACKED_KB" "${APP_64_UNPACKED_SIZE}"
  ${If} ${FileExists} "$AbuFinalDirectory.abu-update\*.*"
    !insertmacro AbuRunTransaction Recover
    ${If} $AbuHelperResult != 0
      StrCpy $AbuRecoveryResult 2
      Call AbuRecoverFailure
    ${EndIf}
  ${EndIf}
FunctionEnd

Function AbuRecoverSelectedLocation
  StrCpy $AbuHelperResult 0
  ${If} ${FileExists} "$AbuPath.abu-update\*.*"
    StrCpy $AbuFinalDirectory $AbuPath
    !insertmacro AbuEnvironment "ABU_INSTALLER_DIRECTORY" "$AbuPath"
    !insertmacro AbuRunTransaction Recover
  ${EndIf}
FunctionEnd

Function AbuRecoverFailure
  StrCpy $AbuFailureCode $AbuHelperResult
  StrCpy $INSTDIR $AbuFinalDirectory
  ${If} $AbuTransactionStarted == "1"
    !insertmacro AbuRunTransaction Recover
    StrCpy $AbuRecoveryResult $AbuHelperResult
    ${If} $AbuRecoveryResult == 0
    ${AndIf} $AbuExistingLocation != ""
      StrCpy $AbuPreviousUsable "1"
    ${EndIf}
  ${EndIf}
  StrCpy $AbuFailed "1"
  SetErrorLevel 2
FunctionEnd

Function AbuStopSilentFailure
  ${If} ${Silent}
    ${If} ${isForceRun}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(AbuUpdateFailed)$\r$\n$(AbuFailureLog)$\r$\n$AbuFinalDirectory.abu-install.log"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ${If} $AbuFailed == "1"
    SetErrorLevel 2
  ${EndIf}
FunctionEnd

!macro AbuFailInstallation
  Call AbuRecoverFailure
  Goto abuInstallResult
!macroend
