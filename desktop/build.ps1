param([string]$Python = "python", [string]$OutputRoot = "runtime\desktop-build")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$projectRoot = (Get-Location).Path
$OutputRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $OutputRoot))
$env:PYTHONUTF8 = "1"
if (!(Test-Path "grokctl\web\app.js")) { throw "Build frontend first: cd frontend; npm ci; npm run build" }
& $Python desktop/render_bridge.py --output "$OutputRoot\bridge\client-bridge.cjs"
if ($LASTEXITCODE -ne 0) { throw "Native bridge build failed" }
& $Python -m PyInstaller --noconfirm --clean --windowed --name GrokBotSwitch `
  --distpath "$OutputRoot\dist" --workpath "$OutputRoot\work" --specpath "$OutputRoot" `
  --paths "$projectRoot" --add-data "$projectRoot/grokctl/web;grokctl/web" --add-data "$projectRoot/ops;ops" --add-data "$projectRoot/src;src" `
  --add-data "$OutputRoot/bridge;bridge" `
  --add-data "$projectRoot/THIRD_PARTY_NOTICES.md;." --add-data "$projectRoot/frontend/licenses;frontend/licenses" --collect-all webview `
  --exclude-module PyQt5 --exclude-module PyQt6 --exclude-module PySide6 desktop/entry.py
if ($LASTEXITCODE -ne 0) { throw "Desktop build failed" }
$dist = Join-Path $OutputRoot "dist\GrokBotSwitch"
$zip = Join-Path $OutputRoot "GrokBotSwitch-windows-x64.zip"
Compress-Archive -Path $dist -DestinationPath $zip -Force
Get-FileHash $zip -Algorithm SHA256 | Format-List
Write-Output "Extract the zip, then open GrokBotSwitch.exe. No Python or Node installation required."
