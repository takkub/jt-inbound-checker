$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

# Native Messaging host — stdio only, ห้าม Write-Host/Write-Output ลง stdout
$stdin  = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

$logDir = Join-Path $env:LOCALAPPDATA 'jt-inbound-checker'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Log($m) {
    Add-Content -Path (Join-Path $logDir 'updater.log') -Value "[$(Get-Date -Format o)] $m"
}

function Read-NativeMessage {
    $lenBuf = New-Object byte[] 4
    $total = 0
    while ($total -lt 4) {
        $n = $stdin.Read($lenBuf, $total, 4 - $total)
        if ($n -eq 0) { return $null }
        $total += $n
    }
    $len = [BitConverter]::ToUInt32($lenBuf, 0)
    Log "length read: 4 bytes, msg len=$len"
    $body = New-Object byte[] $len
    $totalBody = 0
    while ($totalBody -lt $len) {
        $n = $stdin.Read($body, $totalBody, $len - $totalBody)
        if ($n -eq 0) { break }
        $totalBody += $n
    }
    return [System.Text.Encoding]::UTF8.GetString($body, 0, $totalBody) | ConvertFrom-Json
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

Log "=== host start, args=$($args -join ' ')"

try {
    $msg = Read-NativeMessage
    if ($null -eq $msg) {
        Log "no message received — stdin closed"
        Write-NativeMessage @{ ok = $false; error = 'no message received' }
        exit 1
    }

    Log "action=$($msg.action) url=$($msg.url) version=$($msg.version)"

    if ($msg.action -ne 'update') {
        Log "unknown action: $($msg.action)"
        Write-NativeMessage @{ ok = $false; error = "unknown action: $($msg.action)" }
        exit 1
    }

    $zipUrl = if ($msg.url) { $msg.url } else { 'https://github.com/takkub/jt-inbound-checker/releases/latest/download/jt-inbound-checker.zip' }

    # ตำแหน่ง extension root = parent ของ tools/
    $extensionRoot = Split-Path $PSScriptRoot -Parent

    $tempDir = Join-Path $env:TEMP "jt-updater-$(Get-Random)"
    $zipPath = "$tempDir\update.zip"
    $extractDir = "$tempDir\extracted"

    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

    # ดาวน์โหลด zip
    Log "downloading $zipUrl"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    Log "download done: $zipPath"

    # แตก zip
    Log "extracting to $extractDir"
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    Log "extract done"

    # ถ้า zip มี subdirectory เดียว ให้ใช้ subdir นั้นเป็น source
    $children = Get-ChildItem -Path $extractDir
    $copySource = if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
        $children[0].FullName
    } else {
        $extractDir
    }

    # robocopy: ทับเฉพาะไฟล์ extension ไม่แตะ .git และ tools/ (กัน lock ตัวเอง)
    # /R:1 /W:1 กัน retry loop ล้านครั้งถ้า Chrome ล็อกไฟล์อยู่
    # exit code 0-7 = success
    Log "robocopy source=$copySource dest=$extensionRoot"
    robocopy $copySource $extensionRoot /E /XD ".git" "tools" /R:1 /W:1 /NJH /NJS /NFL /NDL /LOG:"$logDir\robocopy.log" | Out-Null
    $robocopyExit = $LASTEXITCODE
    Log "robocopy exit=$robocopyExit"
    if ($robocopyExit -gt 7) {
        throw "robocopy failed with exit code $robocopyExit"
    }

    # อ่าน version จาก manifest ใหม่ที่เพิ่งทับ
    $manifestPath = Join-Path $extensionRoot 'manifest.json'
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $newVersion = $manifest.version

    # ทำความสะอาด temp
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue

    Log "responding ok ver=$newVersion"
    Write-NativeMessage @{ ok = $true; version = $newVersion }
    exit 0
}
catch {
    Log "ERROR: $($_.Exception | Out-String)"
    Log "STACK: $($_.ScriptStackTrace)"
    Write-NativeMessage @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
