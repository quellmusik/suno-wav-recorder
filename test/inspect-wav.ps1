# Reads a WAV file's 44-byte RIFF/WAVE header straight off disk and prints every field,
# then checks the arithmetic a player checks. This is the outside-the-browser proof that
# the encoder wrote a header a player will accept, using nothing but the file itself.
#
#   powershell -ExecutionPolicy Bypass -File test/inspect-wav.ps1 test/out/wav-encoder-test-440hz.wav
#
# Exit code 0 when every field is consistent, 1 when any check fails.

param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Path,
  # A whole second of 440 Hz at 0.8 full scale has 880 zero crossings; pass 0 to skip.
  [double]$ExpectedHz = 0
)

$ErrorActionPreference = 'Stop'
$file = (Resolve-Path -LiteralPath $Path).Path
$bytes = [System.IO.File]::ReadAllBytes($file)
$failures = New-Object System.Collections.Generic.List[string]

function U16([int]$offset) { return [System.BitConverter]::ToUInt16($bytes, $offset) }
function U32([int]$offset) { return [System.BitConverter]::ToUInt32($bytes, $offset) }
function Ascii([int]$offset, [int]$length) { return [System.Text.Encoding]::ASCII.GetString($bytes, $offset, $length) }

Write-Host "file      : $file"
Write-Host "size      : $($bytes.Length) bytes"
Write-Host ''

if ($bytes.Length -lt 44) {
  Write-Host 'FAIL: shorter than a 44-byte header'
  exit 1
}

$riffId     = Ascii 0 4
$riffSize   = U32 4
$waveId     = Ascii 8 4
$fmtId      = Ascii 12 4
$fmtSize    = U32 16
$audioFmt   = U16 20
$channels   = U16 22
$sampleRate = U32 24
$byteRate   = U32 28
$blockAlign = U16 32
$bits       = U16 34
$dataId     = Ascii 36 4
$dataSize   = U32 40

$rows = @(
  @{ Field = 'ChunkID';        Offset = '0';  Bytes = '4'; Value = $riffId },
  @{ Field = 'ChunkSize';      Offset = '4';  Bytes = '4'; Value = $riffSize },
  @{ Field = 'Format';         Offset = '8';  Bytes = '4'; Value = $waveId },
  @{ Field = 'Subchunk1ID';    Offset = '12'; Bytes = '4'; Value = $fmtId },
  @{ Field = 'Subchunk1Size';  Offset = '16'; Bytes = '4'; Value = $fmtSize },
  @{ Field = 'AudioFormat';    Offset = '20'; Bytes = '2'; Value = $audioFmt },
  @{ Field = 'NumChannels';    Offset = '22'; Bytes = '2'; Value = $channels },
  @{ Field = 'SampleRate';     Offset = '24'; Bytes = '4'; Value = $sampleRate },
  @{ Field = 'ByteRate';       Offset = '28'; Bytes = '4'; Value = $byteRate },
  @{ Field = 'BlockAlign';     Offset = '32'; Bytes = '2'; Value = $blockAlign },
  @{ Field = 'BitsPerSample';  Offset = '34'; Bytes = '2'; Value = $bits },
  @{ Field = 'Subchunk2ID';    Offset = '36'; Bytes = '4'; Value = $dataId },
  @{ Field = 'Subchunk2Size';  Offset = '40'; Bytes = '4'; Value = $dataSize }
)
$rows | Format-Table -AutoSize | Out-String -Width 120 | Write-Host

