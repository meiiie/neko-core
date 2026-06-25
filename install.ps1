# Neko Code installer (Windows) — downloads a standalone binary; no Bun required.
#   irm https://raw.githubusercontent.com/meiiie/neko-core/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo  = 'meiiie/neko-core'
$asset = 'neko-windows-x64.exe'
$dir   = Join-Path $env:LOCALAPPDATA 'Programs\neko'
$dest  = Join-Path $dir 'neko.exe'
$url   = "https://github.com/$repo/releases/latest/download/$asset"

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "neko: downloading $asset ..."
Invoke-WebRequest -Uri $url -OutFile $dest

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "neko: added $dir to your PATH (open a new terminal to pick it up)."
}
Write-Host "neko: installed to $dest"
Write-Host "neko: verify with 'neko --version', then set up your key with 'neko init-user'."
