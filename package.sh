#!/usr/bin/env sh
# Build a distribution zip of the Suno WAV Recorder extension.
# Zips everything in this folder except .git, dist, existing zips and OS junk.
#
# Uses `zip` when it exists. When it does not (WSL on Windows, or a bare Git Bash
# without zip), it stages a copy of the folder and hands it to Windows
# PowerShell's Compress-Archive, so the same archive comes out on a machine with
# no zip binary. Staging matters: PowerShell cannot read this script while the
# shell is still executing it.
set -eu

cd "$(dirname "$0")"

NAME="suno-wav-recorder"
STAMP="$(date +%Y%m%d-%H%M)"
OUT="dist/${NAME}-${STAMP}.zip"
PS_HELPER="dist/.package.ps1"
STAGE="dist/.stage"

if [ ! -f manifest.json ]; then
  printf '%s\n' "manifest.json not found in $(pwd); run this from the extension folder." >&2
  exit 1
fi

mkdir -p dist
rm -f "$OUT"
rm -rf "$STAGE"
trap 'rm -rf "$STAGE"; rm -f "$PS_HELPER"' EXIT INT TERM

zip_with_zip() {
  zip -r -X "$OUT" . \
    -x '.git' -x '.git/*' \
    -x 'dist' -x 'dist/*' \
    -x '*.zip' \
    -x '.DS_Store' \
    -x 'Thumbs.db' \
    -x 'desktop.ini' \
    -x '.vscode/*' \
    -x '.idea/*'
}

# $1 is the PowerShell executable to drive (powershell.exe from WSL, or pwsh).
zip_with_powershell() {
  pws="$1"

  # Windows PowerShell needs a Windows path; without wslpath this is not WSL.
  if ! command -v wslpath >/dev/null 2>&1; then
    printf '%s\n' "zip is missing and this is not WSL, so Windows paths cannot be built." >&2
    printf '%s\n' "Install zip (apt install zip, brew install zip) and run this again." >&2
    exit 1
  fi

  # Stage the payload, minus .git, dist, zips and OS junk.
  mkdir -p "$STAGE"
  for entry in * .[!.]*; do
    [ -e "$entry" ] || continue
    case "$entry" in
      .|..|.git|dist|*.zip|.DS_Store|Thumbs.db|desktop.ini|.vscode|.idea) continue ;;
    esac
    cp -R "$entry" "$STAGE/"
  done

  if [ -z "$(ls -A "$STAGE")" ]; then
    printf '%s\n' "Nothing to package in $(pwd)." >&2
    exit 1
  fi

  stage_win="$(wslpath -w "$STAGE")"
  out_win="$(wslpath -w "$OUT")"
  helper_win="$(wslpath -w "$PS_HELPER")"

  cat > "$PS_HELPER" <<'PSEOF'
param([Parameter(Mandatory=$true)][string]$Src, [Parameter(Mandatory=$true)][string]$Out)
$ErrorActionPreference = 'Stop'
$items = Get-ChildItem -LiteralPath $Src -Force
if (-not $items) { throw "nothing to package in $Src" }
Compress-Archive -Path $items.FullName -DestinationPath $Out -Force
PSEOF

  # -ExecutionPolicy Bypass keeps this working on a locked-down machine.
  "$pws" -NoProfile -ExecutionPolicy Bypass -File "$helper_win" -Src "$stage_win" -Out "$out_win"
  rm -rf "$STAGE"
  rm -f "$PS_HELPER"
}

if command -v zip >/dev/null 2>&1; then
  zip_with_zip
else
  PWSH=""
  if command -v powershell.exe >/dev/null 2>&1; then
    PWSH="powershell.exe"
  elif command -v pwsh >/dev/null 2>&1; then
    PWSH="pwsh"
  fi

  if [ -z "$PWSH" ]; then
    printf '%s\n' "Neither zip nor PowerShell is available on this machine." >&2
    printf '%s\n' "Install zip (apt install zip, brew install zip) and run this again." >&2
    exit 1
  fi

  printf '%s\n' "zip not found; packaging with $PWSH (Compress-Archive)." >&2
  zip_with_powershell "$PWSH"
fi

if [ ! -s "$OUT" ]; then
  printf '%s\n' "Packaging produced no archive at $OUT" >&2
  exit 1
fi

printf '\n%s\n' "Wrote $OUT"
ls -lh "$OUT" 2>/dev/null || true
