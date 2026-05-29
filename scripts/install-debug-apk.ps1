param(
    [string]$ApkPath = "",
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if ($ApkPath.Trim().Length -eq 0) {
    $ApkPath = Join-Path $repoRoot "AgentHub\app\build\outputs\apk\debug\app-debug.apk"
}
$ApkPath = [System.IO.Path]::GetFullPath($ApkPath)

if ($Rebuild) {
    Push-Location (Join-Path $repoRoot "AgentHub")
    try {
        & .\gradlew.bat :app:assembleDebug --console=plain
        if ($LASTEXITCODE -ne 0) { throw "Gradle build failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "APK not found: $ApkPath"
}

$adbCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"),
    (if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME "platform-tools\adb.exe" }),
    (if ($env:ANDROID_SDK_ROOT) { Join-Path $env:ANDROID_SDK_ROOT "platform-tools\adb.exe" }),
    "adb"
) | Where-Object { $_ }

$adb = $null
foreach ($candidate in $adbCandidates) {
    try {
        if ($candidate -eq "adb") {
            $cmd = Get-Command adb -ErrorAction Stop
            $adb = $cmd.Source
        } elseif (Test-Path -LiteralPath $candidate) {
            $adb = $candidate
        }
        if ($adb) { break }
    } catch {}
}

if (-not $adb) {
    throw "adb not found. Install Android platform-tools or set ANDROID_HOME/ANDROID_SDK_ROOT."
}

$devicesOutput = & $adb devices
$devices = $devicesOutput | Select-String -Pattern "device$" | ForEach-Object { ($_ -split "\s+")[0] }
if (-not $devices -or $devices.Count -eq 0) {
    Write-Host ($devicesOutput -join "`n")
    throw "No Android device is connected/authorized. Plug in the phone and accept the USB debugging prompt."
}

Write-Host "Installing $ApkPath"
Write-Host "Device(s): $($devices -join ', ')"
& $adb install -r $ApkPath
if ($LASTEXITCODE -ne 0) { throw "adb install failed with exit code $LASTEXITCODE" }
