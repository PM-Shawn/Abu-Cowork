!include "nsDialogs.nsh"
!include "FileFunc.nsh"
ShowInstDetails nevershow

LangString AbuInstall 1033 "Install now"
LangString AbuInstall 2052 "立即安装"
LangString AbuTitle 1033 "Abu"
LangString AbuTitle 2052 "阿布"
LangString AbuChoose 1033 "Choose installation location"
LangString AbuChoose 2052 "选择安装位置"
LangString AbuChange 1033 "Change"
LangString AbuChange 2052 "更改"
LangString AbuBrowse 1033 "Browse…"
LangString AbuBrowse 2052 "浏览…"
LangString AbuComplete 1033 "Installation complete"
LangString AbuComplete 2052 "安装完成"
LangString AbuLaunch 1033 "Launch Abu"
LangString AbuLaunch 2052 "启动阿布"
LangString AbuClose 1033 "Close"
LangString AbuClose 2052 "关闭"
LangString AbuInvalid 1033 "Choose a valid installation location."
LangString AbuInvalid 2052 "请选择有效的安装位置。"
LangString AbuOccupied 1033 "Choose an empty folder."
LangString AbuOccupied 2052 "请选择空文件夹。"
LangString AbuWritable 1033 "The installation location cannot be written to."
LangString AbuWritable 2052 "无法写入安装位置。"
LangString AbuSpace 1033 "There is not enough disk space."
LangString AbuSpace 2052 "磁盘空间不足。"
LangString AbuIntro 1033 "Choose a location and start using Abu."
LangString AbuIntro 2052 "安装后即可开始使用阿布。"
LangString AbuReady 1033 "Abu is ready to open."
LangString AbuReady 2052 "阿布已安装，随时开始你的工作。"
LangString AbuLocation 1033 "Installation location"
LangString AbuLocation 2052 "安装位置"
LangString AbuUpdateTitle 1033 "Update now"
LangString AbuUpdateTitle 2052 "立即更新"
LangString AbuUpdateIntro 1033 "Your current installation location will be kept."
LangString AbuUpdateIntro 2052 "更新将使用当前安装位置。"
LangString AbuKeepLocation 1033 "Use the current installation location to update Abu."
LangString AbuKeepLocation 2052 "请使用当前安装位置更新阿布。"
LangString AbuUpdateFailed 1033 "Installation could not be completed"
LangString AbuUpdateFailed 2052 "安装未能完成"
LangString AbuRecovered 1033 "Your current version is preserved. You can continue using Abu."
LangString AbuRecovered 2052 "当前版本已保留，你可以继续使用阿布。"
LangString AbuContinue 1033 "Use current version"
LangString AbuContinue 2052 "继续使用当前版本"
LangString AbuRetryLater 1033 "You can run the installer again when you are ready to retry."
LangString AbuRetryLater 2052 "你可以稍后重新运行安装程序。"
LangString AbuRecoveryFailed 1033 "Automatic recovery could not finish. Your backup has been kept. See the installation log for details."
LangString AbuRecoveryFailed 2052 "自动恢复未能完成，已有备份会继续保留。请查看日志了解原因。"
LangString AbuFreshFailed 1033 "Installation stopped. Check the log and try again."
LangString AbuFreshFailed 2052 "安装已停止。请查看日志后重试。"
LangString AbuFailureLog 1033 "View log"
LangString AbuFailureLog 2052 "查看日志"
LangString AbuPreparing 1033 "Installing application files…"
LangString AbuPreparing 2052 "正在安装应用文件…"
LangString AbuApplying 1033 "Completing installation…"
LangString AbuApplying 2052 "正在完成安装…"
LangString AbuVersion 1033 "Version ${VERSION}"
LangString AbuVersion 2052 "版本 ${VERSION}"
LangString AbuUpdating 1033 "Updating Abu"
LangString AbuUpdating 2052 "正在更新阿布"
LangString AbuInstalling 1033 "Installing Abu"
LangString AbuInstalling 2052 "正在安装阿布"
LangString AbuUpdateComplete 1033 "Update complete"
LangString AbuUpdateComplete 2052 "更新完成"
LangString AbuUpdateNotCompleted 1033 "Update could not be completed"
LangString AbuUpdateNotCompleted 2052 "更新未能完成"
LangString AbuCloseInstaller 1033 "Close installer"
LangString AbuCloseInstaller 2052 "关闭安装程序"
LangString AbuRetry 1033 "Retry update"
LangString AbuRetry 2052 "重试更新"
LangString AbuRetryInstall 1033 "Try again"
LangString AbuRetryInstall 2052 "重新安装"
LangString AbuDetails 1033 "View details"
LangString AbuDetails 2052 "查看详情"
LangString AbuLockedTitle 1033 "Unable to update right now"
LangString AbuLockedTitle 2052 "暂时无法完成更新"
LangString AbuLockedCopy 1033 "Some app files are being used by another program.$\r$\nClose that program and try again."
LangString AbuLockedCopy 2052 "部分应用文件正在被其他程序使用。$\r$\n请关闭相关程序后，再试一次。"
LangString AbuDamagedTitle 1033 "Download the installer again"
LangString AbuDamagedTitle 2052 "需要重新下载安装包"
LangString AbuDamagedCopy 1033 "This installer is incomplete or damaged.$\r$\nDownload a new installer from the Abu website."
LangString AbuDamagedCopy 2052 "这个安装包不完整或已损坏。$\r$\n请从阿布官网下载新的安装包后，再次安装。"
LangString AbuDownload 1033 "Download again"
LangString AbuDownload 2052 "前往官网下载"
LangString AbuHelpTitle 1033 "Abu needs recovery"
LangString AbuHelpTitle 2052 "阿布还需要恢复"
LangString AbuHelpCopy 1033 "Abu could not be restored after the update stopped.$\r$\nKeep the existing files and view the recovery steps."
LangString AbuHelpCopy 2052 "更新中断后，阿布暂时无法恢复到可用状态。$\r$\n请保留现有文件，并查看处理说明。"
LangString AbuBackupKept 1033 "The previous version's backup has been kept."
LangString AbuBackupKept 2052 "原版本的备份已保留。"
LangString AbuFilesKept 1033 "Your existing files have been kept."
LangString AbuFilesKept 2052 "现有文件已保留。"
LangString AbuHelp 1033 "Recovery steps"
LangString AbuHelp 2052 "查看处理说明"
LangString AbuHelpDetail 1033 "Close programs using Abu files and run the installer again. If recovery still fails, send the installation log to Abu support and keep the backup files."
LangString AbuHelpDetail 2052 "请关闭可能占用阿布文件的程序，再运行安装程序。若仍无法恢复，请将安装日志提供给阿布支持人员，并保留备份文件。"
LangString AbuGenericCopy 1033 "The installation stopped. View details and try again."
LangString AbuGenericCopy 2052 "安装未能完成，请查看详情后重试。"
LangString AbuGenericDetail 1033 "The installation log contains the operation that failed."
LangString AbuGenericDetail 2052 "安装日志记录了未完成的操作及具体原因。"
LangString AbuPreparingInstall 1033 "Preparing installation…"
LangString AbuPreparingInstall 2052 "正在准备安装…"
LangString AbuPreparingUpdate 1033 "Preparing update…"
LangString AbuPreparingUpdate 2052 "正在准备更新…"

