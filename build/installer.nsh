; Close a running copy before installing over it or uninstalling it.
;
; 1.0.1R1 and newer understand --quit and stop their transfers cleanly, leaving
; the database status as "downloading" so the next launch resumes the part
; files. Older builds ignore the flag, so a taskkill fallback runs afterwards.
; The fallback is also the safety net if the app hangs while shutting down.
!macro customCheckAppRunning
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 doKill
  nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
  Pop $0
  Sleep 1500
  doKill:
  nsExec::Exec '"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%" >nul 2>&1'
  Pop $0
  Sleep 500
!macroend
