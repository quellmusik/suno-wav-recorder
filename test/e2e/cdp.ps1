<#
.SYNOPSIS
  Send one DevTools-protocol command to a Brave that was started with --remote-debugging-port.

.DESCRIPTION
  The end-to-end run drives itself from inside the browser, so this is the window into it while
  it runs: read a harness page's text, pull a value out of a page, or set a browser-wide
  preference such as Browser.setDownloadBehavior. With -Target browser it talks to the browser
  endpoint instead of one page.

  For runs started by drive.ps1 only, never for the user's own Brave.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File test/e2e/cdp.ps1 -Target e2e-harness -Expression "document.title"
  powershell -ExecutionPolicy Bypass -File test/e2e/cdp.ps1 -Target browser -Method Browser.setDownloadBehavior -Params '{"behavior":"allow","downloadPath":"C:\\tmp\\dl"}'
#>
[CmdletBinding()]
param(
  [int]$Port = 9333,
  [string]$Target = 'e2e-harness',
  [string]$Method = '',
  [string]$Params = '{}',
  [string]$Expression = 'document.body.innerText',
  [int]$TimeoutMs = 20000
)

$ErrorActionPreference = 'Stop'

function ConvertTo-Utf8($text) { [System.Text.Encoding]::UTF8.GetBytes($text) }

if ($Target -eq 'browser') {
  $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
  $wsUrl = $version.webSocketDebuggerUrl
} else {
  $targets = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 5
  $match = @($targets) | Where-Object { $_.url -like "*$Target*" -or $_.type -eq $Target } | Select-Object -First 1
  if (-not $match) {
    Write-Output "no target matching '$Target'. targets:"
    foreach ($t in @($targets)) { Write-Output ("  {0}  {1}" -f $t.type, $t.url) }
    exit 2
  }
  $wsUrl = $match.webSocketDebuggerUrl
}

if (-not $Method) {
  $Method = 'Runtime.evaluate'
  $request = @{ id = 1; method = $Method; params = @{ expression = $Expression; returnByValue = $true; awaitPromise = $true } }
} else {
  $request = @{ id = 1; method = $Method; params = ($Params | ConvertFrom-Json) }
}

$token = [System.Threading.CancellationToken]::None
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([uri]$wsUrl, $token).Wait($TimeoutMs)

$json = $request | ConvertTo-Json -Depth 12 -Compress
$bytes = ConvertTo-Utf8 $json
$ws.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $token).Wait($TimeoutMs)

$buffer = New-Object byte[] 4194304
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$reply = $null
while ((Get-Date) -lt $deadline) {
  $stream = New-Object System.IO.MemoryStream
  $more = $true
  while ($more) {
    $segment = [System.ArraySegment[byte]]::new($buffer)
    $task = $ws.ReceiveAsync($segment, $token)
    if (-not $task.Wait(5000)) { $more = $false; break }
    $frame = $task.Result
    $stream.Write($buffer, 0, $frame.Count)
    $more = -not $frame.EndOfMessage
  }
  $text = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
  $stream.Dispose()
  if (-not $text) { continue }
  try { $parsed = $text | ConvertFrom-Json } catch { continue }
  if ($parsed.id -eq 1) { $reply = $parsed; break }
}
$ws.Dispose()

if (-not $reply) { Write-Output 'no reply from the browser'; exit 3 }
if ($reply.error) { Write-Output ('CDP ERROR: ' + ($reply.error | ConvertTo-Json -Compress)); exit 4 }
if ($reply.result.PSObject.Properties.Name -contains 'exceptionDetails' -and $reply.result.exceptionDetails) {
  Write-Output ('EXCEPTION: ' + $reply.result.exceptionDetails.text)
  Write-Output ($reply.result.exceptionDetails.exception.description)
  exit 5
}
if ($reply.result.PSObject.Properties.Name -contains 'result') {
  $value = $reply.result.result.value
  if ($null -eq $value) { Write-Output '(no value)'; exit 0 }
  Write-Output $value
} else {
  Write-Output ($reply.result | ConvertTo-Json -Depth 8 -Compress)
}