Var AbuDialog
Var AbuPath
Var AbuEdit
Var AbuBrowseButton
Var AbuChooseButton
Var AbuError
Var AbuErrorLabel
Var AbuIcon
Var AbuTitleFont
Var AbuBodyFont
Var AbuCaptionFont
Var AbuExistingLocation
Var AbuProgressLabel
Var AbuPageState
Var AbuInstalledVersion
Var AbuFailureCode
Var AbuDetailsLabel
Var AbuLogButton
Var AbuDetailsOpen
Var AbuFailurePrimary
Var AbuContinueButton
Var AbuExitRequested
Var AbuPreviousUsable

!include "${BUILD_RESOURCES_DIR}\abu-installer-theme.nsh"

Function AbuShowProgress
  StrCpy $AbuPageState "progress"
  FindWindow $AbuDialog "#32770" "" $HWNDPARENT
  Call AbuSizePage
  System::Call 'user32::GetWindow(p $AbuDialog, i 5) p.r0'
  ${DoWhile} $0 != 0
    ShowWindow $0 0
    System::Call 'user32::GetWindow(p r0, i 2) p.r0'
  ${Loop}
  GetDlgItem $0 $HWNDPARENT 1037
  System::Call 'user32::SetParent(p r0, p $AbuDialog)'
  !insertmacro AbuPlace $0 32 148 416 28
  SendMessage $0 ${WM_SETFONT} $AbuTitleFont 1
  SetCtlColors $0 1D1D1F FFFFFF
  ${NSD_AddStyle} $0 ${SS_CENTER}
  ${NSD_SetText} $0 "$(AbuTitle)"
  ShowWindow $0 5
  GetDlgItem $0 $HWNDPARENT 1038
  System::Call 'user32::SetParent(p r0, p $AbuDialog)'
  !insertmacro AbuPlace $0 32 306 416 24
  SendMessage $0 ${WM_SETFONT} $AbuBodyFont 1
  SetCtlColors $0 5C5C61 FFFFFF
  ${NSD_AddStyle} $0 ${SS_CENTER}
  ${NSD_SetText} $0 "$(AbuPreparingInstall)"
  ${If} $AbuExistingLocation != ""
    ${NSD_SetText} $0 "$(AbuPreparingUpdate)"
  ${EndIf}
  StrCpy $AbuProgressLabel $0
  ShowWindow $0 5
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "×", i 0x50000081, i 0, i 0, i 1, i 1, p $AbuDialog, p 0, p 0, p 0) p.r0'
  !insertmacro AbuPlace $0 440 10 28 24
  SendMessage $0 ${WM_SETFONT} $AbuBodyFont 1
  SetCtlColors $0 A0A0A5 FFFFFF
  Call AbuPageIcon
  GetDlgItem $0 $AbuDialog 1004
  !insertmacro AbuPlace $0 48 286 384 6
  System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
  SendMessage $0 0x409 0 0x1F1D1D
  SendMessage $0 0x2001 0 0xF0EFEF
  System::Call 'user32::GetWindowLongW(p r0, i -16) i.r1'
  IntOp $1 $1 | 8
  System::Call 'user32::SetWindowLongW(p r0, i -16, i r1)'
  SendMessage $0 0x40A 1 30
  ShowWindow $0 5
