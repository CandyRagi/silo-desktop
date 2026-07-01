# Silo Windows Application Uninstaller
$ErrorActionPreference = "Stop"

$appName = "Silo"
$installFolder = "$env:LocalAppData\Silo"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "             SILO APPLICATION UNINSTALL       " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# 1. Remove files
if (Test-Path $installFolder) {
    Write-Host "[-] Removing installation files from LocalAppData..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $installFolder
}

# 2. Remove Desktop shortcut
$desktopDir = [System.Environment]::GetFolderPath('Desktop')
$desktopShortcut = Join-Path $desktopDir "$appName.lnk"
if (Test-Path $desktopShortcut) {
    Write-Host "[-] Removing Desktop shortcut..." -ForegroundColor Yellow
    Remove-Item -Force $desktopShortcut
}

# 3. Remove Start Menu shortcut
$startMenuDir = [System.Environment]::GetFolderPath('StartMenu')
$startMenuShortcut = Join-Path $startMenuDir "Programs\$appName.lnk"
if (Test-Path $startMenuShortcut) {
    Write-Host "[-] Removing Start Menu shortcut..." -ForegroundColor Yellow
    Remove-Item -Force $startMenuShortcut
}

Write-Host "[+] Uninstallation completed successfully!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
