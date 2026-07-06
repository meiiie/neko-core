# Neko Code installer (Windows) — downloads a standalone binary; no Bun required.
#   irm https://neko.holilihu.online/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo  = 'meiiie/neko-core'
$asset = 'neko-windows-x64.exe'
$dir   = Join-Path $env:LOCALAPPDATA 'Programs\neko'
$dest  = Join-Path $dir 'neko.exe'

function Write-Step($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Write-Note($msg) { Write-Host $msg -ForegroundColor Yellow }

# Resolve the real latest tag first so the user sees WHAT is being installed.
Write-Step 'Fetching latest version...'
$tag = $null
try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'neko-installer' } -TimeoutSec 15
  $tag = $rel.tag_name
} catch { }
$label = if ($tag) { $tag } else { 'latest' }
Write-Step "Installing Neko Code $label (windows-x64)..."
$url = if ($tag) { "https://github.com/$repo/releases/download/$tag/$asset" }
       else      { "https://github.com/$repo/releases/latest/download/$asset" }

New-Item -ItemType Directory -Force -Path $dir | Out-Null
# Prefer curl.exe (ships with Windows 10 1803+) with a clean single-line progress bar; Invoke-WebRequest's
# progress cripples large downloads in Windows PowerShell (10-40x slower), so it's only the fallback.
# --ssl-no-revoke: curl's schannel backend fails (CRYPT_E_NO_REVOCATION_CHECK) when the cert's OCSP/CRL
# host is unreachable (corporate proxy); the chain + hostname are still fully validated.
$ok = $false
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  & curl.exe -fL --retry 3 --ssl-no-revoke --progress-bar -o $dest $url
  if ($LASTEXITCODE -eq 0) { $ok = $true }
  else { Write-Note "curl failed (exit $LASTEXITCODE) - retrying with Invoke-WebRequest..." }
}
if (-not $ok) {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $dest
}

# Verify the binary actually runs; report its REAL version, not just the download's.
$ver = ''
try { $ver = (& $dest version 2>$null | Select-Object -First 1) } catch { }
if ($ver) { Write-Ok "$ver installed to $dest" } else { Write-Ok "Installed to $dest" }

# PATH: always report the state. PREPEND so this install wins over stale copies later in the User PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$dir;$userPath", 'User')
  Write-Ok "Added $dir to your User PATH (open a NEW terminal to pick it up)."
} else {
  Write-Ok "$dir is already on your User PATH."
}

# SHADOW CHECK — the "installed the new version but `neko --version` still shows the old one" trap:
# another `neko` earlier on PATH (an old copy, a shim) wins over this install. Name it precisely.
try {
  $hits = @(where.exe neko 2>$null)
  $others = @($hits | Where-Object { $_ -and ($_ -ne $dest) })
  if ($others.Count -gt 0) {
    Write-Note 'WARNING: other `neko` executables are on your PATH and can SHADOW this install:'
    foreach ($o in $others) { Write-Note "  $o" }
    Write-Note 'If a new terminal still reports an old version, remove them:'
    foreach ($o in $others) { Write-Note "  del `"$o`"" }
  }
} catch { }

Write-Host ''
Write-Ok "Run 'neko' to get started!  (first time: 'neko init-user' to set up your API key)"