FunctionEnd

Function AbuProgressPre
  ${If} $AbuFailed == "1"
    Abort
  ${EndIf}
FunctionEnd

Function AbuPageBase
  Call AbuSizePage
  Call AbuPageChrome
  Call AbuPageIcon
FunctionEnd

Function AbuPageIcon
  ${If} $AbuIcon != ""
  ${AndIf} $AbuIcon != 0
    ${NSD_FreeIcon} $AbuIcon
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\abu.ico "${BUILD_RESOURCES_DIR}\..\src-tauri\icons\icon.ico"
  System::Call 'user32::CreateWindowExW(i 0, w "Static", w "", i 0x50000003, i 0, i 0, i 1, i 1, p $AbuDialog, p 0, p 0, p 0) p.r0'
  SetCtlColors $0 1D1D1F FFFFFF
  !insertmacro AbuPlace $0 208 72 64 64
  System::Call 'kernel32::MulDiv(i 64, i $AbuDpi, i 96) i.r1'
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\abu.ico", i 1, i r1, i r1, i 0x10) p.r1'
  StrCpy $AbuIcon $1
  SendMessage $0 0x170 $AbuIcon 0
FunctionEnd

Function AbuWelcome
  ${If} $AbuFailed == "1"
    Abort
  ${EndIf}
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  StrCpy $AbuPath $INSTDIR
  StrCpy $AbuPageState "welcome"
  ReadRegStr $AbuExistingLocation HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $AbuInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $AbuRetryRequested == "1"
    Call AbuValidatePath
    ${If} $AbuError == ""
      StrCpy $INSTDIR $AbuPath
      Abort
    ${EndIf}
  ${EndIf}
  nsDialogs::Create 1018
  Pop $AbuDialog
  ${If} $AbuDialog == error
    Abort
  ${EndIf}
  Call AbuPageBase
  !insertmacro AbuLabel 32 148 416 28 "$(AbuTitle)" $AbuTitleFont 1D1D1F
  ${NSD_AddStyle} $0 ${SS_CENTER}
  ${If} $AbuExistingLocation != ""
    !insertmacro AbuLabel 32 194 416 20 "$AbuInstalledVersion → ${VERSION}" $AbuBodyFont 5C5C61
    ${NSD_AddStyle} $0 ${SS_CENTER}
  ${EndIf}
  !insertmacro AbuButton 148 286 184 "$(AbuInstall)" AbuStart
  Call AbuDefaultButton
  ${If} $AbuExistingLocation != ""
    ${NSD_SetText} $0 "$(AbuUpdateTitle)"
  ${EndIf}
  !insertmacro AbuButton 140 340 200 "$(AbuChoose)" AbuExpand
  !insertmacro AbuPlace $0 140 340 200 28
  nsDialogs::SetUserData $0 "quiet"
  StrCpy $AbuChooseButton $0
  ${NSD_CreateText} 0 0 1 1 "$AbuPath"
  Pop $AbuEdit
  !insertmacro AbuPlace $AbuEdit 32 304 336 36
  SetCtlColors $AbuEdit 1D1D1F FFFFFF
  SendMessage $AbuEdit ${WM_SETFONT} $AbuBodyFont 1
  ${NSD_OnChange} $AbuEdit AbuPathChanged
  !insertmacro AbuButton 376 302 72 "$(AbuBrowse)" AbuBrowseFolder
  StrCpy $AbuBrowseButton $0
  !insertmacro AbuLabel 32 350 416 36 "$AbuError" $AbuCaptionFont C4281C
  StrCpy $AbuErrorLabel $0
  ShowWindow $AbuEdit 0
  ShowWindow $AbuBrowseButton 0
  ${If} $AbuExistingLocation != ""
    ShowWindow $AbuChooseButton 0
    ${NSD_SetText} $AbuEdit "$AbuExistingLocation"
  ${EndIf}
  System::Call 'user32::PostMessageW(p $AbuDialog, i 0x28, p $AbuPrimaryButton, p 1)'
  nsDialogs::Show
  ${If} $AbuExitRequested == "1"
    Quit
  ${EndIf}
  ${NSD_FreeIcon} $AbuIcon
  StrCpy $AbuIcon 0
