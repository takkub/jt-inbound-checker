@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.takkub.jtupdater" /f
if errorlevel 1 (
    echo ERROR: ลบ registry ล้มเหลว (อาจยังไม่ได้ติดตั้ง)
) else (
    echo ถอนการติดตั้ง native messaging host สำเร็จ
)
pause
