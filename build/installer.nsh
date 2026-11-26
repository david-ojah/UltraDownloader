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

; magnet: links and .torrent files open Ultra Downloader. Per-user HKCU entries
; keep the installer working without elevation, matching the per-user install
; mode. main.js picks the URI/path out of argv on startup and in second-instance.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\magnet" "" "URL:Magnet link"
  WriteRegStr HKCU "Software\Classes\magnet" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\magnet\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\magnet\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Classes\.torrent" "" "UltraDownloader.Torrent"
  WriteRegStr HKCU "Software\Classes\UltraDownloader.Torrent" "" "BitTorrent file"
  WriteRegStr HKCU "Software\Classes\UltraDownloader.Torrent\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\UltraDownloader.Torrent\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

; Electron names the login-item value after the AppUserModelID, which main.js
; sets to com.ultradownloader.app. Remove it so uninstalling leaves nothing
; behind for Windows to launch. The .torrent key is only removed when it still
; points at this app, so another client's association is left alone.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.ultradownloader.app"
  DeleteRegKey HKCU "Software\Classes\magnet"
  DeleteRegKey HKCU "Software\Classes\UltraDownloader.Torrent"
  ReadRegStr $0 HKCU "Software\Classes\.torrent" ""
  StrCmp $0 "UltraDownloader.Torrent" 0 +2
    DeleteRegKey HKCU "Software\Classes\.torrent"
!macroend
