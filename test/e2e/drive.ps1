<#
.SYNOPSIS
  End-to-end run of the Suno WAV Recorder in the real Brave on this machine.

.DESCRIPTION
  Loads the extension into a throwaway Brave profile, opens a tab that really plays audio,
  starts and stops a recording through the extension's own message contract, waits for the WAV
  download to reach "complete", and then checks the bytes on disk: RIFF/WAVE structure, sample
  rate, channels, duration, and (via a zero-crossing count) that the 440 Hz test tone is
  actually in the file.

  Everything happens in %TEMP%\suno-wav-e2e-<id>: the profile, the download folder, a copy of
  the extension and the report. Nothing touches the user's own Brave profile, and the whole
  directory is deleted afterwards unless -Keep is passed.

  The extension copy gets one extra host permission, http://127.0.0.1/*, because tabCapture
  only opens a stream for a tab the extension was invoked on or already has host access to;
  the real manifest gets that access from https://suno.com/*.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File test/e2e/drive.ps1
  powershell -ExecutionPolicy Bypass -File test/e2e/drive.ps1 -RecordMs 8000 -Keep
#>
[CmdletBinding()]
param(
  [string]$Brave = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe',
  [int]$ServePort = 8788,
  [int]$CdpPort = 9333,
  [ValidateSet('capture', 'stub')][string]$Mode = 'capture',
  [switch]$Headless,
  # Browser.setDownloadBehavior: 'allow' keeps the suggested name, 'allowAndName' saves under
  # the download's GUID. Both are honoured only by headless Brave, which has no Save dialog.
  [ValidateSet('allow', 'allowAndName')][string]$DownloadBehavior = 'allow',
  [int]$RecordMs = 6000,
  [int]$SaveWaitSeconds = 150,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# <root>\test\e2e\drive.ps1 -> <root>
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $RepoRoot 'manifest.json'))) { throw "no manifest.json above $PSScriptRoot" }
if (-not (Test-Path $Brave)) { throw "Brave not found at $Brave" }

$stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
$RunDir = Join-Path $env:TEMP "suno-wav-e2e-$stamp"
$ExtDir = Join-Path $RunDir 'ext'
$ProfileDir = Join-Path $RunDir 'profile'
$DownloadDir = Join-Path $RunDir 'downloads'
$OutDir = Join-Path $RunDir 'out'
New-Item -ItemType Directory -Force -Path $ExtDir, $ProfileDir, $DownloadDir, $OutDir, (Join-Path $ProfileDir 'Default') | Out-Null

$braveProcess = $null
$serverJob = $null
$failures = New-Object System.Collections.Generic.List[string]
$passes = New-Object System.Collections.Generic.List[string]

function Say([string]$text) { Write-Output $text }

# One DevTools-protocol command to the browser endpoint of the Brave this run started, so the
# run can set Browser.setDownloadBehavior without a second PowerShell process and without the
# quoting trouble of passing JSON through -File.
function Send-CdpBrowserCommand {
  param([int]$Port, [string]$Method, [hashtable]$CommandParams, [int]$TimeoutMs = 15000)
  try {
    $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
    $token = [System.Threading.CancellationToken]::None
    $ws = [System.Net.WebSockets.ClientWebSocket]::new()
    $ws.ConnectAsync([uri]$version.webSocketDebuggerUrl, $token).Wait($TimeoutMs)
    $json = @{ id = 1; method = $Method; params = $CommandParams } | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $ws.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $token).Wait($TimeoutMs)
    $buffer = New-Object byte[] 65536
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
      $segment = [System.ArraySegment[byte]]::new($buffer)
      $task = $ws.ReceiveAsync($segment, $token)
      if (-not $task.Wait(3000)) { continue }
      $frame = $task.Result
      $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $frame.Count)
      $ws.Dispose()
      if ($text -match '"id":1') {
        if ($text -match '"error"') { return ($text) }
        return 'ok'
      }
    }
    $ws.Dispose()
    return 'no reply'
  } catch {
    return ('failed: ' + $_.Exception.Message)
  }
}
function Pass([string]$name, $ok, [string]$detail = '') {
  if ($ok) { $passes.Add($name); Say "  PASS  $name" }
  else { $failures.Add("$name -- $detail"); Say "  FAIL  $name  $detail" }
}

