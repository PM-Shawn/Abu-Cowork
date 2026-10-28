; The upstream uninstall function remains defined after its update macro is replaced.
!pragma warning disable 6010

!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  StrCpy $R0 0
  ClearErrors
!macroend

!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro AbuEnvironment "ABU_INSTALLER_ARCHIVE" "${FILE}"
  ${IfNot} ${Silent}
    SendMessage $AbuProgressLabel ${WM_SETTEXT} 0 "STR:$(AbuPreparing)"
  ${EndIf}
  !insertmacro AbuRunTransaction Extract
  ${If} $AbuHelperResult != 0
    !insertmacro AbuFailInstallation
  ${EndIf}
  SetOutPath $INSTDIR
!macroend

!macroundef installApplicationFiles
!macro installApplicationFiles
  StrCpy $AbuFinalDirectory $INSTDIR
  !insertmacro AbuEnvironment "ABU_INSTALLER_DIRECTORY" "$AbuFinalDirectory"
  !insertmacro AbuEnvironment "ABU_INSTALLER_LINK_0" "$newStartMenuLink"
  !insertmacro AbuEnvironment "ABU_INSTALLER_LINK_1" "$newDesktopLink"
  !insertmacro AbuEnvironment "ABU_INSTALLER_LINK_2" "$oldStartMenuLink"
  !insertmacro AbuEnvironment "ABU_INSTALLER_LINK_3" "$oldDesktopLink"
  !insertmacro AbuEnvironment "ABU_INSTALLER_KEEP_SHORTCUTS" "$keepShortcuts"
  ${If} ${isNoDesktopShortcut}
    !insertmacro AbuEnvironment "ABU_INSTALLER_NO_DESKTOP" "true"
  ${Else}
    !insertmacro AbuEnvironment "ABU_INSTALLER_NO_DESKTOP" "false"
  ${EndIf}
  !insertmacro AbuRunTransaction Begin
  ${If} $AbuHelperResult != 0
    !insertmacro AbuFailInstallation
  ${EndIf}
  StrCpy $AbuTransactionStarted "1"
  StrCpy $INSTDIR "$AbuFinalDirectory.abu-update\new"
  SetOutPath $INSTDIR
  !insertmacro extractEmbeddedAppPackage
  File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
  ${If} ${Errors}
    !insertmacro AbuFailInstallation
  ${EndIf}
  ${IfNot} ${Silent}
    SendMessage $AbuProgressLabel ${WM_SETTEXT} 0 "STR:$(AbuApplying)"
  ${EndIf}
  !insertmacro AbuRunTransaction Promote
  StrCpy $INSTDIR $AbuFinalDirectory
  ${If} $AbuHelperResult != 0
    !insertmacro AbuFailInstallation
  ${EndIf}
  SetOutPath $INSTDIR
!macroend
