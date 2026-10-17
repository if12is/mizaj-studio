; Mizaj Studio - optional, OFF-by-default Microsoft Defender folder exclusion.
; Included by electron-builder via `nsis.include: build/installer.nsh`.
; See desktop/WINDOWS_DEFENDER.md for the rationale and risks.
;
; Behaviour:
;  * A custom page (after the install-directory page) shows an UNCHECKED checkbox.
;  * Only if checked: elevated PowerShell runs Add-MpPreference -ExclusionPath "<install dir>"
;    (that folder only - never processes, extensions or drives) and a flag is stored in
;    HKCU\Software\${APP_ID}\DefenderExclusion (electron-builder deletes the uninstall key itself
;    before customUnInstall runs, so the flag cannot live there).
;  * Silent installs (/S) and updates (--updated) never show the page, never add and never remove:
;    existing state is kept.
;  * The uninstaller removes the exclusion (elevated) only if the flag says we added it, and not
;    during an update.

!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"
  Var MizajDefCheck
  Var MizajDefChoice
!endif

!define MIZAJ_DEF_KEY "Software\${APP_ID}"

!macro customPageAfterChangeDir
  !ifndef BUILD_UNINSTALLER
    Page custom MizajDefenderPage MizajDefenderPageLeave

    Function MizajDefenderPage
      StrCpy $MizajDefChoice 0
      IfSilent mizajSkip
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${If} $LANGUAGE == 1025
        ${NSD_CreateLabel} 0 0 100% 48u "اختياري: يمكنك استثناء مجلد التثبيت فقط من فحص Windows Defender لتفادي الإنذارات الكاذبة. هذا يخفّض الحماية لذلك المجلد ويتطلب صلاحية المسؤول. اتركه بلا تحديد إن لم تكن متأكدًا."
        Pop $0
        ${NSD_CreateCheckbox} 0 56u 100% 24u "استثناء مجلد مِزَاج من فحص Windows Defender (يتطلب صلاحية المسؤول)"
        Pop $MizajDefCheck
      ${Else}
        ${NSD_CreateLabel} 0 0 100% 48u "Optional: exclude only the install folder from Windows Defender scanning to avoid false positives. This lowers protection for that folder and needs administrator rights. Leave unchecked if unsure."
        Pop $0
        ${NSD_CreateCheckbox} 0 56u 100% 24u "Exclude the Mizaj folder from Windows Defender scanning (requires administrator)"
        Pop $MizajDefCheck
      ${EndIf}
      ${NSD_SetState} $MizajDefCheck ${BST_UNCHECKED}
      nsDialogs::Show
      mizajSkip:
    FunctionEnd

    Function MizajDefenderPageLeave
      ${NSD_GetState} $MizajDefCheck $MizajDefChoice
    FunctionEnd
  !endif
!macroend

!macro customInstall
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    ${If} $MizajDefChoice == ${BST_CHECKED}
      ClearErrors
      ExecShellWait "runas" "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command $\"Add-MpPreference -ExclusionPath '$INSTDIR'$\"" SW_HIDE
      ${IfNot} ${Errors}
        WriteRegDWORD SHELL_CONTEXT "${MIZAJ_DEF_KEY}" "DefenderExclusion" 1
        WriteRegStr SHELL_CONTEXT "${MIZAJ_DEF_KEY}" "DefenderExclusionPath" "$INSTDIR"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ClearErrors
    ReadRegDWORD $0 SHELL_CONTEXT "${MIZAJ_DEF_KEY}" "DefenderExclusion"
    ${IfNot} ${Errors}
    ${AndIf} $0 == 1
      ReadRegStr $1 SHELL_CONTEXT "${MIZAJ_DEF_KEY}" "DefenderExclusionPath"
      ${If} $1 == ""
        StrCpy $1 "$INSTDIR"
      ${EndIf}
      ExecShellWait "runas" "powershell.exe" "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command $\"Remove-MpPreference -ExclusionPath '$1'$\"" SW_HIDE
    ${EndIf}
    DeleteRegKey SHELL_CONTEXT "${MIZAJ_DEF_KEY}"
  ${EndIf}
!macroend
