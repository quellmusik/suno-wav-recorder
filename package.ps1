<#
.SYNOPSIS
  Zips this extension folder for handing to someone else.

.DESCRIPTION
  Writes dist/suno-wav-recorder-<version>-<kind>-<stamp>.zip with manifest.json at
  the archive root, so it unzips straight into a loadable extension folder.

  Default is the repository payload: the extension plus README, AGENTS.md,
  LICENSE, .gitignore, both packaging scripts and test/. That is the zip to hand
  to whoever publishes the repo, and `git add .` on it produces a clean tree.

  -ExtensionOnly leaves out docs and tests and ships only what the browser loads.

  Never shipped: dist/, test/out/ (both generated), node_modules/, .git/ and OS
  junk. This is the Windows port of package.sh; this machine has no POSIX shell.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File package.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File package.ps1 -ExtensionOnly
#>
[CmdletBinding()]
param(
  [switch]$ExtensionOnly
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found in $root; run this from the extension folder."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$kind = if ($ExtensionOnly) { 'extension' } else { 'github' }

$outDir = Join-Path $root 'dist'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$out = Join-Path $outDir "suno-wav-recorder-$version-$kind-$stamp.zip"
if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }

# What the browser actually loads.
$extensionPayload = @(
  'manifest.json',
  'background.js',
  'offscreen.html',
  'offscreen.js',
  'recorder-worklet.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'content.js',
  'content.css',
  'lib',
  'icons'
)

# What a repository needs on top of that.
$repoPayload = @(
  'README.md',
  'AGENTS.md',
  'LICENSE',
  '.gitignore',
  'package.sh',
  'package.ps1',
  'test'
)

$payload = if ($ExtensionOnly) { $extensionPayload } else { $extensionPayload + $repoPayload }

$stage = Join-Path $outDir '.stage'
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

try {
  foreach ($item in $payload) {
    $src = Join-Path $root $item
    if (-not (Test-Path -LiteralPath $src)) {
      Write-Warning "not found, skipped: $item"
      continue
    }
    Copy-Item -LiteralPath $src -Destination $stage -Recurse -Force
  }

  # Generated or machine-local, whatever the payload list copied along.
  foreach ($rel in @('dist', 'test\out', 'node_modules', '.git')) {
    $junk = Join-Path $stage $rel
    if (Test-Path -LiteralPath $junk) { Remove-Item -LiteralPath $junk -Recurse -Force }
  }

  $staged = Get-ChildItem -LiteralPath $stage -Force
  if (-not $staged) { throw "nothing to package in $root" }

  Compress-Archive -LiteralPath $staged.FullName -DestinationPath $out -CompressionLevel Optimal -Force
}
finally {
  if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

if (-not (Test-Path -LiteralPath $out)) { throw "packaging produced no archive at $out" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($out)
try {
  $entries = $zip.Entries | ForEach-Object { $_.FullName }
  $hasManifest = ($entries -contains 'manifest.json')
  $size = (Get-Item -LiteralPath $out).Length
}
finally {
  $zip.Dispose()
}

if (-not $hasManifest) { throw "manifest.json is not at the archive root of $out" }

Write-Host ''
Write-Host ("Wrote {0}" -f $out) -ForegroundColor Green
Write-Host ("  {0} entries, {1:N0} bytes, manifest.json at the root" -f $entries.Count, $size)