FunctionEnd

Function AbuExpand
  Pop $0
  ShowWindow $AbuChooseButton 0
  !insertmacro AbuPlace $AbuPrimaryButton 148 246 184 40
  ShowWindow $AbuEdit 5
  ShowWindow $AbuBrowseButton 5
  System::Call 'user32::SetFocus(p $AbuEdit)'
FunctionEnd

Function AbuBrowseFolder
  Pop $0
  ${NSD_GetText} $AbuEdit $AbuPath
  nsDialogs::SelectFolderDialog "$(AbuChoose)" "$AbuPath"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $AbuEdit "$0"
  ${EndIf}
FunctionEnd

Function AbuPathChanged
  Pop $0
  ${NSD_SetText} $AbuErrorLabel ""
FunctionEnd

Function AbuStart
  Pop $0
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AbuWelcomeLeave
  ${If} $AbuExitRequested == "1"
    Return
  ${EndIf}
  ${NSD_GetText} $AbuEdit $AbuPath
  Call AbuValidatePath
  ${If} $AbuError != ""
    ${NSD_SetText} $AbuErrorLabel "$AbuError"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $AbuPath
FunctionEnd

Function AbuValidatePath
  StrCpy $AbuError "$(AbuInvalid)"
  ${If} $AbuPath == ""
    Return
  ${EndIf}
  StrCpy $1 0
  ${Do}
    StrCpy $0 $AbuPath 1 $1
    ${If} $0 == ""
      ${ExitDo}
    ${EndIf}
    System::Call 'kernel32::GetStringTypeW(i 1, w r0, i 1, *i .r2) i.r3'
    ${If} $3 == 0
      Return
    ${EndIf}
    IntOp $2 $2 & 0x20
    ${If} $2 != 0
      Return
    ${EndIf}
    ${If} $0 == "*"
    ${OrIf} $0 == "?"
    ${OrIf} $0 == "|"
    ${OrIf} $0 == "<"
    ${OrIf} $0 == ">"
    ${OrIf} $0 == "$\""
    ${OrIf} $0 == "/"
    ${OrIf} $0 == "$\r"
    ${OrIf} $0 == "$\n"
    ${OrIf} $0 == "$\t"
      Return
    ${EndIf}
    ${If} $0 == ":"
    ${AndIf} $1 != 1
      Return
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  System::Call 'shlwapi::PathIsRelativeW(w "$AbuPath") i.r0'
  ${If} $0 != 0
    Return
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$AbuPath", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
    Return
  ${EndIf}
  StrCpy $AbuPath $1
  System::Call 'shlwapi::PathIsRootW(w "$AbuPath") i.r0'
  ${If} $0 != 0
    Return
  ${EndIf}
  StrCpy $2 $AbuPath
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r2) i.r0'
    ${If} $0 != -1
      IntOp $1 $0 & 0x400
      IntOp $0 $0 & 0x10
      ${If} $1 != 0
      ${OrIf} $0 == 0
        Return
      ${EndIf}
    ${EndIf}
    ${GetParent} $2 $3
    ${If} $3 == $2
    ${OrIf} $3 == ""
      ${ExitDo}
    ${EndIf}
    StrCpy $2 $3
  ${Loop}
  Call AbuRecoverSelectedLocation
  ${If} $AbuHelperResult != 0
    StrCpy $AbuRecoveryResult 2
    Call AbuRecoverFailure
    StrCpy $AbuError ""
    Return
  ${EndIf}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
  ${AndIf} $0 != $AbuPath
    StrCpy $AbuError "$(AbuKeepLocation)"
    Return
  ${EndIf}
  ${If} $0 != $AbuPath
  ${OrIfNot} ${FileExists} "$AbuPath\${APP_EXECUTABLE_FILENAME}"
    FindFirst $0 $1 "$AbuPath\*.*"
    ${DoWhile} $1 != ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        FindClose $0
        StrCpy $AbuError "$(AbuOccupied)"
        Return
      ${EndIf}
      FindNext $0 $1
    ${Loop}
    FindClose $0
  ${EndIf}
  StrCpy $2 $AbuPath
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r2) i.r0'
    ${If} $0 != -1
      ${ExitDo}
    ${EndIf}
    ${GetParent} $2 $2
    ${If} $2 == ""
      Return
    ${EndIf}
  ${Loop}
  StrCpy $AbuError "$(AbuWritable)"
  System::Call 'kernel32::GetTempFileNameW(w r2, w "abu", i 0, w .r3) i.r0'
  ${If} $0 == 0
    Return
  ${EndIf}
  System::Call 'kernel32::DeleteFileW(w r3)'
  System::Call 'kernel32::GetDiskFreeSpaceExW(w r2, *l .r0, p 0, p 0) i.r1'
  ${If} $1 == 0
    Return
  ${EndIf}
  StrCpy $AbuError "$(AbuSpace)"
  System::Int64Op ${APP_64_UNPACKED_SIZE} * 1024
  Pop $2
  System::Int64Op $0 < $2
  Pop $0
  ${If} $0 != 0
    Return
  ${EndIf}
  StrCpy $AbuError ""
