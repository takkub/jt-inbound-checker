@echo off
setlocal

:: สร้าง host manifest json พร้อม path ที่ถูกต้อง
set "TOOLS_DIR=%~dp0"
set "BAT_PATH=%~dp0updater-host.bat"
set "JSON_PATH=%~dp0com.takkub.jtupdater.json"

:: ใช้ PowerShell gen json (ConvertTo-Json จัดการ escape \ ให้อัตโนมัติ)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$batPath = '%BAT_PATH%'; $jsonPath = '%JSON_PATH%'; ^
   $manifest = [ordered]@{ ^
     name = 'com.takkub.jtupdater'; ^
     description = 'J^&T Inbound Checker auto-updater'; ^
     path = $batPath; ^
     type = 'stdio'; ^
     allowed_origins = @('chrome-extension://oiglldeidblbehpagcjkjjojjpocgonb/') ^
   }; ^
   [System.IO.File]::WriteAllText($jsonPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false))); ^
   Write-Host ('JSON written: ' + $jsonPath)"

if errorlevel 1 (
    echo ERROR: สร้าง manifest json ล้มเหลว
    pause
    exit /b 1
)

:: ลงทะเบียน registry
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.takkub.jtupdater" /ve /t REG_SZ /d "%JSON_PATH%" /f
if errorlevel 1 (
    echo ERROR: เขียน registry ล้มเหลว
    pause
    exit /b 1
)

echo.
echo ติดตั้งสำเร็จ!
echo Registry: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.takkub.jtupdater
echo Host path: %JSON_PATH%
echo.
echo ** หลังติดตั้ง: กรุณา reload extension (หรือรีสตาร์ท Chrome) 1 ครั้ง **
echo ** หากย้าย folder ให้รัน install-updater.bat ใหม่อีกครั้ง **
echo.
pause
