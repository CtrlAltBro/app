; CtrlAltBro per-machine installer (milestone 5).
; Elevates once at install; afterwards the SYSTEM service starts at boot and the
; session app is launched into the child's session by a scheduled task - no admin
; password and no UAC prompt for the child at any startup (see CLAUDE.md pitfall 7).
; Run over an existing install it is an upgrade: the current server, accounts and
; pairing are shown greyed out and kept unless the admin chooses to change them.
;
; Built by scripts\build-installer.ps1, which stages the files and passes VERSION,
; STAGING and DEFAULT_API_URL. Do not run makensis on this file directly.

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "TextFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGING
  !define STAGING "staging"
!endif
!ifndef DEFAULT_API_URL
  !define DEFAULT_API_URL "http://localhost:5173"
!endif
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CtrlAltBro"

Name "CtrlAltBro ${VERSION}"
OutFile "ctrlaltbro-setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\CtrlAltBro"
; Per-machine install + service + HKLM: the whole installer needs admin.
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

Var PsExe        ; 64-bit PowerShell (see SetPowerShell)
Var Upgrade      ; 1 when CtrlAltBro is already installed
Var PairedName   ; device name when this PC is already paired, else empty
Var ApiUrl       ; server shown on the page
Var ApiUrlOut    ; server passed to postinstall (empty = keep the current one)
Var Monitored    ; accounts passed to postinstall (empty = keep the current ones)
Var AccHwnds     ; account checkboxes, space-separated handles
Var PairCode
Var PcName
Var RePair       ; 1 = pair again over an existing pairing (--force)
Var ServerChanged
Var HwndApiUrl
Var HwndChangeServer
Var HwndChangeAccounts
Var HwndRePair
Var HwndCodeLabel
Var HwndPairCode
Var HwndNameLabel
Var HwndPcName

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
Page custom ServerPageCreate ServerPageLeave
Page custom AccountsPageCreate AccountsPageLeave
Page custom PairingPageCreate PairingPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

; NSIS is a 32-bit program: a plain "powershell" would be the 32-bit one, which has
; no Get-LocalUser and sees the 32-bit registry view. sysnative reaches the 64-bit one.
!macro SetPowerShell
  ${If} ${FileExists} "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $PsExe "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $PsExe "powershell.exe"
  ${EndIf}
!macroend

Function .onInit
  !insertmacro SetPowerShell
  ReadEnvStr $PcName "COMPUTERNAME"
  StrCpy $ApiUrl "${DEFAULT_API_URL}"
  StrCpy $Upgrade 0
  ${If} ${FileExists} "$INSTDIR\ctrlaltbro-svc.exe"
    StrCpy $Upgrade 1
  ${EndIf}
  ; List the accounts and read the existing config / pairing once, before the pages.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\list-accounts.ps1" "list-accounts.ps1"
  nsExec::Exec '"$PsExe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\list-accounts.ps1" -Out "$PLUGINSDIR\accounts.txt"'
  Pop $0
  ClearErrors
  FileOpen $1 "$PLUGINSDIR\accounts.txt" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $1 $2
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${TrimNewLines} $2 $2
      StrCpy $3 $2 4
      ${If} $3 == "URL|"
        StrCpy $ApiUrl $2 "" 4
      ${EndIf}
      StrCpy $3 $2 7
      ${If} $3 == "PAIRED|"
        StrCpy $PairedName $2 "" 7
      ${EndIf}
    ${Loop}
    FileClose $1
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetPowerShell
FunctionEnd

; --- Server: the dashboard / API this PC reports to (self-hosting friendly) ---
Function ServerPageCreate
  !insertmacro MUI_HEADER_TEXT "Serveur" "Adresse du serveur CtrlAltBro auquel ce PC se connecte."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${If} $Upgrade == 1
    ${NSD_CreateLabel} 0 0 100% 24u "CtrlAltBro est deja installe. Le serveur actuel est conserve, sauf si tu choisis de le changer."
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 24u "Adresse du serveur (celle du dashboard). Garde la valeur proposee si tu utilises le service officiel ; change-la si tu heberges ton propre serveur."
  ${EndIf}
  ${NSD_CreateLabel} 0 30u 100% 12u "Adresse du serveur :"
  ${NSD_CreateText} 0 42u 100% 12u "$ApiUrl"
  Pop $HwndApiUrl
  ${If} $Upgrade == 1
    ${NSD_CreateCheckbox} 0 62u 100% 24u "Changer le serveur (efface l'appairage actuel : il faudra re-appairer ce PC avec un code du nouveau dashboard)"
    Pop $HwndChangeServer
    ${NSD_OnClick} $HwndChangeServer OnChangeServer
    EnableWindow $HwndApiUrl 0
  ${Else}
    ${NSD_CreateLabel} 0 62u 100% 24u "Modifiable plus tard dans l'app CtrlAltBro (Parametres), avec le mot de passe administrateur."
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function OnChangeServer
  Pop $0
  ${NSD_GetState} $HwndChangeServer $1
  ${If} $1 == ${BST_CHECKED}
    EnableWindow $HwndApiUrl 1
  ${Else}
    EnableWindow $HwndApiUrl 0
  ${EndIf}