# Every check a player (or a strict decoder) makes before it will touch the samples.
if ($riffId -ne 'RIFF') { $failures.Add("ChunkID is '$riffId', not 'RIFF'") }
if ($waveId -ne 'WAVE') { $failures.Add("Format is '$waveId', not 'WAVE'") }
if ($fmtId -ne 'fmt ')  { $failures.Add("Subchunk1ID is '$fmtId', not 'fmt '") }
if ($dataId -ne 'data') { $failures.Add("Subchunk2ID is '$dataId', not 'data'") }
if ($fmtSize -ne 16)    { $failures.Add("Subchunk1Size is $fmtSize, not 16") }
if ($audioFmt -ne 1)    { $failures.Add("AudioFormat is $audioFmt, not 1 (PCM)") }
if ($channels -lt 1 -or $channels -gt 8) { $failures.Add("NumChannels is $channels") }
if ($sampleRate -lt 8000) { $failures.Add("SampleRate is $sampleRate") }
if ($blockAlign -ne ($channels * ($bits / 8))) { $failures.Add("BlockAlign $blockAlign != $channels channels at $bits bits") }
if ($byteRate -ne ($sampleRate * $blockAlign)) { $failures.Add("ByteRate $byteRate != SampleRate $sampleRate * BlockAlign $blockAlign") }
if ($bits -ne 16 -and $bits -ne 24) { $failures.Add("BitsPerSample is $bits, not 16 or 24") }
if (($riffSize + 8) -ne $bytes.Length) { $failures.Add("ChunkSize+8 = $($riffSize + 8) != file size $($bytes.Length)") }
if (($dataSize + 44) -ne $bytes.Length) { $failures.Add("Subchunk2Size+44 = $($dataSize + 44) != file size $($bytes.Length)") }
if (($dataSize % $blockAlign) -ne 0) { $failures.Add("Subchunk2Size $dataSize is not a whole number of $blockAlign-byte frames") }

$frames = if ($blockAlign -gt 0) { [math]::Floor($dataSize / $blockAlign) } else { 0 }
$seconds = if ($sampleRate -gt 0) { $frames / $sampleRate } else { 0 }
Write-Host ("samples   : {0} frames, {1:N3} s at {2} Hz, {3} ch, {4}-bit" -f $frames, $seconds, $sampleRate, $channels, $bits)

if ($ExpectedHz -gt 0 -and $frames -gt 0) {
  # Zero crossings on channel 0, read the way a player reads it: little-endian signed PCM.
  $crossings = 0
  $previous = 0
  for ($i = 0; $i -lt $frames; $i++) {
    $offset = 44 + $i * $blockAlign
    if ($bits -eq 16) {
      $value = [System.BitConverter]::ToInt16($bytes, $offset)
    } else {
      $raw = $bytes[$offset] -bor ($bytes[$offset + 1] -shl 8) -bor ($bytes[$offset + 2] -shl 16)
      if ($raw -band 0x800000) { $raw -= 0x1000000 }
      $value = $raw
    }
    if (($previous -lt 0 -and $value -ge 0) -or ($previous -ge 0 -and $value -lt 0)) { $crossings++ }
    $previous = $value
  }
  $expected = 2 * $ExpectedHz * $seconds
  Write-Host ("tone      : {0} zero crossings on channel 0, expected ~{1:N0} for {2} Hz" -f $crossings, $expected, $ExpectedHz)
  if ([math]::Abs($crossings - $expected) -gt 4) { $failures.Add("zero crossings $crossings do not match $ExpectedHz Hz") }
}

# Peak on channel 0, as dBFS.
$peak = 0
for ($i = 0; $i -lt $frames; $i++) {
  $offset = 44 + $i * $blockAlign
  $value = [System.BitConverter]::ToInt16($bytes, $offset)
  $magnitude = [math]::Abs($value)
  if ($magnitude -gt $peak) { $peak = $magnitude }
}
if ($peak -gt 0 -and $bits -eq 16) {
  $dbfs = 20 * [math]::Log10($peak / 32768.0)
  Write-Host ("peak      : {0} / 32768 = {1:N2} dBFS" -f $peak, $dbfs)
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host 'PASS: every header field is consistent with the file it describes.'
  exit 0
}
foreach ($f in $failures) { Write-Host "FAIL: $f" }
exit 1
