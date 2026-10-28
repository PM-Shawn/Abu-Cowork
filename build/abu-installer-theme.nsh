; Native counterparts of the light appearance in src/styles/tokens.css.
Var AbuDpi
Var AbuPrimaryButton
Var AbuDrawWindow
Var AbuDrawCode
Var AbuDrawData
Var AbuCloseButton
Var AbuResultFont

!macro AbuPlace HWND X Y WIDTH HEIGHT
  System::Call 'kernel32::MulDiv(i ${X}, i $AbuDpi, i 96) i.r6'
  System::Call 'kernel32::MulDiv(i ${Y}, i $AbuDpi, i 96) i.r7'
  System::Call 'kernel32::MulDiv(i ${WIDTH}, i $AbuDpi, i 96) i.r8'
  System::Call 'kernel32::MulDiv(i ${HEIGHT}, i $AbuDpi, i 96) i.r9'
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i r6, i r7, i r8, i r9, i 0x14)'
!macroend

!macro AbuLabel X Y WIDTH HEIGHT TEXT FONT COLOR
  ${NSD_CreateLabel} 0 0 1 1 '${TEXT}'
  Pop $0
  ${NSD_AddStyle} $0 ${SS_NOPREFIX}
  !insertmacro AbuPlace $0 ${X} ${Y} ${WIDTH} ${HEIGHT}
  SendMessage $0 ${WM_SETFONT} ${FONT} 1
  SetCtlColors $0 ${COLOR} FFFFFF
!macroend

!macro AbuButton X Y WIDTH TEXT CALLBACK
  ${NSD_CreateButton} 0 0 1 1 '${TEXT}'
  Pop $0
  !insertmacro AbuPlace $0 ${X} ${Y} ${WIDTH} 40
  SendMessage $0 ${WM_SETFONT} $AbuBodyFont 1
  ${NSD_OnClick} $0 ${CALLBACK}
  ${NSD_OnNotify} $0 AbuDrawButton
!macroend

Function AbuCreateFonts
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
  StrCpy $AbuDpi $0
  ${If} $AbuBodyFont != ""
    Return
  ${EndIf}
  System::Call 'kernel32::MulDiv(i -22, i $AbuDpi, i 96) i.r0'
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.r0'
  StrCpy $AbuTitleFont $0
  System::Call 'kernel32::MulDiv(i -15, i $AbuDpi, i 96) i.r0'
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 500, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.r0'
  StrCpy $AbuResultFont $0
  System::Call 'kernel32::MulDiv(i -13, i $AbuDpi, i 96) i.r0'
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.r0'
  StrCpy $AbuBodyFont $0
  System::Call 'kernel32::MulDiv(i -11, i $AbuDpi, i 96) i.r0'
  System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i 400, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Microsoft YaHei UI") p.r0'
  StrCpy $AbuCaptionFont $0
FunctionEnd

Function AbuSizePage
  Call AbuCreateFonts
  StrCpy $AbuPrimaryButton ""
  SetCtlColors $HWNDPARENT 1D1D1F FFFFFF
  SetCtlColors $AbuDialog 1D1D1F FFFFFF
  System::Call 'user32::GetWindow(p $HWNDPARENT, i 5) p.r0'
  ${DoWhile} $0 != 0
    ${If} $0 != $AbuDialog
      ShowWindow $0 0
    ${EndIf}
    System::Call 'user32::GetWindow(p r0, i 2) p.r0'
  ${Loop}
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r0'
  IntOp $0 $0 & 0xFF30FFFF
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)'
  System::Call 'kernel32::MulDiv(i 480, i $AbuDpi, i 96) i.r3'
  System::Call 'kernel32::MulDiv(i 400, i $AbuDpi, i 96) i.r4'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r3, i r4, i 0x36)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'
  !insertmacro AbuPlace $AbuDialog 0 0 480 400
FunctionEnd

Function AbuCompactResult
  System::Call 'kernel32::MulDiv(i 480, i $AbuDpi, i 96) i.r3'
  System::Call 'kernel32::MulDiv(i 264, i $AbuDpi, i 96) i.r4'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r3, i r4, i 0x16)'
  !insertmacro AbuPlace $AbuDialog 0 0 480 264
FunctionEnd

Function AbuPageChrome
  !insertmacro AbuLabel 0 0 436 40 "" $AbuBodyFont 1D1D1F
  ${NSD_AddStyle} $0 ${SS_NOTIFY}
  ${NSD_OnClick} $0 AbuDragWindow
  !insertmacro AbuButton 440 6 28 "$(AbuCloseInstaller)" AbuWindowClose
  StrCpy $AbuCloseButton $0
  !insertmacro AbuPlace $0 440 6 28 28
  nsDialogs::SetUserData $0 "close"
FunctionEnd

Function AbuDragWindow
  Pop $0
  System::Call 'user32::ReleaseCapture()'
  SendMessage $HWNDPARENT 0xA1 2 0
FunctionEnd