FunctionEnd

Function AbuFinish
  StrCpy $AbuPageState "result"
  ${If} $AbuFailed == "1"
    Call AbuFailurePage
    Return
  ${EndIf}
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $AbuDialog
  ${If} $AbuDialog == error
    Abort
  ${EndIf}
  Call AbuPageBase
  !insertmacro AbuLabel 32 148 416 24 "$(AbuComplete)" $AbuResultFont 1D1D1F
  ${NSD_AddStyle} $0 ${SS_CENTER}
  ${If} $AbuExistingLocation != ""
    ${NSD_SetText} $0 "$(AbuUpdateComplete)"
  ${EndIf}
  !insertmacro AbuButton 148 286 184 "$(AbuLaunch)" AbuLaunchApp
  Call AbuDefaultButton
  System::Call 'user32::PostMessageW(p $AbuDialog, i 0x28, p $AbuPrimaryButton, p 1)'
  nsDialogs::Show
  ${If} $AbuExitRequested == "1"
    Quit
  ${EndIf}
  ${NSD_FreeIcon} $AbuIcon
  StrCpy $AbuIcon 0
FunctionEnd

Function AbuFailurePage
  StrCpy $AbuPageState "failure"
  StrCpy $AbuDetailsOpen ""
  StrCpy $AbuContinueButton ""
  nsDialogs::Create 1018
  Pop $AbuDialog
  ${If} $AbuDialog == error
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(AbuUpdateFailed)$\r$\n$AbuFinalDirectory.abu-install.log"
    Return
  ${EndIf}
  Call AbuSizePage
  Call AbuCompactResult
  Call AbuPageChrome
  !insertmacro AbuLabel 24 56 20 24 "⚠" $AbuResultFont 935200
  !insertmacro AbuLabel 54 56 402 24 "$(AbuUpdateFailed)" $AbuResultFont 1D1D1F
  ${If} $AbuExistingLocation != ""
    ${NSD_SetText} $0 "$(AbuUpdateNotCompleted)"
  ${EndIf}
  ${If} $AbuRecoveryResult != 0
    ${NSD_SetText} $0 "$(AbuHelpTitle)"
  ${ElseIf} $AbuFailureCode == 20
    ${NSD_SetText} $0 "$(AbuDamagedTitle)"
  ${ElseIf} $AbuFailureCode == 21
  ${AndIf} $AbuExistingLocation != ""
    ${NSD_SetText} $0 "$(AbuLockedTitle)"
  ${EndIf}
  !insertmacro AbuLabel 54 92 402 44 "$(AbuGenericCopy)" $AbuBodyFont 5C5C61
  ${If} $AbuRecoveryResult != 0
    ${NSD_SetText} $0 "$(AbuHelpCopy)"
  ${ElseIf} $AbuFailureCode == 20
    ${NSD_SetText} $0 "$(AbuDamagedCopy)"
  ${ElseIf} $AbuFailureCode == 21
    ${NSD_SetText} $0 "$(AbuLockedCopy)"
  ${EndIf}
  !insertmacro AbuLabel 54 148 402 20 "" $AbuBodyFont 5C5C61
  ${If} $AbuRecoveryResult != 0
    ${NSD_SetText} $0 "$(AbuFilesKept)"
    ${If} ${FileExists} "$AbuFinalDirectory.abu-update\old\${APP_EXECUTABLE_FILENAME}"
      ${NSD_SetText} $0 "$(AbuBackupKept)"
    ${EndIf}
  ${ElseIf} $AbuPreviousUsable == "1"
  ${AndIf} ${FileExists} "$AbuFinalDirectory\${APP_EXECUTABLE_FILENAME}"
    ${NSD_SetText} $0 "$(AbuRecovered)"
  ${EndIf}
  ${If} $AbuRecoveryResult == 0
    !insertmacro AbuButton 42 172 80 "$(AbuDetails)" AbuToggleDetails
    !insertmacro AbuPlace $0 42 172 80 24
    nsDialogs::SetUserData $0 "quiet"
  ${EndIf}
  !insertmacro AbuLabel 54 212 402 76 "$(AbuGenericDetail)" $AbuBodyFont 5C5C61
  StrCpy $AbuDetailsLabel $0
  ${If} $AbuRecoveryResult != 0
    ${NSD_SetText} $0 "$(AbuHelpDetail)"
  ${EndIf}
  ShowWindow $AbuDetailsLabel 0
  !insertmacro AbuButton 42 292 80 "$(AbuFailureLog)" AbuOpenLog
  StrCpy $AbuLogButton $0
  !insertmacro AbuPlace $0 42 292 80 28
  nsDialogs::SetUserData $0 "quiet"
  ShowWindow $AbuLogButton 0
  ${If} $AbuPreviousUsable == "1"
  ${AndIf} ${FileExists} "$AbuFinalDirectory\${APP_EXECUTABLE_FILENAME}"
    !insertmacro AbuButton 160 212 160 "$(AbuContinue)" AbuFailureLaunch
    StrCpy $AbuContinueButton $0
    !insertmacro AbuPlace $0 160 212 160 28
  ${EndIf}
  !insertmacro AbuButton 328 212 128 "$(AbuRetry)" AbuFailureAction
  StrCpy $AbuFailurePrimary $0
  !insertmacro AbuPlace $0 328 212 128 28
  ${If} $AbuRecoveryResult != 0
    ${NSD_SetText} $0 "$(AbuHelp)"
  ${ElseIf} $AbuFailureCode == 20
    ${NSD_SetText} $0 "$(AbuDownload)"
  ${ElseIf} $AbuExistingLocation == ""
    ${NSD_SetText} $0 "$(AbuRetryInstall)"
  ${EndIf}
  Call AbuDefaultButton
  System::Call 'user32::PostMessageW(p $AbuDialog, i 0x28, p $AbuPrimaryButton, p 1)'
  nsDialogs::Show
  ${If} $AbuExitRequested == "1"
    Quit
  ${EndIf}
  ${NSD_FreeIcon} $AbuIcon
  StrCpy $AbuIcon 0
