# J&T Inbound Checker

Extension สำหรับ Chrome ที่อ่าน QR/barcode จากไฟล์ PDF ใบปะหน้าพัสดุ แล้วกรอก waybill number เข้าช่อง Shipping Inbound บนเว็บ J&T Express (home.jtexpress.co.th) โดยอัตโนมัติ ลดงาน manual ที่ต้องพิมพ์เลขพัสดุทีละชิ้น

## วิธีติดตั้ง

1. เปิด Chrome แล้วไปที่ `chrome://extensions`
2. เปิดสวิตช์ **Developer mode** (มุมบนขวา)
3. คลิก **Load unpacked**
4. เลือกโฟลเดอร์นี้ (`extension/`)
5. Extension จะปรากฏใน toolbar พร้อมใช้งาน

## วิธี Update เมื่อมีเวอร์ชันใหม่

1. เมื่อมีเวอร์ชันใหม่ popup จะขึ้น **update banner** แจ้งเตือน
2. กดลิงก์ใน banner เพื่อไปหน้า Releases
3. ดาวน์โหลด zip ของเวอร์ชันล่าสุด แล้วแตกไฟล์ทับโฟลเดอร์เดิม
4. ไปที่ `chrome://extensions` แล้วกด **reload** (ไอคอนวนลูก) ที่ตัว extension
5. banner จะหายไปและ extension จะทำงานกับเวอร์ชันใหม่ทันที
