# Serves the extension folder over http://127.0.0.1:<port>/ so a browser can load the
# module test page. ES modules will not load from file:// (opaque origin), and the test
# page imports ../lib/wav-encoder.js, so it needs a real origin.
#
#   powershell -ExecutionPolicy Bypass -File test/serve.ps1            # port 8787
#   powershell -ExecutionPolicy Bypass -File test/serve.ps1 -Port 9000 # another port
#
# Then open http://127.0.0.1:8787/test/wav-encoder.test.html
# Stop it with Ctrl+C.

param(
  [int]$Port = 8787,
  [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

$ErrorActionPreference = 'Stop'

# The script lives in <root>\test, so the extension root is one level up from it.
if (-not $Root -or -not (Test-Path (Join-Path $Root 'lib\wav-encoder.js'))) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = (Resolve-Path $Root).Path

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.wav'  = 'audio/wav'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
}

$listener = [System.Net.HttpListener]::new()
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "serving $Root at $prefix (Ctrl+C to stop)"

# POST /save/<name> writes the body to test/out/<name>, so a browser can hand the bytes it
# just encoded back to the shell that checks them.
$outDir = Join-Path $Root 'test\out'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
  } catch {
    break
  }
  $response = $context.Response
  try {
    $relative = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/')
    if ($context.Request.HttpMethod -eq 'POST' -and $relative.StartsWith('save/')) {
      $name = [System.IO.Path]::GetFileName($relative.Substring(5))
      if ([string]::IsNullOrWhiteSpace($name)) { $name = 'upload.bin' }
      $target = Join-Path $outDir $name
      $buffer = New-Object byte[] $context.Request.ContentLength64
      $read = 0
      while ($read -lt $buffer.Length) {
        $chunk = $context.Request.InputStream.Read($buffer, $read, $buffer.Length - $read)
        if ($chunk -le 0) { break }
        $read += $chunk
      }
      [System.IO.File]::WriteAllBytes($target, $buffer)
      $body = [System.Text.Encoding]::UTF8.GetBytes("saved $read bytes to test/out/$name")
      $response.StatusCode = 200
      $response.ContentType = 'text/plain; charset=utf-8'
      $response.OutputStream.Write($body, 0, $body.Length)
      continue
    }
    if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'test/wav-encoder.test.html' }
    $path = Join-Path $Root $relative
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
      $response.StatusCode = 404
      $body = [System.Text.Encoding]::UTF8.GetBytes("not found: $relative")
      $response.OutputStream.Write($body, 0, $body.Length)
    } else {
      $extension = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $response.ContentType = if ($types.ContainsKey($extension)) { $types[$extension] } else { 'application/octet-stream' }
      $response.Headers.Add('Cache-Control', 'no-store')
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    try { $response.StatusCode = 500 } catch { }
  } finally {
    $response.OutputStream.Close()
  }
}
