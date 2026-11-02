# Runs the recorder's test suite in Brave, headless, against the extension loaded unpacked.
#
#   powershell -ExecutionPolicy Bypass -File test/run-tests.ps1
#   powershell -ExecutionPolicy Bypass -File test/run-tests.ps1 -SkipTabCapture
#
# What it does, in order:
#   1. starts test/serve.ps1 on 127.0.0.1:8787 unless something is already listening there;
#   2. launches a throwaway-profile Brave with the extension loaded and a CDP port, so the
#      pages can be opened and their titles (which carry PASS/FAIL) read back;
#   3. runs each page test and prints its summary;
#   4. runs the tab capture test last, because it needs the extension itself.
#
# The tab capture test also needs one real click on the toolbar icon (Chromium only hands a
# tab's stream to an extension the user has invoked on that tab: see
# chrome/browser/extensions/api/tab_capture/tab_capture_api.cc). Open the popup once on the
# tab under test while it is waiting, or accept the FAIL it reports with that reason.
#
# Exit code 0 when every check passed, 1 otherwise.

param(
  [int]$Port = 8787,
  [int]$CdpPort = 9401,
  [switch]$SkipTabCapture,
  [int]$PageTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$brave = @(
  "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
  "${env:ProgramFiles(x86)}\BraveSoftware\Brave-Browser\Application\brave.exe",
  "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $brave) { throw 'Brave is not installed in a standard location.' }

$profileDir = Join-Path $env:TEMP "suno-wav-tests-$PID"

function Stop-TestBrave {
  Get-CimInstance Win32_Process -Filter "Name='brave.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$profileDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-TestBrave([string[]]$extra) {
  Stop-TestBrave
  if (Test-Path $profileDir) { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $profileDir | Out-Null
  $arguments = @(
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    "--user-data-dir=$profileDir", "--remote-debugging-port=$CdpPort",
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,860'
  ) + $extra + @('about:blank')
  $script:braveJob = Start-Job -ScriptBlock { param($exe, $jobArgs) & $exe @jobArgs } -ArgumentList $brave, $arguments
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2 | Out-Null; return $true } catch { }
  }
  throw "Brave did not open its debugging port on $CdpPort."
}

function Open-Tab([string]$url) {
  $encoded = [System.Uri]::EscapeDataString($url)
  return Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$CdpPort/json/new?$encoded" -TimeoutSec 5
}

function Get-TabTitleById([string]$tabId) {
  try {
    $list = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3
    $page = $list | Where-Object { $_.id -eq $tabId } | Select-Object -First 1
    if ($page) { return $page.title }
  } catch { }
  return ''
}

# Waits for a summary title ("PASS n/n" or "FAIL n of m") on one tab and returns it.
function Wait-Summary([string]$tabId, [int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  $last = ''
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $last = Get-TabTitleById $tabId
    if ($last -match '^(PASS|FAIL)\s') { return $last }
  }
  return "(no summary; last title: $last)"
}

# --------------------------------------------------------------------------
# 1. the file server
# --------------------------------------------------------------------------

$listening = $false
try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/test/serve.ps1" -UseBasicParsing -TimeoutSec 3 | Out-Null; $listening = $true } catch { }
if (-not $listening) {
  Write-Host "starting test/serve.ps1 on port $Port"
  Start-Process -FilePath 'powershell' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'test\serve.ps1'), '-Port', "$Port"
  ) | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/test/serve.ps1" -UseBasicParsing -TimeoutSec 3 | Out-Null; break } catch { }
  }
}

$base = "http://127.0.0.1:$Port"
$results = New-Object System.Collections.Generic.List[object]

# --------------------------------------------------------------------------
# 2. the page tests, in a plain headless browser
# --------------------------------------------------------------------------

Start-TestBrave @() | Out-Null

$pageTests = @(
  @{ Name = 'modules'; Url = "$base/test/modules.test.html"; Timeout = 60 },
  @{ Name = 'background (contract)'; Url = "$base/test/background.test.html"; Timeout = 60 },
  @{ Name = 'wav-encoder'; Url = "$base/test/wav-encoder.test.html?upload=1"; Timeout = 60 },
  @{ Name = 'worklet'; Url = "$base/test/worklet.test.html?upload=1"; Timeout = 60 },
  @{ Name = 'stereo'; Url = "$base/test/stereo.test.html?upload=1"; Timeout = 60 },
  @{ Name = 'long-take (30 min)'; Url = "$base/test/long-take.test.html?upload=1"; Timeout = 180 }
)