FunctionEnd

Function ServerPageLeave
  StrCpy $ServerChanged 0
  StrCpy $ApiUrlOut ""
  ${If} $Upgrade == 1
    ${NSD_GetState} $HwndChangeServer $1
    ${If} $1 != ${BST_CHECKED}
      Return
    ${EndIf}
  ${EndIf}
  ${NSD_GetText} $HwndApiUrl $ApiUrl
  StrCpy $0 $ApiUrl 7
  StrCpy $1 $ApiUrl 8
  ${If} $0 != "http://"
  ${AndIf} $1 != "https://"
    MessageBox MB_ICONEXCLAMATION "L'adresse doit commencer par http:// ou https://"
    Abort
  ${EndIf}
  StrCpy $ApiUrlOut $ApiUrl
  ${If} $Upgrade == 1
    StrCpy $ServerChanged 1
  ${EndIf}
FunctionEnd

; --- Monitored accounts: the children; administrators (parents) unchecked by default ---
Function AccountsPageCreate
  !insertmacro MUI_HEADER_TEXT "Comptes surveilles" "Choisis les comptes Windows des enfants."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${If} $Upgrade == 1
    ${NSD_CreateCheckbox} 0 0 100% 12u "Modifier les comptes surveilles (sinon, les comptes actuels sont conserves)"
    Pop $HwndChangeAccounts
    ${NSD_OnClick} $HwndChangeAccounts OnChangeAccounts
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 20u "Coche les comptes a surveiller (les enfants). Les comptes administrateur, ceux des parents, ne sont pas coches par defaut."
  ${EndIf}

  StrCpy $AccHwnds ""
  StrCpy $5 24
  ClearErrors
  FileOpen $1 "$PLUGINSDIR\accounts.txt" r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileReadUTF16LE $1 $2
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      ${TrimNewLines} $2 $2
      StrCpy $3 $2 4
      StrCpy $4 $2 7
      ${If} $2 == ""
      ${OrIf} $3 == "URL|"
      ${OrIf} $4 == "PAIRED|"
        ${Continue}
      ${EndIf}
      ; SID|isAdmin|checked|name
      ${WordFind} $2 "|" "+1" $3
      ${WordFind} $2 "|" "+2" $4
      ${WordFind} $2 "|" "+3" $9
      ${WordFind} $2 "|" "+4" $6
      ${If} $4 == "1"
        StrCpy $6 "$6 (administrateur)"
      ${EndIf}
      ${NSD_CreateCheckbox} 10u $5u 95% 12u "$6"
      Pop $7
      nsDialogs::SetUserData $7 $3
      ${If} $9 == "1"
        ${NSD_Check} $7
      ${EndIf}
      ${If} $Upgrade == 1
        EnableWindow $7 0
      ${EndIf}
      StrCpy $AccHwnds "$AccHwnds$7 "
      IntOp $5 $5 + 14
    ${Loop}
    FileClose $1
  ${EndIf}

  ${If} $AccHwnds == ""
    ${NSD_CreateLabel} 0 24u 100% 24u "Impossible de lister les comptes. Les comptes non administrateurs seront surveilles ; tu pourras changer ca dans l'app (Parametres)."
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function OnChangeAccounts
  Pop $0
  ${NSD_GetState} $HwndChangeAccounts $1
  StrCpy $8 1
  ${Do}
    ClearErrors
    ${WordFind} $AccHwnds " " "E+$8" $7
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    ${If} $1 == ${BST_CHECKED}
      EnableWindow $7 1
    ${Else}
      EnableWindow $7 0
    ${EndIf}
    IntOp $8 $8 + 1
  ${Loop}
FunctionEnd

