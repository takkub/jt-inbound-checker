@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.takkub.jtupdater" /f
if errorlevel 1 (
    echo ERROR: Failed to delete registry key (may not be installed yet)
) else (
    echo Uninstalled native messaging host successfully
)
pause