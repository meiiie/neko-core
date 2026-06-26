# Neko Code installer (Windows) — downloads a standalone binary; no Bun required.
#   irm https://raw.githubusercontent.com/meiiie/neko-core/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo  = 'meiiie/neko-core'
$asset = 'neko-windows-x64.exe'
$dir   = Join-Path $env:LOCALAPPDATA 'Programs\neko'
$dest  = Join-Path $dir 'neko.exe'
$url   = "https://github.com/$repo/releases/latest/download/$asset"

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "neko: downloading $asset (~100 MB) ..."
# Prefer curl.exe (ships with Windows 10 1803+): full-speed download. Invoke-WebRequest's progress
# bar cripples large downloads (10-40x slower in Windows PowerShell), so it's only the fallback.
# --ssl-no-revoke: curl's schannel backend fails (exit 35, CRYPT_E_NO_REVOCATION_CHECK) when it can't
# reach the cert's OCSP/CRL server (corporate proxy, blocked, or soft-fail). The cert chain + hostname
# are still validated; only the (flaky) revocation step is skipped. If curl still fails for any reason,
# fall back to Invoke-WebRequest, whose .NET TLS stack handles revocation differently.
$ok = $false
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fSL --retry 3 --ssl-no-revoke -o $dest $url
  if ($LASTEXITCODE -eq 0) { $ok = $true }
  else { Write-Host "neko: curl failed (exit $LASTEXITCODE) - retrying with Invoke-WebRequest ..." }
}
if (-not $ok) {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $dest
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "neko: added $dir to your PATH (open a new terminal to pick it up)."
}
Write-Host "neko: installed to $dest"
Write-Host "neko: verify with 'neko --version', then set up your key with 'neko init-user'."
