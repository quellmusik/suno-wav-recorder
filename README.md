# Suno WAV Recorder

A Manifest V3 browser extension for **Brave on Windows** that records the audio playing in a
Suno tab and saves it as a WAV file.

It captures the tab's own audio output through `chrome.tabCapture`, keeps the audio in a hidden
offscreen document, and writes PCM WAV bytes to your Downloads folder with `chrome.downloads`.
No audio ever leaves your machine: there is no server, no account, and no network request other
than the Suno tab you are already on.

---

## Install on Windows / Brave

The whole path in one line: **`brave://extensions` > Developer mode > Load unpacked > select the
extension folder.** In steps:

1. Open Brave and go to `brave://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner of the page).
3. Click **Load unpacked**.
4. Select the extension folder (the folder containing `manifest.json`).
5. The **Suno WAV Recorder** card appears in the list. Click the puzzle-piece icon in the toolbar
   and pin **Suno WAV Recorder** so its icon is always visible.

### If the toolbar icon is missing

If the toolbar icon is hidden behind the puzzle-piece (extensions) menu, **relaunch Brave** and
click the puzzle-piece icon again to pin it. A fully quit and restart of Brave is what makes a
freshly loaded unpacked extension appear in the toolbar consistently; a reload of
`brave://extensions` alone is not always enough.

### Recording requires the Suno tab to be focused

**Recording requires the Suno tab to be the focused tab at start.** `tabCapture` only grants a
stream for the tab you just invoked the extension on, so the Suno tab must be the active, focused
tab in its window when you press Start. If you switch tabs or minimize the window before the
stream is created, the capture fails. Once recording has started you can leave the tab alone but
must not close it.

---

## Use it

1. Open a song on [suno.com](https://suno.com) and let the page finish loading.
2. Click the **Suno WAV Recorder** toolbar icon while that tab is focused.
3. Press **Start recording** in the popup, then start the song from the beginning.
4. Press **Stop** when the song ends. The WAV file is saved to your Downloads folder.

Keep the song playing for the whole take. The recorder taps the tab's audio output, so pausing
playback leaves silence in the file even though the capture keeps running.

---

## What the WAV contains

The recording is standard PCM WAV, written by `lib/wav-encoder.js` (see that module for the exact
bit depth and channel count it emits). Suno streams lossy audio; `tabCapture` hands the extension
the tab's decoded output, so the WAV holds a lossless copy of what the tab was playing at the
browser's output sample rate. It is not a recovery of Suno's original master, and it cannot be
better than the stream Suno served.

---

## Permissions, and why each one is needed

| Permission | Why |
| --- | --- |
| `tabCapture` | Gets the audio stream of the Suno tab. |
| `offscreen` | Holds the Web Audio graph and the WAV encoder, because a service worker has no Web Audio or DOM. |
| `downloads` | Saves the finished `.wav` to your Downloads folder. |
| `storage` | Keeps recorder state (level, elapsed time, last file name) between popup opens. |
| `activeTab` | Lets the extension act on the tab you clicked from without broad tab access. |
| `scripting` | Injects the page controls into Suno tabs. |
| `host_permissions` `https://suno.com/*`, `https://*.suno.com/*` | Matches the content script to Suno pages only. |

No permission is requested for any other site.

---

## File map

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, action popup, service worker, content scripts, icons. |
| `background.js` | Service worker. Opens the offscreen document, owns capture start/stop, triggers the download. |
| `lib/messages.js` | Shared message names and payload shapes between the three contexts. |
| `offscreen.html` / `offscreen.js` | Hidden document: `getUserMedia` on the tab stream, Web Audio graph, level metering. |
| `lib/wav-encoder.js` | Converts captured PCM chunks into a WAV file. |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup: Start, Stop, elapsed time, level meter. |
| `content.js` / `content.css` | In-page controls and track info on Suno. |
| `icons/icon16.png`, `icon48.png`, `icon128.png` | Toolbar, extensions page and store art. |
| `README.md` | This file. |
| `package.sh` | Builds a distribution zip. |

---

## Packaging for distribution

From the extension folder, in any POSIX shell (WSL, Git Bash, macOS, Linux):

```sh
sh package.sh
```

That writes `dist/suno-wav-recorder-<timestamp>.zip`: the whole folder except `.git`, `dist`,
existing `.zip` files and OS junk, with `manifest.json` at the archive root so it unzips straight
into a loadable extension folder.

`package.sh` uses `zip` when it is installed. When it is not, and the shell is WSL or Git Bash, it
falls back to Windows PowerShell's `Compress-Archive` (`powershell.exe`, or `pwsh` when present) and
produces the same archive. On this machine `zip` is not installed inside WSL, so the run that
validated this file used that PowerShell fallback; it wrote a 29-entry zip with `manifest.json` at
the root. Only when neither tool exists does the script stop, and then it says so:

```
Neither zip nor PowerShell is available on this machine.
```

In that case install zip once (`wsl sudo apt install zip`), or zip the folder by hand and delete
`dist`, `.git` and any old `.zip` from the copy before shipping it.

The zip is for sharing. Brave itself loads the unpacked folder: either this folder, or the folder
you get after unzipping a copy.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "No active tab" or capture fails at Start | Click the extension icon while the Suno tab is focused, and do not switch tabs before the stream is created. |
| Icon not in the toolbar | Puzzle-piece icon > pin it. If it is not listed, relaunch Brave. |
| Start records silence | Make sure the song is actually playing, the tab is not muted, and no other extension holds a tab capture of the same tab. |
| Download does not appear | Check `brave://downloads` for a blocked download; Brave may ask once before allowing extension-initiated saves. |
| "Extension context invalidated" after editing a file | Click reload on the extension card at `brave://extensions`, then reload the Suno tab. |
| Popup shows stale state after a reload | Close and reopen the popup; state is re-read from `chrome.storage.session`. |

Reload the extension at `brave://extensions` after any code change; the popup and content script
also need the Suno tab refreshed.

---

## Requirements

- Brave on Windows (or any Chromium browser 116+; the service worker hands the tab stream id to
  the offscreen document, which Chromium has supported since 116).
- The `minimum_chrome_version` in `manifest.json` enforces that floor.

### What was verified on this machine

Brave **156.1.98.63** (Chromium 156) was started against a throwaway profile with
`--load-extension="<this folder>"` and a remote debugging port. The browser listed the extension's
Manifest V3 service worker as a live target (`service_worker
chrome-extension://<id>/background.js`), with no "Failed to load extension" or manifest error in
the log. That proves Brave accepts this `manifest.json`, resolves every file it names, and starts
`background.js` as a module worker. It does not prove the audio path end to end: capturing a real
song needs a signed-in Suno tab playing audio, which is what the manual steps below are for.

## Version

1.0.0 — initial release.