FunctionEnd

Function AbuToggleDetails
  Pop $0
  ${If} $AbuDetailsOpen == "1"
    StrCpy $AbuDetailsOpen ""
    ShowWindow $AbuDetailsLabel 0
    ShowWindow $AbuLogButton 0
    Call AbuCompactResult
    !insertmacro AbuPlace $AbuFailurePrimary 328 212 128 28
    ${If} $AbuContinueButton != ""
      !insertmacro AbuPlace $AbuContinueButton 160 212 160 28
    ${EndIf}
  ${Else}
    StrCpy $AbuDetailsOpen "1"
    System::Call 'kernel32::MulDiv(i 480, i $AbuDpi, i 96) i.r3'
    System::Call 'kernel32::MulDiv(i 384, i $AbuDpi, i 96) i.r4'
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r3, i r4, i 0x16)'
    !insertmacro AbuPlace $AbuDialog 0 0 480 384
    !insertmacro AbuPlace $AbuFailurePrimary 328 332 128 28
    ${If} $AbuContinueButton != ""
      !insertmacro AbuPlace $AbuContinueButton 160 332 160 28
    ${EndIf}
    ShowWindow $AbuDetailsLabel 5
    ShowWindow $AbuLogButton 5
  ${EndIf}
FunctionEnd

