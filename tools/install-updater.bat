@echo off
setlocal

:: Generate host manifest json with correct path
set "TOOLS_DIR=%~dp0"
set "BAT_PATH=%~dp0updater-host.bat"
set "JSON_PATH=%~dp0com.takkub.jtupdater.json"

:: Use PowerShell to generate json (no-BOM UTF-8, ConvertTo-Json handles escaping)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$batPath='%BAT_PATH%'; $jsonPath='%JSON_PATH%'; $m=[ordered]@{name='com.takkub.jtupdater';description='J&T Inbound Checker auto-updater';path=$batPath;type='stdio';allowed_origins=@('chrome-extension://oiglldeidblbehpagcjkjjojjpocgonb/')}; [System.IO.File]::WriteAllText($jsonPath,($m|ConvertTo-Json),(New-Object System.Text.UTF8Encoding($false))); Write-Host ('JSON written: '+$jsonPath)"

if errorlevel 1 (
    echo ERROR: Failed to create manifest json
    pause
    exit /b 1
)

:: Register native messaging host in registry
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.takkub.jtupdater" /ve /t REG_SZ /d "%JSON_PATH%" /f
if errorlevel 1 (
    echo ERROR: Failed to write registry key
    pause
    exit /b 1
)

echo.
echo Installed successfully!
echo Registry: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.takkub.jtupdater
echo Host path: %JSON_PATH%
echo.
echo ** Please reload the extension (or restart Chrome) once after install **
echo ** Run this again if you move the extension folder **
echo.
pause