Function AccountsPageLeave
  StrCpy $Monitored ""
  ${If} $AccHwnds == ""
    Return
  ${EndIf}
  ${If} $Upgrade == 1
    ${NSD_GetState} $HwndChangeAccounts $1
    ${If} $1 != ${BST_CHECKED}
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $8 1
  ${Do}
    ClearErrors
    ${WordFind} $AccHwnds " " "E+$8" $7
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    ${NSD_GetState} $7 $9
    ${If} $9 == ${BST_CHECKED}
      nsDialogs::GetUserData $7
      Pop $3
      StrCpy $Monitored "$Monitored$3,"
    ${EndIf}
    IntOp $8 $8 + 1
  ${Loop}
  ${If} $Monitored == ""
    MessageBox MB_ICONEXCLAMATION "Coche au moins un compte a surveiller."
    Abort
  ${EndIf}
  StrCpy $Monitored $Monitored -1
FunctionEnd

; --- Pairing (optional). Already paired: kept, unless the admin re-pairs. ---
Function PairingPageCreate
  !insertmacro MUI_HEADER_TEXT "Appairage" "Relie ce PC au compte parent (facultatif ici)."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  StrCpy $HwndRePair ""
  ${If} $PairedName != ""
  ${AndIf} $ServerChanged != 1
    ${NSD_CreateLabel} 0 0 100% 12u "Ce PC est deja appaire : $PairedName. L'appairage est conserve."
    ${NSD_CreateCheckbox} 0 16u 100% 12u "Re-appairer avec un nouveau code"
    Pop $HwndRePair
    ${NSD_OnClick} $HwndRePair OnRePair
  ${ElseIf} $ServerChanged == 1
    ${NSD_CreateLabel} 0 0 100% 24u "Le serveur change : colle un code d'appairage genere depuis le nouveau dashboard (ou laisse vide et appaire plus tard depuis l'app)."
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 24u "Colle le code d'appairage genere depuis le dashboard (Ajouter un PC). Tu peux aussi laisser vide et appairer plus tard depuis l'app."
  ${EndIf}

  ${NSD_CreateLabel} 0 34u 100% 12u "Code d'appairage :"
  Pop $HwndCodeLabel
  ${NSD_CreateText} 0 46u 100% 12u ""
  Pop $HwndPairCode
  ${NSD_CreateLabel} 0 64u 100% 12u "Nom de ce PC (affiche sur le dashboard) :"
  Pop $HwndNameLabel
  ${NSD_CreateText} 0 76u 100% 12u "$PcName"
  Pop $HwndPcName

  ${If} $HwndRePair != ""
    Push $HwndRePair
    Call OnRePair
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function OnRePair
  Pop $0
  ${NSD_GetState} $HwndRePair $1
  ${If} $1 == ${BST_CHECKED}
    StrCpy $2 ${SW_SHOW}
  ${Else}
    StrCpy $2 ${SW_HIDE}
  ${EndIf}
  ShowWindow $HwndCodeLabel $2
  ShowWindow $HwndPairCode $2
  ShowWindow $HwndNameLabel $2
  ShowWindow $HwndPcName $2
FunctionEnd

Function PairingPageLeave
  StrCpy $RePair 0
  StrCpy $PairCode ""
  ${If} $HwndRePair != ""
    ${NSD_GetState} $HwndRePair $1
    ${If} $1 != ${BST_CHECKED}
      Return
    ${EndIf}
    StrCpy $RePair 1
  ${EndIf}
  ${NSD_GetText} $HwndPairCode $PairCode
  ${NSD_GetText} $HwndPcName $PcName
FunctionEnd

Section "Install"
  ; Upgrade over an existing install: stop the service first (so its supervisor
  ; cannot relaunch the session app), then close the app in every session, so the
  ; files in use can be replaced. A clean stop, so no "service restarted" alert.
  ${If} $Upgrade == 1
    DetailPrint "Mise a jour : arret du service CtrlAltBro..."
    nsExec::ExecToLog '"$INSTDIR\ctrlaltbro-svc.exe" stop'
    Pop $0
    nsExec::ExecToLog 'taskkill /IM ctrlaltbro.exe /F /T'
    Pop $0
    Sleep 2000
  ${EndIf}

  SetOutPath "$INSTDIR"
  ; Lays down app\ (the Electron session app), node.exe, service.js(.map),
  ; the WinSW wrapper (ctrlaltbro-svc.exe + .xml) and the install actions.
  File /r "${STAGING}\*"

  DetailPrint "Configuration du serveur, des comptes, du service et de l'appairage..."
  nsExec::ExecToLog '"$PsExe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\postinstall.ps1" -InstallDir "$INSTDIR" -ApiUrl "$ApiUrlOut" -Monitored "$Monitored" -PairCode "$PairCode" -PcName "$PcName" -RePair $RePair'
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
  nsExec::ExecToLog '"$PsExe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\preuninstall.ps1" -InstallDir "$INSTDIR"'
  Pop $0
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
