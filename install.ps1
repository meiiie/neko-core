# Neko Code installer (Windows) — downloads a standalone binary; no Bun required.
#   Latest:  irm https://neko.holilihu.online/install.ps1 | iex
#   Pinned:  & ([scriptblock]::Create((irm https://neko.holilihu.online/install.ps1))) -Version 0.9.0
#            (or set $env:NEKO_VERSION='v0.9.0' before the one-liner)
param([string]$Version)  # MUST be the first statement - lets a scriptblock invocation pass -Version cleanly
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

# Pinned install / ROLLBACK path: -Version (scriptblock arg) OR $env:NEKO_VERSION picks an exact
# release (e.g. '0.9.0') - the public way back to a known-good baseline. Otherwise the latest tag.
$pin = if ($Version) { $Version } elseif ($env:NEKO_VERSION) { $env:NEKO_VERSION } else { $null }
$tag = $null
$rel = $null
$metadataError = $null
if ($pin -match '^v?\d+\.\d+\.\d+$') {
  $tag = if ($pin.StartsWith('v')) { $pin } else { "v$pin" }
  Write-Step "Pinned version: $tag"
  $releaseApi = "https://api.github.com/repos/$repo/releases/tags/$tag"
} else {
  Write-Step 'Fetching latest version...'
  $releaseApi = "https://api.github.com/repos/$repo/releases/latest"
}
try {
  $rel = Invoke-RestMethod -Uri $releaseApi -Headers @{ 'User-Agent' = 'neko-installer'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 15
} catch {
  $metadataError = $_.Exception.Message
}

function Resolve-NekoLatestTag {
  Add-Type -AssemblyName System.Net.Http
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $true
  $handler.MaxAutomaticRedirections = 5
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(15)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('neko-installer')
  try {
    $response = $client.GetAsync("https://github.com/$repo/releases/latest", [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode)" }
    $final = "$($response.RequestMessage.RequestUri.AbsoluteUri)"
    if ($final -match '/releases/tag/(v\d+\.\d+\.\d+)(?:$|[/?#])') { return $Matches[1] }
    throw "unexpected final URL $final"
  } finally {
    if ($response) { $response.Dispose() }
    $client.Dispose()
    $handler.Dispose()
  }
}

if ($rel) {
  if (-not $tag) { $tag = "$($rel.tag_name)" }
  if ($tag -notmatch '^v\d+\.\d+\.\d+$' -or "$($rel.tag_name)" -ne $tag -or $rel.draft -or $rel.prerelease) {
    throw "The selected Neko release is not a stable version: $tag"
  }
  $assetMeta = @($rel.assets | Where-Object { $_.name -eq $asset }) | Select-Object -First 1
  if (-not $assetMeta) { throw "Release $tag does not contain $asset" }
  $url = "$($assetMeta.browser_download_url)"
  $expectedUrl = "https://github.com/$repo/releases/download/$tag/$asset"
  if ($url -ne $expectedUrl) { throw "Release $tag returned an unexpected asset URL" }
  $expectedSize = [long]$assetMeta.size
  $expectedSha = "$($assetMeta.digest)" -replace '^sha256:', ''
  if ($expectedSize -le 0 -or $expectedSize -gt 250MB) { throw "Release $tag returned an invalid asset size" }
  if ($expectedSha -notmatch '^[0-9a-fA-F]{64}$') { throw "Release $tag does not publish a usable SHA-256 digest" }
} else {
  # GitHub's unauthenticated API is limited to 60 requests/hour per public IP. The release redirect and
  # sidecar assets are public, official, and not subject to that API quota, so keep installs available while
  # preserving the same trust chain: exact stable tag -> published SHA-256 -> embedded version probe.
  if (-not $tag) {
    try { $tag = Resolve-NekoLatestTag } catch {
      throw "Could not resolve the latest official Neko release after the GitHub API failed ($metadataError): $($_.Exception.Message)"
    }
  }
  if ($tag -notmatch '^v\d+\.\d+\.\d+$') { throw "The selected Neko release is not a stable version: $tag" }
  $url = "https://github.com/$repo/releases/download/$tag/$asset"
  $checksumUrl = "$url.sha256"
  try {
    $checksumContent = (Invoke-WebRequest -UseBasicParsing -Uri $checksumUrl -Headers @{ 'User-Agent' = 'neko-installer' } -TimeoutSec 15).Content
    $checksumText = if ($checksumContent -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumContent) } else { "$checksumContent" }
  } catch {
    throw "Could not read the official checksum for $tag after the GitHub API failed: $($_.Exception.Message)"
  }
  if ("$checksumText" -notmatch '^\s*([0-9a-fA-F]{64})(?:\s|$)') { throw "Release $tag returned an invalid SHA-256 sidecar" }
  $expectedSha = $Matches[1]
  $expectedSize = 0
  Write-Note "  GitHub API unavailable ($metadataError); verified-release fallback active."
}
$label = $tag

Write-Step "Installing Neko Code $tag (windows-x64)..."

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stage = Join-Path $dir ".neko-download-$PID.exe"
$backup = "$dest.old"
Remove-Item -Force $stage -ErrorAction SilentlyContinue

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

try {
$downloaded = $false
try { Get-NekoBinary $url $stage; $downloaded = $true } catch {
  Write-Note "  ($($_.Exception.Message) - falling back to curl)"
}
if (-not $downloaded -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  # --ssl-no-revoke: schannel fails when the cert's OCSP/CRL host is unreachable (corporate proxy);
  # the chain + hostname are still fully validated.
  & curl.exe -fsSL --retry 3 --ssl-no-revoke -o $stage $url
  if ($LASTEXITCODE -eq 0) { $downloaded = $true }
}
if (-not $downloaded) {
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $stage
}

# Verify release size, digest, and REAL version before touching the working install.
$actualSize = (Get-Item -LiteralPath $stage).Length
if ($expectedSize -gt 0 -and $actualSize -ne $expectedSize) {
  Remove-Item -Force $stage -ErrorAction SilentlyContinue
  throw "Downloaded size mismatch (expected $expectedSize bytes, got $actualSize)"
}
$actualSha = (Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash
if ($actualSha -ne $expectedSha) {
  Remove-Item -Force $stage -ErrorAction SilentlyContinue
  throw "Downloaded SHA-256 does not match the official GitHub release"
}
$ver = ''
try { $ver = (& $stage version 2>$null | Select-Object -First 1) } catch { }
$newVer = if ($ver -match 'neko-core\s+([0-9][0-9.]*)') { $Matches[1] } else { '' }
if (-not $newVer -or "v$newVer" -ne $tag) {
  Remove-Item -Force $stage -ErrorAction SilentlyContinue
  throw "Downloaded binary failed its version probe (expected $tag, got '$ver')"
}

# Replace only after every check passes. File.Replace is atomic on the same Windows volume and leaves
# the old executable untouched if replacement fails (for example, a running neko.exe still locks it).
Remove-Item -Force $backup -ErrorAction SilentlyContinue
try {
  if (Test-Path -LiteralPath $dest) {
    [System.IO.File]::Replace($stage, $dest, $backup, $true)
  } else {
    Move-Item -LiteralPath $stage -Destination $dest
  }
  Remove-Item -Force $backup -ErrorAction SilentlyContinue
} catch {
  Remove-Item -Force $stage -ErrorAction SilentlyContinue
  throw "Could not activate $tag; the previous Neko install was preserved. Close running Neko sessions and retry. $($_.Exception.Message)"
}

Write-Dim  "  Installed to $dest"
Write-Ok "$ver installed (SHA-256 verified)"
} finally {
  Remove-Item -Force $stage -ErrorAction SilentlyContinue
}

# A PINNED install (NEKO_VERSION) is a HOLD: pause auto-update in the user config so the daily updater
# can't drag this exact version forward again. auto_update:false is honored by every release >= 0.7.4
# (the one being installed), so the pin actually sticks. Re-enable with `neko update`.
if ($pin) {
  try {
    $cfgDir = Join-Path $env:USERPROFILE '.neko-core'
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $cfgPath = Join-Path $cfgDir 'config.json'
    $cfg = if (Test-Path $cfgPath) { Get-Content -Raw $cfgPath | ConvertFrom-Json } else { [pscustomobject]@{} }
    $cfg | Add-Member -NotePropertyName auto_update -NotePropertyValue $false -Force
    ($cfg | ConvertTo-Json -Depth 20) | Set-Content -Encoding utf8 $cfgPath
    Write-Note "  Pinned to $label - auto-update paused so it holds. Resume with: neko update"
  } catch { Write-Note "  (could not pin auto_update - set `"auto_update`": false in ~/.neko-core/config.json to hold)" }
}

# PATH: compare per ENTRY, never by substring - "...\Programs\neko-core" (the pre-v0.3 install dir)
# CONTAINS "...\Programs\neko", so a wildcard check false-positives and the real dir never gets added.
function Test-OnPath($pathString, $wantDir) {
  $want = $wantDir.TrimEnd('\')
  foreach ($e in ("$pathString" -split ';')) {
    if ($e -and ($e.Trim().TrimEnd('\') -eq $want)) { return $true }
  }
  return $false
}
# Always report the state. PREPEND so this install wins over stale copies later in the User PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (Test-OnPath $userPath $dir)) {
  $newPath = if ($userPath) { "$dir;$userPath" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Dim "  Added $dir to your User PATH."
} else {
  Write-Dim "  $dir is already on your User PATH."
}
# Make `neko` work in THIS shell too (iex runs in the user's session, so this sticks until it closes;
# new terminals pick the User PATH up on their own).
if (-not (Test-OnPath $env:Path $dir)) { $env:Path = "$dir;$env:Path" }

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

# Legacy cleanup - the pre-v0.3 installer used ...\Programs\neko-core. Once no neko.exe lives there
# (shadow healing above removes outdated ones), drop the dangling User PATH entry and the empty dir.
try {
  $legacy = Join-Path $env:LOCALAPPDATA 'Programs\neko-core'
  if (-not (Test-Path (Join-Path $legacy 'neko.exe'))) {
    if ((Test-Path $legacy) -and -not @(Get-ChildItem -Force $legacy)) { Remove-Item -Force $legacy }
    $up = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (Test-OnPath $up $legacy) {
      $kept = @("$up" -split ';' | Where-Object { $_ -and ($_.Trim().TrimEnd('\') -ne $legacy.TrimEnd('\')) })
      [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
      Write-Dim "  Removed the stale $legacy entry from your User PATH."
    }
  }
} catch { }

Write-Host ''
Write-Ok "Run 'neko' to get started!  Then use /login to choose ChatGPT, API, or another provider."
Write-Dim "  neko doctor          - check provider / model / authentication"
Write-Dim "  neko support status  - optional GPT-5.6 Sol/Terra/Luna support"
Write-Dim "  neko --yolo   - auto-approve mode: Neko runs tools without asking"