try {
  # ---------------------------------------------------------------- stage the extension
  Say "run dir: $RunDir"
  $skip = @('test', 'dist', '.git', 'node_modules')
  Get-ChildItem -Path $RepoRoot -Force | Where-Object {
    $skip -notcontains $_.Name -and $_.Extension -ne '.zip'
  } | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $ExtDir -Recurse -Force
  }
  Copy-Item (Join-Path $PSScriptRoot 'tone.html') (Join-Path $ExtDir 'e2e-tone.html') -Force
  Copy-Item (Join-Path $PSScriptRoot 'harness.html') (Join-Path $ExtDir 'e2e-harness.html') -Force
  Copy-Item (Join-Path $PSScriptRoot 'harness.js') (Join-Path $ExtDir 'e2e-harness.js') -Force
  Copy-Item (Join-Path $PSScriptRoot 'harness.css') (Join-Path $ExtDir 'e2e-harness.css') -Force

  # tabCapture needs host access to http://127.0.0.1 for the test tab. The shipped manifest
  # gets the same thing from https://suno.com/*; only this throwaway copy is widened.
  $manifestPath = Join-Path $ExtDir 'manifest.json'
  $manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
  $hosts = @($manifest.host_permissions) + @('http://127.0.0.1/*')
  $manifest | Add-Member -NotePropertyName host_permissions -NotePropertyValue $hosts -Force
  # tabCapture also needs a genuine invocation of the extension on the recorded tab. A keyboard
  # shortcut is one of the ways Chrome grants that (the activeTab rules), and it is the only one
  # an automated run can produce without a human clicking the toolbar icon.
  $commands = @{ _execute_action = @{ suggested_key = @{ default = 'Ctrl+Shift+Y' } } }
  $manifest | Add-Member -NotePropertyName commands -NotePropertyValue $commands -Force
  ($manifest | ConvertTo-Json -Depth 20) | Set-Content -Path $manifestPath -Encoding UTF8

  # A profile that saves where this run can see it, with no first-run chrome.
  $prefs = @{
    download = @{ default_directory = $DownloadDir; prompt_for_download = $false; directory_upgrade = $true }
    savefile = @{ default_directory = $DownloadDir }
    profile = @{ exit_type = 'Normal'; exited_cleanly = $true }
    browser = @{ has_seen_welcome_page = $true }
    intl = @{ app_locale = 'en-US' }
  } | ConvertTo-Json -Depth 8
  Set-Content -Path (Join-Path $ProfileDir 'Default\Preferences') -Value $prefs -Encoding UTF8

  # ---------------------------------------------------------------- local test server
  $serverJob = Start-Job -ArgumentList $ExtDir, $OutDir, $ServePort -ScriptBlock {
    param($root, $outDir, $port)
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://127.0.0.1:$port/")
    $listener.Start()
    $types = @{
      '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
      '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
      '.wav' = 'audio/wav'; '.png' = 'image/png'
    }
    while ($listener.IsListening) {
      try { $ctx = $listener.GetContext() } catch { break }
      $res = $ctx.Response
      try {
        $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        # The harness page is chrome-extension://..., so every request it makes is cross-origin.
        $res.Headers.Add('Access-Control-Allow-Origin', '*')
        $res.Headers.Add('Access-Control-Allow-Headers', 'content-type')
        if ($ctx.Request.HttpMethod -eq 'OPTIONS') {
          $res.StatusCode = 204
        } elseif ($ctx.Request.HttpMethod -eq 'POST') {
          $name = [System.IO.Path]::GetFileName($rel)
          if ([string]::IsNullOrWhiteSpace($name)) { $name = 'upload.json' }
          $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
          $body = $reader.ReadToEnd()
          $reader.Dispose()
          [System.IO.File]::WriteAllText((Join-Path $outDir $name), $body)
          $res.StatusCode = 204
        } else {
          if ([string]::IsNullOrWhiteSpace($rel)) { $rel = 'e2e-tone.html' }
          $file = Join-Path $root $rel
          if (Test-Path $file -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
            $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
            $res.Headers.Add('Cache-Control', 'no-store')
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
          } else {
            $res.StatusCode = 404
          }
        }
      } catch {
        try { $res.StatusCode = 500 } catch { }
      } finally {
        try { $res.OutputStream.Close() } catch { }
      }
    }
  }
  # The server is a background job; if it never answers, every later step would report a
  # missing report rather than the real fault, so fail here with its own output.
  $serverReady = $false
  for ($i = 0; $i -lt 25; $i++) {
    try {
      $probe = Invoke-WebRequest "http://127.0.0.1:$ServePort/e2e-tone.html" -TimeoutSec 2 -UseBasicParsing
      if ($probe.StatusCode -eq 200) { $serverReady = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  if (-not $serverReady) {
    $jobOutput = (Receive-Job $serverJob -Keep -ErrorAction SilentlyContinue) -join ' '
    throw "the test server never came up on port $ServePort (job state $($serverJob.State)): $jobOutput"
  }

  # ---------------------------------------------------------------- launch Brave
  Say 'launching Brave with the extension loaded...'
  $extra = @()
  if ($Headless) { $extra = @('--headless=new') }
  $braveArgs = $extra + @(
    "--user-data-dir=$ProfileDir"
    "--load-extension=$ExtDir"
    "--remote-debugging-port=$CdpPort"
    '--no-first-run'
    '--no-default-browser-check'
    '--disable-features=BraveWelcome,Translate'
    '--autoplay-policy=no-user-gesture-required'
    '--disable-background-timer-throttling'
    '--disable-backgrounding-occluded-windows'
    '--disable-renderer-backgrounding'
    '--window-size=1280,900'
    'about:blank'
  )
  $braveProcess = Start-Process -FilePath $Brave -ArgumentList $braveArgs -PassThru

  $deadline = (Get-Date).AddSeconds(40)
  $targets = $null
  while ((Get-Date) -lt $deadline) {
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3 } catch { $targets = $null }
    if ($targets) { break }
    Start-Sleep -Milliseconds 400
  }
  if (-not $targets) { throw 'Brave never opened its debugging port' }

  $extId = $null
  $idDeadline = (Get-Date).AddSeconds(20)
  while (-not $extId -and (Get-Date) -lt $idDeadline) {
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3 } catch { $targets = @() }
    foreach ($t in @($targets)) {
      if ($t.url -match '^chrome-extension://([a-p]{32})/') { $extId = $Matches[1]; break }
    }
    if (-not $extId) { Start-Sleep -Milliseconds 400 }
  }
  if (-not $extId) { throw 'the extension never loaded (--load-extension may be ignored by this Brave build)' }
  Say "extension id: $extId"

  # Headless Brave cancels a saveAs download instead of prompting, so tell the browser where a
  # download may land before anything starts one. A headed browser ignores this and shows the
  # dialog; the run then waits for someone to confirm it.
    $setBehavior = Send-CdpBrowserCommand -Port $CdpPort -Method 'Browser.setDownloadBehavior' -CommandParams @{ behavior = $DownloadBehavior; downloadPath = $DownloadDir }
  Say "  download behavior: $setBehavior"

    # Brave records any manifest problem it found while loading the extension here; the brief's
  # bar is "no permission warnings beyond the ones the manifest declares".
  Start-Sleep -Milliseconds 800
  $warnings = @()
  foreach ($file in @('Preferences', 'Secure Preferences')) {
    $path = Join-Path $ProfileDir "Default\$file"
    if (-not (Test-Path $path)) { continue }
    try {
      $prefs = Get-Content -Raw $path | ConvertFrom-Json
      $settings = $prefs.extensions.settings
      if ($settings -and $settings.PSObject.Properties.Name -contains $extId) {
        $entry = $settings.$extId
        foreach ($w in @($entry.install_warnings)) { if ($w) { $warnings += ($w | ConvertTo-Json -Compress) } }
      }
    } catch { }
  }
  Say "  install warnings: $($warnings.Count)"
  if ($warnings.Count -eq 0) { Pass 'the extension loaded with no install warnings' $true }
  else { Pass 'the extension loaded with no install warnings' $false ($warnings -join '; ') }

  $harnessUrl = "chrome-extension://$extId/e2e-harness.html?serve=$([uri]::EscapeDataString("http://127.0.0.1:$ServePort"))&tone=$([uri]::EscapeDataString("http://127.0.0.1:$ServePort/e2e-tone.html"))&mode=$Mode&ms=$RecordMs&savewait=$($SaveWaitSeconds * 1000)&invokewait=90000"
  $null = Invoke-RestMethod -Method Put "http://127.0.0.1:$CdpPort/json/new?$([uri]::EscapeDataString($harnessUrl))" -TimeoutSec 5
  Say 'harness tab opened; the run is now driving itself'

  # ---------------------------------------------------------------- watch the report
  $reportPath = Join-Path $OutDir 'e2e-report.json'
  $tonePath = Join-Path $OutDir 'tone-report.json'
  $lastStage = ''
  $lastLine = ''
  $finishedAt = $null
  $savePrompted = $false
  $invokePrompted = $false
  $serverDeathReported = $false
  $budget = if ($Mode -eq 'stub') { $SaveWaitSeconds + 120 } else { $RecordMs / 1000 + $SaveWaitSeconds + 150 }
  $runDeadline = (Get-Date).AddSeconds($budget)

  while ((Get-Date) -lt $runDeadline) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $tonePath) {
      try {
        $tone = Get-Content -Raw $tonePath | ConvertFrom-Json
        if (-not $script:toneRate) { $script:toneRate = $tone.rate; Say "  tone tab: AudioContext at $($tone.rate) Hz, state $($tone.state)" }
      } catch { }
    }
    if ($serverJob.State -ne 'Running' -and -not $serverDeathReported) {
      $serverDeathReported = $true
      Say ("  the test server stopped: " + $serverJob.State + " " + ((Receive-Job $serverJob -Keep -ErrorAction SilentlyContinue) -join ' '))
    }
    if (-not (Test-Path $reportPath)) { continue }
    try { $report = Get-Content -Raw $reportPath | ConvertFrom-Json } catch { continue }
    if ($report.stage -ne $lastStage) {
      $lastStage = $report.stage
      Say "  stage: $lastStage"
    }
    $prog = $report.lastProgress
    if ($prog -and $prog.seconds) {
      $line = "    recorded {0:N1}s, peak {1} dBFS" -f [double]$prog.seconds, $prog.peakDb
      if ($line -ne $lastLine) { Say $line; $lastLine = $line }
    }
    if ($report.stage -eq 'need-invocation' -and -not $invokePrompted) {
      $invokePrompted = $true
      Say '  AWAITING_SHORTCUT'
    }
    if ($report.stage -eq 'awaiting-download' -and -not $savePrompted) {
      $savePrompted = $true
      Say '  AWAITING_SAVE_DIALOG'
    }
    if ($report.stage -like 'finished*' -or $report.stage -eq 'crashed') { $finishedAt = Get-Date; break }
  }

  if (-not $finishedAt) { Say 'the harness did not finish in time' }
  if (Test-Path $reportPath) { New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'out') | Out-Null; Copy-Item $reportPath (Join-Path $PSScriptRoot 'out\e2e-report.json') -Force -ErrorAction SilentlyContinue }

  # ---------------------------------------------------------------- judge the run
  Say ''
  Say 'harness checks:'
  $checks = @()
  if (Test-Path $reportPath) {
    $report = Get-Content -Raw $reportPath | ConvertFrom-Json
    $checks = @($report.checks)
    foreach ($c in $checks) {
      if ($c.pass) { Pass $c.name $true }
      else { Pass $c.name $false ([string]$c.detail) }
    }
    $savedPath = $report.savedPath
  } else {
    Pass 'the harness wrote a report' $false 'no report file'
    $savedPath = $null
  }

  # ---------------------------------------------------------------- check the WAV bytes
  Say ''
  Say 'file checks:'
  if (-not $savedPath) {
    $candidate = Get-ChildItem -Path $DownloadDir -Filter '*.wav' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { $savedPath = $candidate.FullName }
  }
  if (-not $savedPath -or -not (Test-Path $savedPath)) {
    Pass 'a .wav file exists on disk' $false "nothing found in $DownloadDir"
  } else {
    Say "  file: $savedPath"
    $bytes = [System.IO.File]::ReadAllBytes($savedPath)
    Pass 'the file is at least 10 kB' ($bytes.Length -gt 10000) "$($bytes.Length) bytes"
    $riff = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 4)
    $wave = [System.Text.Encoding]::ASCII.GetString($bytes, 8, 4)
    Pass 'the header says RIFF/WAVE' ($riff -eq 'RIFF' -and $wave -eq 'WAVE') "$riff/$wave"

    $fmt = [System.Text.Encoding]::ASCII.GetString($bytes, 12, 4)
    $audioFormat = [BitConverter]::ToUInt16($bytes, 20)
    $channels = [BitConverter]::ToUInt16($bytes, 22)
    $rate = [BitConverter]::ToUInt32($bytes, 24)
    $byteRate = [BitConverter]::ToUInt32($bytes, 28)
    $blockAlign = [BitConverter]::ToUInt16($bytes, 32)
    $bits = [BitConverter]::ToUInt16($bytes, 34)
    Pass 'the fmt chunk is where a WAV needs it' ($fmt -eq 'fmt ') $fmt
    Pass 'the audio is uncompressed PCM' ($audioFormat -eq 1) "format $audioFormat"
    Pass 'the sample rate is a real audio rate' ($rate -ge 8000 -and $rate -le 384000) "$rate Hz"
    Pass 'the channel count is sane' ($channels -ge 1 -and $channels -le 8) "$channels ch"
    Pass 'the bit depth is 16 or 24' ($bits -eq 16 -or $bits -eq 24) "$bits bit"

    # Walk the chunks to find "data" (the writer may pad or add a LIST chunk).
    $offset = 12
    $dataOffset = -1
    $dataSize = 0
    while ($offset + 8 -le $bytes.Length) {
      $id = [System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
      $size = [BitConverter]::ToUInt32($bytes, $offset + 4)
      if ($id -eq 'data') { $dataOffset = $offset + 8; $dataSize = [int64]$size; break }
      $offset += 8 + [int64]$size + ([int64]$size % 2)
    }
    Pass 'the data chunk was found' ($dataOffset -gt 0) "scanned to offset $offset"
    if ($dataOffset -gt 0) {
      $seconds = $dataSize / [double]$byteRate
      Pass 'the recording is about as long as the run' ($seconds -gt ($RecordMs / 1000.0) * 0.6 -and $seconds -lt ($RecordMs / 1000.0) * 2.0) ("{0:N2} s, expected about {1:N2} s" -f $seconds, ($RecordMs / 1000.0))
      Pass 'the data size is consistent with the header' ($dataSize -eq ($bytes.Length - $dataOffset)) "data $dataSize, file holds $($bytes.Length - $dataOffset)"

      # Peak and zero-crossing frequency on one channel, from the middle of the take.
      $windowSeconds = 0.5
      $windowBytes = [int]([math]::Min([int64]($windowSeconds * $byteRate), [int64]($dataSize / 2)))
      $windowBytes = [int]($windowBytes - ($windowBytes % $blockAlign))
      $start = $dataOffset + [int]([math]::Max(0, ($dataSize - $windowBytes) / 2))
      $start = $start - ($start % $blockAlign)
      $peak = 0.0
      $crossings = 0
      $previous = 0.0
      $samples = 0
      for ($i = $start; $i + $blockAlign -le $start + $windowBytes; $i += $blockAlign) {
        $v = [BitConverter]::ToInt16($bytes, $i) / 32768.0
        if ([math]::Abs($v) -gt $peak) { $peak = [math]::Abs($v) }
        if ($samples -gt 0 -and (($previous -lt 0 -and $v -ge 0) -or ($previous -ge 0 -and $v -lt 0))) { $crossings += 1 }
        $previous = $v
        $samples += 1
      }
      $measuredHz = $crossings / 2.0 / $windowSeconds
      Pass 'the file is not silence' ($peak -gt 0.01) ("peak {0:N4} of full scale" -f $peak)
      Pass 'the 440 Hz test tone is in the file' ($measuredHz -gt 430 -and $measuredHz -lt 450) ("measured {0:N1} Hz from {1} zero crossings" -f $measuredHz, $crossings)
      Say ("  measured: {0:N1} Hz, peak {1:N3}, {2:N2} s, {3} Hz {4} ch {5}-bit" -f $measuredHz, $peak, $seconds, $rate, $channels, $bits)
    }
  }

  Say ''
  $line = '{0} passed, {1} failed' -f $passes.Count, $failures.Count
  Say $line
  if ($failures.Count -gt 0) {
    Say 'failures:'
    foreach ($f in $failures) { Say "  - $f" }
  }
  if ($Keep) { Say "kept: $RunDir" }
}
catch {
  Say ''
  Say ('RUN ABORTED: ' + $_.Exception.Message)
  Say ($_.ScriptStackTrace)
  $failures.Add('the run aborted: ' + $_.Exception.Message)
}
finally {
  if ($braveProcess) {
    & taskkill /PID $braveProcess.Id /T /F 2>&1 | Out-Null
  }
  if ($serverJob) {
    Stop-Job $serverJob -ErrorAction SilentlyContinue
    Remove-Job $serverJob -Force -ErrorAction SilentlyContinue
  }
  if (-not $Keep) {
    Start-Sleep -Milliseconds 500
    Remove-Item -Recurse -Force $RunDir -ErrorAction SilentlyContinue
  }
  if ($failures.Count -gt 0) { exit 1 } else { exit 0 }
}