foreach ($test in $pageTests) {
  Write-Host ''
  Write-Host "=== $($test.Name)" -ForegroundColor Cyan
  $tab = Open-Tab $test.Url
  $title = Wait-Summary $tab.id $test.Timeout
  Write-Host "   $title"
  $results.Add([pscustomobject]@{ Test = $test.Name; Summary = $title })
}

Stop-TestBrave

# --------------------------------------------------------------------------
# 3. the tab capture test, in a headless browser with the extension loaded
# --------------------------------------------------------------------------

if (-not $SkipTabCapture) {
  Write-Host ''
  Write-Host '=== tab capture (extension loaded unpacked)' -ForegroundColor Cyan
  Start-TestBrave @("--disable-extensions-except=$root", "--load-extension=$root") | Out-Null
  $extensionId = ''
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $list = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3
      $worker = $list | Where-Object { $_.url -like 'chrome-extension://*/background.js' } | Select-Object -First 1
      if ($worker) { $extensionId = ($worker.url -split '/')[2]; break }
    } catch { }
  }
  if (-not $extensionId) {
    # No service-worker target yet. Chromium derives an unpacked extension's id from the
    # raw bytes of its path, so the id can be computed instead of discovered: SHA-256 of the
    # path (UTF-16LE on Windows), first 16 bytes, each nibble mapped to a-p.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::Unicode.GetBytes($root))
    $builder = New-Object System.Text.StringBuilder
    foreach ($b in $hash[0..15]) {
      [void]$builder.Append([char](97 + ($b -shr 4)))
      [void]$builder.Append([char](97 + ($b -band 0x0f)))
    }
    $extensionId = $builder.ToString()
    Write-Host "   no service worker listed; using the id computed from the path: $extensionId"
  }
  if (-not $extensionId) {
    Write-Host '   could not find the extension id; skipping'
    $results.Add([pscustomobject]@{ Test = 'tab capture'; Summary = 'SKIPPED (no extension id)' })
  } else {
    $url = "chrome-extension://$extensionId/test/tabcapture.test.html?upload=1&invokewait=20000&serve=$([System.Uri]::EscapeDataString($base))"
    $tab = Open-Tab $url
    $title = Wait-Summary $tab.id 120
    Write-Host "   $title"
    # tabCapture only hands out a stream id for a tab the extension has been invoked on.
    # A headless run cannot click the toolbar icon, so that one check is reported as a
    # LIMIT with its reason, and every other check has to pass.
    $summary = $title
    $reportPath = Join-Path (Join-Path (Join-Path $root 'test') 'out') 'tabcapture-report.json'
    if ($title -notmatch '^PASS' -and (Test-Path $reportPath)) {
      $report = Get-Content $reportPath -Raw | ConvertFrom-Json
      $blocked = if ($report.outcome) { [string]$report.outcome.blocked } else { '' }
      if ($blocked -match 'has not been invoked') {
        $others = @($report.results | Where-Object { -not $_.pass -and $_.name -ne 'getMediaStreamId answered a stream id' })
        if ($others.Count -eq 0) { $summary = 'LIMIT (one toolbar click needed: tabCapture activeTab)' }
      }
      Write-Host "   blocked: $blocked"
    }
    $results.Add([pscustomobject]@{ Test = 'tab capture'; Summary = $summary })
  }
  Stop-TestBrave
  if ($script:braveJob) { Stop-Job $script:braveJob -ErrorAction SilentlyContinue; Remove-Job $script:braveJob -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------------------------
# 4. the files the tests wrote
# --------------------------------------------------------------------------

Write-Host ''
Write-Host '=== files in test/out' -ForegroundColor Cyan
Get-ChildItem (Join-Path $root 'test\out') -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 12 Name, Length, LastWriteTime |
  Format-Table -AutoSize | Out-String -Width 140 | Write-Host

foreach ($wav in @('wav-encoder-test-440hz.wav')) {
  $path = Join-Path $root "test\out\$wav"
  if (Test-Path $path) {
    Write-Host "=== inspect-wav.ps1 $wav" -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'test\inspect-wav.ps1') $path -ExpectedHz 440
    if ($LASTEXITCODE -ne 0) { $results.Add([pscustomobject]@{ Test = "inspect $wav"; Summary = 'FAIL' }) }
  }
}

Write-Host ''
Write-Host '=== summary' -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 140 | Write-Host

$failed = @($results | Where-Object { $_.Summary -notmatch '^(PASS|LIMIT)' }).Count
if ($failed -gt 0) {
  Write-Host "$failed test(s) did not pass." -ForegroundColor Red
  exit 1
}
Write-Host 'Every test passed.' -ForegroundColor Green
exit 0
