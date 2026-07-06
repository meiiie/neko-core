# Neko Code installer (Windows) — downloads a standalone binary; no Bun required.
#   irm https://neko.holilihu.online/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo  = 'meiiie/neko-core'
$asset = 'neko-windows-x64.exe'
$dir   = Join-Path $env:LOCALAPPDATA 'Programs\neko'
$dest  = Join-Path $dir 'neko.exe'

function Write-Step($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Write-Dim($msg)  { Write-Host $msg -ForegroundColor DarkGray }
function Write-Note($msg) { Write-Host $msg -ForegroundColor Yellow }

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

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

# Download with an IN-PLACE progress line (grok/uv-style), streaming via HttpClient - full speed (no
# Invoke-WebRequest progress tax) and no dependence on how curl renders its bar under iex.
function Get-NekoBinary($url, $dest) {
  Add-Type -AssemblyName System.Net.Http
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromMinutes(10)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('neko-installer')
  try {
    $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode)" }
    $total = $resp.Content.Headers.ContentLength
    $in  = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $out = [System.IO.File]::Create($dest)
    try {
      $buf = New-Object byte[] 1048576
      $done = [long]0; $lastDraw = [datetime]::MinValue
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $n); $done += $n
        if (([datetime]::Now - $lastDraw).TotalMilliseconds -ge 100) {
          $lastDraw = [datetime]::Now
          if ($total) {
            $pct = [int](100 * $done / $total)
            Write-Host -NoNewline ("`r  Downloading... {0:N1} MB / {1:N1} MB ({2}%)   " -f ($done/1MB), ($total/1MB), $pct)
          } else {
            Write-Host -NoNewline ("`r  Downloading... {0:N1} MB   " -f ($done/1MB))
          }
        }
      }
      if ($total) { Write-Host ("`r  Downloading... {0:N1} MB / {0:N1} MB (100%)   " -f ($total/1MB)) }
      else        { Write-Host ("`r  Downloading... {0:N1} MB - done          " -f ($done/1MB)) }
    } finally { $out.Dispose(); $in.Dispose() }
  } finally { $client.Dispose() }
}

$downloaded = $false
try { Get-NekoBinary $url $dest; $downloaded = $true } catch {
  Write-Note "  ($($_.Exception.Message) - falling back to curl)"
}
if (-not $downloaded -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  # --ssl-no-revoke: schannel fails when the cert's OCSP/CRL host is unreachable (corporate proxy);
  # the chain + hostname are still fully validated.
  & curl.exe -fsSL --retry 3 --ssl-no-revoke -o $dest $url
  if ($LASTEXITCODE -eq 0) { $downloaded = $true }
}
if (-not $downloaded) {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $dest
}

# Verify the binary actually runs; report its REAL version.
$ver = ''
try { $ver = (& $dest version 2>$null | Select-Object -First 1) } catch { }
$newVer = if ($ver -match 'neko-core\s+([0-9][0-9.]*)') { $Matches[1] } else { '' }
Write-Dim  "  Installed to $dest"
if ($ver) { Write-Ok "$ver installed" } else { Write-Ok 'Installed' }

# PATH: always report the state. PREPEND so this install wins over stale copies later in the User PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable('Path', "$dir;$userPath", 'User')
  Write-Dim "  Added $dir to your User PATH (open a NEW terminal to pick it up)."
} else {
  Write-Dim "  $dir is already on your User PATH."
}

# SHADOW HEALING - the "installed the new version but neko still says 0.2" trap: another `neko` earlier
# on PATH wins over this install. If it IS an OLDER neko-core (verified by running `version`), remove it
# automatically, rustup-style; anything else (same/newer, or not a neko) is only reported, never touched.
try {
  $hits = @(where.exe neko 2>$null)
  foreach ($o in ($hits | Where-Object { $_ -and ($_ -ne $dest) })) {
    $ov = ''
    try { $ov = (& $o version 2>$null | Select-Object -First 1) } catch { }
    if ($ov -notmatch 'neko-core') { try { $ov = (& $o --version 2>$null | Select-Object -First 1) } catch { } } # pre-v0.3 CLIs only knew --version
    if ($ov -match 'neko-core\s+([0-9][0-9.]*)' -and $newVer -and ([version]$Matches[1] -lt [version]$newVer)) {
      try {
        Remove-Item -Force $o
        Write-Dim "  Removed outdated neko-core $($Matches[1]) at $o (it shadowed this install)."
      } catch {
        Write-Note "WARNING: an OLD neko ($ov) shadows this install and could not be removed:"
        Write-Note "  $o    -> close any running neko and delete it:  del `"$o`""
      }
    } else {
      Write-Note "NOTE: another neko executable is on your PATH and may shadow this install:"
      Write-Note "  $o"
    }
  }
} catch { }

Write-Host ''
Write-Ok "Run 'neko' to get started!  (first time: 'neko init-user' to set up your API key)"
