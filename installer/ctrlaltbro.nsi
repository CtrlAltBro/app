; CtrlAltBro per-machine installer (milestone 5).
; Elevates once at install; afterwards the SYSTEM service starts at boot and the
; session app is launched into the child's session by a scheduled task - no admin
; password and no UAC prompt for the child at any startup (see CLAUDE.md pitfall 7).
;
; Built by scripts\build-installer.ps1, which stages the files and passes VERSION
; and STAGING. Do not run makensis on this file directly.

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGING
  !define STAGING "staging"
!endif
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CtrlAltBro"

Name "CtrlAltBro ${VERSION}"
OutFile "ctrlaltbro-setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\CtrlAltBro"
; Per-machine install + service + HKLM: the whole installer needs admin.
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

Var PairCode
Var PcName
Var HwndPairCode
Var HwndPcName

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
Page custom PairingPageCreate PairingPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Function .onInit
  ReadEnvStr $PcName "COMPUTERNAME"
FunctionEnd

; --- Pairing details (optional: leave the code blank to pair later as admin) ---
Function PairingPageCreate
  !insertmacro MUI_HEADER_TEXT "Appairage" "Relie ce PC au compte parent (facultatif ici)."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Colle le code d'appairage genere depuis le dashboard (Ajouter un PC). Tu peux aussi laisser vide et appairer plus tard en admin."
  ${NSD_CreateLabel} 0 30u 100% 12u "Code d'appairage :"
  ${NSD_CreateText} 0 42u 100% 12u ""
  Pop $HwndPairCode
  ${NSD_CreateLabel} 0 60u 100% 12u "Nom de ce PC :"
  ${NSD_CreateText} 0 72u 100% 12u "$PcName"
  Pop $HwndPcName

  nsDialogs::Show
FunctionEnd

Function PairingPageLeave
  ${NSD_GetText} $HwndPairCode $PairCode
  ${NSD_GetText} $HwndPcName $PcName
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; Lays down app\ (the Electron session app), node.exe, service.js(.map),
  ; the WinSW wrapper (ctrlaltbro-svc.exe + .xml) and the install actions.
  File /r "${STAGING}\*"

  DetailPrint "Configuration du service et de l'appairage..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\postinstall.ps1" -InstallDir "$INSTDIR" -PairCode "$PairCode" -PcName "$PcName"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "postinstall a renvoye le code $0 (voir les details)."
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "CtrlAltBro"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "CtrlAltBro"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Stops and removes the service, its launch tasks and the state dir before the
  ; files go. Runs from the still-present $INSTDIR.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\preuninstall.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
