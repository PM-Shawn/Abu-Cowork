LangString AbuCloseForUpdate 1033 "Close Abu to update"
LangString AbuCloseForUpdate 2052 "更新需要关闭阿布"
LangString AbuCloseForUpdateCopy 1033 "Abu is still running in the background. Continuing will end its processes. Running tasks will stop and unsaved changes may be lost."
LangString AbuCloseForUpdateCopy 2052 "阿布仍在后台运行。继续将结束相关进程，正在执行的任务会中断，未保存的内容可能丢失。"
LangString AbuCloseAndUpdate 1033 "Close and update"
LangString AbuCloseAndUpdate 2052 "关闭并更新"
LangString AbuCancelUpdate 1033 "Cancel update"
LangString AbuCancelUpdate 2052 "取消更新"
LangString AbuClosingApp 1033 "Closing Abu…"
LangString AbuClosingApp 2052 "正在关闭阿布…"
LangString AbuCloseFailed 1033 "Unable to close Abu"
LangString AbuCloseFailed 2052 "暂时无法关闭阿布"
LangString AbuCloseFailedCopy 1033 "Quit Abu and try again. Your current installation has not changed."
LangString AbuCloseFailedCopy 2052 "请退出阿布后重试。当前版本未更改。"
LangString AbuRetryClose 1033 "Retry closing"
LangString AbuRetryClose 2052 "重试关闭"
LangString AbuCheckFailed 1033 "Unable to check whether Abu is running. Try again."
LangString AbuCheckFailed 2052 "无法检查阿布是否运行，请重试。"
LangString AbuRetryCheck 1033 "Try again"
LangString AbuRetryCheck 2052 "重试"

Var AbuProcessResult
Var AbuProcessTitle
Var AbuProcessCopy
Var AbuProcessCancel
Var AbuProcessConfirm
Var AbuProcessCheckOnly

!macro AbuRunProcessCheck ACTION
  !insertmacro AbuEnvironment "ABU_INSTALLER_DIRECTORY" "$INSTDIR"
  nsExec::Exec /TIMEOUT=15000 `"$AbuHelperShell" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\abu-installer-processes.ps1" -Action ${ACTION}`
  Pop $AbuProcessResult
!macroend

Function AbuProcessPage
  ${If} $AbuFailed == "1"
    Abort
  ${EndIf}
  !insertmacro AbuRunProcessCheck Check
  ${If} $AbuProcessResult == 0
    Abort
  ${EndIf}
  StrCpy $AbuPageState "processes"
  StrCpy $AbuProcessCheckOnly ""
  nsDialogs::Create 1018
  Pop $AbuDialog
  ${If} $AbuDialog == error
    SetErrorLevel 2
    Quit
  ${EndIf}
  Call AbuSizePage
  Call AbuCompactResult
  Call AbuPageChrome
  !insertmacro AbuLabel 24 56 20 24 "⚠" $AbuResultFont 935200
  !insertmacro AbuLabel 54 56 402 24 "$(AbuCloseForUpdate)" $AbuResultFont 1D1D1F
  StrCpy $AbuProcessTitle $0
  !insertmacro AbuLabel 54 92 402 88 "$(AbuCloseForUpdateCopy)" $AbuBodyFont 5C5C61
  StrCpy $AbuProcessCopy $0
  !insertmacro AbuButton 192 212 128 "$(AbuCancelUpdate)" AbuWindowClose
  !insertmacro AbuPlace $0 192 212 128 28
  StrCpy $AbuProcessCancel $0
  !insertmacro AbuButton 328 212 128 "$(AbuCloseAndUpdate)" AbuCloseForInstall
  !insertmacro AbuPlace $0 328 212 128 28
  StrCpy $AbuProcessConfirm $0
  StrCpy $AbuPrimaryButton $0
  ${If} $AbuProcessResult != 4
    StrCpy $AbuProcessCheckOnly "1"
    ${NSD_SetText} $AbuProcessTitle "$(AbuUpdateNotCompleted)"
    ${NSD_SetText} $AbuProcessCopy "$(AbuCheckFailed)"
    ${NSD_SetText} $AbuProcessConfirm "$(AbuRetryCheck)"
  ${EndIf}
  SendMessage $AbuProcessCancel ${BM_SETSTYLE} ${BS_DEFPUSHBUTTON} 1
  System::Call 'user32::GetDlgCtrlID(p $AbuProcessCancel) i.r1'
  SendMessage $AbuDialog 0x401 $1 0
  System::Call 'user32::PostMessageW(p $AbuDialog, i 0x28, p $AbuProcessCancel, p 1)'
  nsDialogs::Show
  ${If} $AbuExitRequested == "1"
    Quit
  ${EndIf}
FunctionEnd

Function AbuProcessPageLeave
  ${If} $AbuExitRequested != "1"
  ${AndIf} $AbuProcessResult != 0
    Abort
  ${EndIf}
FunctionEnd

Function AbuCloseForInstall
  Pop $0
  ${If} $AbuProcessCheckOnly == "1"
    !insertmacro AbuRunProcessCheck Check
    ${If} $AbuProcessResult == 4
      StrCpy $AbuProcessCheckOnly ""
      ${NSD_SetText} $AbuProcessTitle "$(AbuCloseForUpdate)"
      ${NSD_SetText} $AbuProcessCopy "$(AbuCloseForUpdateCopy)"
      ${NSD_SetText} $AbuProcessConfirm "$(AbuCloseAndUpdate)"
      System::Call 'user32::SendMessageW(p $AbuDialog, i 0x28, p $AbuProcessCancel, p 1)'
      Return
    ${EndIf}
  ${Else}
    StrCpy $AbuPageState "progress"
    EnableWindow $AbuProcessConfirm 0
    EnableWindow $AbuProcessCancel 0
    EnableWindow $AbuCloseButton 0
    ${NSD_SetText} $AbuProcessTitle "$(AbuClosingApp)"
    ${NSD_SetText} $AbuProcessCopy ""
    System::Call 'user32::UpdateWindow(p $HWNDPARENT)'
    !insertmacro AbuRunProcessCheck Stop
    StrCpy $AbuPageState "processes"
    EnableWindow $AbuProcessConfirm 1
    EnableWindow $AbuProcessCancel 1
    EnableWindow $AbuCloseButton 1
    ${If} $AbuProcessResult != 0
      ${NSD_SetText} $AbuProcessTitle "$(AbuCloseFailed)"
      ${NSD_SetText} $AbuProcessCopy "$(AbuCloseFailedCopy)"
      ${NSD_SetText} $AbuProcessConfirm "$(AbuRetryClose)"
    ${EndIf}
  ${EndIf}
  ${If} $AbuProcessResult == 0
    SendMessage $HWNDPARENT 0x408 1 0
  ${EndIf}
FunctionEnd