Function AbuFailureAction
  Pop $0
  ${If} $AbuRecoveryResult != 0
    Push $0
    Call AbuToggleDetails
  ${ElseIf} $AbuFailureCode == 20
    ExecShell "open" "https://abuwork.com"
  ${Else}
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    ClearErrors
    Exec '"$EXEPATH" /ABURETRYPID=$0 /D=$AbuFinalDirectory'
    ${If} ${Errors}
      Push $0
      Call AbuToggleDetails
      Return
    ${EndIf}
    SetErrorLevel 2
    StrCpy $AbuExitRequested "1"
    SendMessage $HWNDPARENT 0x408 1 0
  ${EndIf}
FunctionEnd

Function AbuOpenLog
  Pop $0
  Exec '"$WINDIR\notepad.exe" "$AbuFinalDirectory.abu-install.log"'
FunctionEnd

Function AbuFailureLaunch
  Pop $0
  ${StdUtils.ExecShellAsUser} $1 "$AbuFinalDirectory\${APP_EXECUTABLE_FILENAME}" "open" ""
  SetErrorLevel 2
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AbuFailureClose
  Pop $0
  SetErrorLevel 2
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AbuLaunchApp
  Pop $0
  ${StdUtils.ExecShellAsUser} $1 "$launchLink" "open" ""
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AbuFinishClose
  Pop $0
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd
