@echo off
if not exist "%LOCALAPPDATA%\jt-inbound-checker" mkdir "%LOCALAPPDATA%\jt-inbound-checker"
echo [%date% %time%] host.bat launched >> "%LOCALAPPDATA%\jt-inbound-checker\updater.log"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0updater.ps1"
