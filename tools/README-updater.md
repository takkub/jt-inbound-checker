# Native Messaging Host — J&T Inbound Checker Auto-Updater

## tools/ คืออะไร

โฟลเดอร์นี้มี **Native Messaging Host** ที่ให้ปุ่มอัปเดตใน popup สั่งโหลด zip เวอร์ชันใหม่จาก GitHub Releases แล้วทับไฟล์ extension โดยอัตโนมัติ โดยไม่ต้องถอนติดตั้ง/ติดตั้งใหม่ด้วยมือ

| ไฟล์ | หน้าที่ |
|------|---------|
| `updater.ps1` | Host หลัก (PowerShell) — รับคำสั่งจาก extension ผ่าน stdio แล้วดาวน์โหลด+แตก+ทับไฟล์ |
| `updater-host.bat` | Launcher ที่ Chrome เรียก (ชี้ไปหา updater.ps1) |
| `com.takkub.jtupdater.json` | Host manifest (สร้างอัตโนมัติตอน install) |
| `install-updater.bat` | ติดตั้ง host ลง registry (รันครั้งเดียวต่อเครื่อง) |
| `uninstall-updater.bat` | ถอน host ออกจาก registry |

---

## การติดตั้ง (ครั้งเดียวต่อเครื่อง)

1. ดับเบิลคลิก **`install-updater.bat`**
2. รอจนขึ้น "ติดตั้งสำเร็จ!"
3. **Reload extension** ใน `chrome://extensions/` หรือรีสตาร์ท Chrome 1 ครั้ง

> ทำแค่ครั้งเดียว หลังจากนั้นปุ่มอัปเดตใน popup จะทำงานได้ทันที

---

## ข้อจำกัด

- **Windows + Google Chrome เท่านั้น** (Native Messaging บน macOS/Linux ใช้ path และ registry ต่างกัน)
- Extension ต้องโหลดแบบ **Unpacked** และมี Extension ID = `oiglldeidblbehpagcjkjjojjpocgonb`
  (ID เปลี่ยนถ้าโหลดจากโฟลเดอร์อื่นหรือบัญชี Chrome อื่น → ต้องแก้ `allowed_origins` แล้ว install ใหม่)
- **ย้ายโฟลเดอร์ extension** ต้องรัน `install-updater.bat` ใหม่ทุกครั้ง เพราะ path ใน registry จะผิด

---

## การถอนการติดตั้ง

ดับเบิลคลิก **`uninstall-updater.bat`** — จะลบ registry key ออก host จะหยุดทำงานทันที

---

## กระบวนการทำงานเมื่อกดปุ่มอัปเดต

```
popup กดปุ่ม "อัปเดต"
  → ส่ง message ผ่าน chrome.runtime.sendNativeMessage("com.takkub.jtupdater", {action:"update"})
  → Chrome เรียก updater-host.bat → powershell updater.ps1
  → ดาวน์โหลด zip จาก GitHub Releases
  → แตก zip ลง temp folder
  → robocopy ทับไฟล์ใน extension/ (ยกเว้น .git/ และ tools/)
  → ส่ง response กลับ {ok:true, version:"x.x.x"}
  → popup แสดง "อัปเดตสำเร็จ" และ reload extension
```