Function AbuWindowClose
  Pop $0
  ${If} $AbuPageState == "progress"
    Return
  ${EndIf}
  ${If} $AbuFailed == "1"
    SetErrorLevel 2
  ${ElseIf} $AbuPageState == "welcome"
    SetErrorLevel 1
  ${Else}
    SetErrorLevel 0
  ${EndIf}
  StrCpy $AbuExitRequested "1"
  SendMessage $HWNDPARENT 0x408 1 0
FunctionEnd

Function AbuDefaultButton
  StrCpy $AbuPrimaryButton $0
  SendMessage $0 ${BM_SETSTYLE} ${BS_DEFPUSHBUTTON} 1
  System::Call 'user32::GetDlgCtrlID(p r0) i.r1'
  SendMessage $AbuDialog 0x401 $1 0
FunctionEnd

Function AbuDrawButton
  Pop $AbuDrawWindow
  Pop $AbuDrawCode
  Pop $AbuDrawData
  ${If} $AbuDrawCode != -12
    Return
  ${EndIf}
  System::Store S
  System::Call '*$AbuDrawData(p, p, i, i.r0, p.r1, i.r2, i.r3, i.r4, i.r5, p, i.r6, p)'
  ; Button themes can request their complete drawing in either stage.
  ${If} $0 == 1
  ${OrIf} $0 == 3
    System::Call 'gdi32::SaveDC(p r1) i.r9'
    System::Call '*(i r2, i r3, i r4, i r5) p.r7'
    System::Call 'gdi32::GetStockObject(i 0) p.r0'
    System::Call 'user32::FillRect(p r1, p r7, p r0)'
    StrCpy $R0 0xF0EFEF
    StrCpy $R1 0x1F1D1D
    StrCpy $R2 0xF0EFEF
    nsDialogs::GetUserData $AbuDrawWindow
    Pop $R5
    ${If} $R5 == "quiet"
    ${OrIf} $R5 == "close"
      StrCpy $R0 0xFFFFFF
      StrCpy $R1 0x615C5C
      StrCpy $R2 0xFFFFFF
    ${EndIf}
    ${If} $AbuDrawWindow == $AbuPrimaryButton
      StrCpy $R0 0x1F1D1D
      StrCpy $R1 0xFFFFFF
      StrCpy $R2 $R0
    ${EndIf}
    IntOp $0 $6 & 0x41
    ${If} $0 != 0
      ${If} $AbuDrawWindow == $AbuPrimaryButton
        StrCpy $R0 0x363434
      ${Else}
        StrCpy $R0 0xE4E3E3
      ${EndIf}
      StrCpy $R2 $R0
    ${EndIf}
    IntOp $0 $6 & 4
    ${If} $0 != 0
      StrCpy $R0 0xF0EFEF
      StrCpy $R1 0x817C7C
      StrCpy $R2 $R0
    ${EndIf}
    IntOp $0 $6 & 0x10
    ${If} $0 != 0
      SendMessage $AbuDrawWindow 0x129 0 0 $0
      IntOp $0 $0 & 1
      ${If} $0 == 0
        StrCpy $R2 0xFF840A
      ${EndIf}
    ${EndIf}
    System::Call 'gdi32::CreateSolidBrush(i $R0) p.r0'
    System::Call 'gdi32::SelectObject(p r1, p r0) p.r8'
    System::Call 'kernel32::MulDiv(i 2, i $AbuDpi, i 96) i.r6'
    System::Call 'gdi32::CreatePen(i 0, i r6, i $R2) p.r6'
    System::Call 'gdi32::SelectObject(p r1, p r6) p.R3'
    System::Call 'kernel32::MulDiv(i 14, i $AbuDpi, i 96) i.R4'
    IntOp $2 $2 + 1
    IntOp $3 $3 + 1
    IntOp $4 $4 - 1
    IntOp $5 $5 - 1
    System::Call 'gdi32::RoundRect(p r1, i r2, i r3, i r4, i r5, i $R4, i $R4)'
    System::Call 'gdi32::SelectObject(p r1, p r8)'
    System::Call 'gdi32::SelectObject(p r1, p $R3)'
    System::Call 'gdi32::DeleteObject(p r0)'
    System::Call 'gdi32::DeleteObject(p r6)'
    System::Call 'gdi32::SelectObject(p r1, p $AbuBodyFont)'
    System::Call 'gdi32::SetBkMode(p r1, i 1)'
    System::Call 'gdi32::SetTextColor(p r1, i $R1)'
    System::Call 'user32::GetWindowTextW(p $AbuDrawWindow, w .r0, i ${NSIS_MAX_STRLEN})'
    ${If} $R5 == "close"
      StrCpy $0 "×"
    ${EndIf}
    System::Call 'user32::DrawTextW(p r1, w r0, i -1, p r7, i 0x825)'
    System::Call 'gdi32::RestoreDC(p r1, i r9)'
    System::Free $7
    System::Store L
    ${NSD_Return} 4
  ${Else}
    System::Store L
    ${NSD_Return} 0
  ${EndIf}
FunctionEnd
