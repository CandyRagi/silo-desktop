# Packaging and Installer script for Silo
$ErrorActionPreference = "Stop"

$appDir = "C:/Users/tiwar/silo-desktop"
$distDir = "$appDir/dist"
$buildDir = "$distDir/Silo"
$zipCachePath = "C:/Users/tiwar/AppData/Local/electron/Cache/ea3ffe2d5fb91313915c820d8aa37a2601d53095b9f8a841d9937bb2eff8264f/electron-v41.7.2-win32-x64.zip"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "       SILO DESKTOP WINDOWS PACKAGER         " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# 1. Clean old dist
if (Test-Path $distDir) {
    Write-Host "[-] Cleaning old build files..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $distDir
}
New-Item -ItemType Directory -Path $buildDir | Out-Null

# 2. Extract cached Electron binary
Write-Host "[+] Extracting Electron binaries..." -ForegroundColor Green
Expand-Archive -Path $zipCachePath -DestinationPath $buildDir -Force

# 3. Rename executable
Write-Host "[+] Renaming executable to Silo.exe..." -ForegroundColor Green
Rename-Item -Path "$buildDir/electron.exe" -NewName "Silo.exe"

# 4. Copy app files
$resourcesAppDir = "$buildDir/resources/app"
New-Item -ItemType Directory -Path $resourcesAppDir | Out-Null

Write-Host "[+] Copying application source files..." -ForegroundColor Green
Copy-Item "$appDir/index.html" $resourcesAppDir
Copy-Item "$appDir/main.js" $resourcesAppDir
Copy-Item "$appDir/preload.js" $resourcesAppDir
Copy-Item "$appDir/renderer.js" $resourcesAppDir
Copy-Item "$appDir/styles.css" $resourcesAppDir
Copy-Item "$appDir/icon.png" $resourcesAppDir
Copy-Item "$appDir/icon.ico" $buildDir
Copy-Item "$appDir/package.json" $resourcesAppDir
Copy-Item -Recurse "$appDir/src" $resourcesAppDir

# 5. Install production dependencies
Write-Host "[+] Installing production Node dependencies..." -ForegroundColor Green
Set-Location $resourcesAppDir
& npm.cmd install --production --no-audit --no-fund

# 6. Generate install.ps1 script
Write-Host "[+] Generating installer setup script..." -ForegroundColor Green
$installerScript = @"
# Silo Windows Application Installer
`$ErrorActionPreference = "Stop"

`$appName = "Silo"
`$installFolder = "`$env:LocalAppData\Silo"
`$srcFolder = "`$PSScriptRoot\Silo"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "             SILO APPLICATION SETUP           " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

if (-not (Test-Path `$srcFolder)) {
    Write-Host "[!] Error: Silo folder not found in the same directory as this installer." -ForegroundColor Red
    Exit 1
}

Write-Host "[+] Installing Silo to LocalAppData..." -ForegroundColor Green
if (Test-Path `$installFolder) {
    Write-Host "[-] Removing older installation..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force `$installFolder
}
New-Item -ItemType Directory -Path `$installFolder | Out-Null

Write-Host "[+] Copying application resources..." -ForegroundColor Green
Copy-Item -Path "`$srcFolder\*" -Destination `$installFolder -Recurse -Force

Write-Host "[+] Creating Desktop and Start Menu Shortcuts..." -ForegroundColor Green
`$WshShell = New-Object -ComObject WScript.Shell

# Desktop Shortcut
`$ShortcutPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), "`$appName.lnk")
`$Shortcut = `$WshShell.CreateShortcut(`$ShortcutPath)
`$Shortcut.TargetPath = "`$installFolder\Silo.exe"
`$Shortcut.WorkingDirectory = `$installFolder
`$Shortcut.IconLocation = "`$installFolder\icon.ico"
`$Shortcut.Save()

# Start Menu Shortcut
`$StartMenuPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('StartMenu'), "Programs", "`$appName.lnk")
`$Shortcut = `$WshShell.CreateShortcut(`$StartMenuPath)
`$Shortcut.TargetPath = "`$installFolder\Silo.exe"
`$Shortcut.WorkingDirectory = `$installFolder
`$Shortcut.IconLocation = "`$installFolder\icon.ico"
`$Shortcut.Save()

Write-Host "[+] Installation completed successfully!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "You can now open 'Silo' from your Desktop or Start Menu." -ForegroundColor Yellow
"@

Set-Location $distDir

$installerScript | Out-File -FilePath "install.ps1" -Encoding utf8
Copy-Item "$appDir/uninstall.ps1" .

Write-Host "[+] Generating CMD wrappers to bypass Execution Policy..." -ForegroundColor Green
$cmdInstall = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -ExecutionPolicy Bypass -File .\install.ps1`r`npause"
$cmdInstall | Out-File -FilePath "install.cmd" -Encoding ascii

$cmdUninstall = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -ExecutionPolicy Bypass -File .\uninstall.ps1`r`npause"
$cmdUninstall | Out-File -FilePath "uninstall.cmd" -Encoding ascii

# 7. Zip the package
Write-Host "[+] Packaging setup into ZIP archive..." -ForegroundColor Green
Compress-Archive -Path "Silo", "install.ps1", "uninstall.ps1", "install.cmd", "uninstall.cmd" -DestinationPath "Silo-Windows-Setup.zip" -Force

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   PACKAGING COMPLETE SUCCESSFULLY!          " -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "Packaged Standalone: $buildDir" -ForegroundColor Yellow
Write-Host "Installer ZIP: $distDir/Silo-Windows-Setup.zip" -ForegroundColor Yellow
Write-Host "To install, extract the ZIP and double-click 'install.cmd'." -ForegroundColor Yellow
