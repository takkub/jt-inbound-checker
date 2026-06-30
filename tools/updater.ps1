$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

# Native Messaging host — stdio only, ห้าม Write-Host/Write-Output ลง stdout
$stdin  = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-NativeMessage {
    $lenBuf = New-Object byte[] 4
    $read = $stdin.Read($lenBuf, 0, 4)
    if ($read -lt 4) { return $null }
    $len = [BitConverter]::ToUInt32($lenBuf, 0)
    $body = New-Object byte[] $len
    $total = 0
    while ($total -lt $len) {
        $n = $stdin.Read($body, $total, $len - $total)
        if ($n -eq 0) { break }
        $total += $n
    }
    return [System.Text.Encoding]::UTF8.GetString($body, 0, $total) | ConvertFrom-Json
}

function Write-NativeMessage {
    param([hashtable]$obj)
    $json  = $obj | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $len   = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $stdout.Write($len,   0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

$msg = Read-NativeMessage
if ($null -eq $msg) {
    Write-NativeMessage @{ ok = $false; error = 'no message received' }
    exit 1
}

if ($msg.action -ne 'update') {
    Write-NativeMessage @{ ok = $false; error = "unknown action: $($msg.action)" }
    exit 1
}

$zipUrl = if ($msg.url) { $msg.url } else { 'https://github.com/takkub/jt-inbound-checker/releases/latest/download/jt-inbound-checker.zip' }

try {
    # ตำแหน่ง extension root = parent ของ tools/
    $extensionRoot = Split-Path $PSScriptRoot -Parent

    $tempDir = Join-Path $env:TEMP "jt-updater-$(Get-Random)"
    $zipPath = "$tempDir\update.zip"
    $extractDir = "$tempDir\extracted"

    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    # ดาวน์โหลด zip
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

    # แตก zip
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    # ถ้า zip มี subdirectory เดียว ให้ใช้ subdir นั้นเป็น source
    $children = Get-ChildItem -Path $extractDir
    $copySource = if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
        $children[0].FullName
    } else {
        $extractDir
    }

    # robocopy: ทับเฉพาะไฟล์ extension ไม่แตะ .git และ tools/ (กัน lock ตัวเอง)
    # exit code 0-7 = success
    $rc = (robocopy $copySource $extensionRoot /E /XD ".git" "tools" /NJH /NJS /NFL /NDL) | Out-Null
    $robocopyExit = $LASTEXITCODE
    if ($robocopyExit -gt 7) {
        throw "robocopy failed with exit code $robocopyExit"
    }

    # อ่าน version จาก manifest ใหม่ที่เพิ่งทับ
    $manifestPath = Join-Path $extensionRoot 'manifest.json'
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $newVersion = $manifest.version

    # ทำความสะอาด temp
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue

    Write-NativeMessage @{ ok = $true; version = $newVersion }
    exit 0
}
catch {
    Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
