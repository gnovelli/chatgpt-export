# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Changelog

### Unreleased
_(add entries here as work progresses)_

### 2026-05-21
- **`e9eb53c`** — Filename date range now includes time (`YYYYMMDD-HHmmss`) for both first and last conversation, not just date
- **`a0d6987`** — Attachment count shown in popup stats panel before download phase begins
- **`8ea1993`** — Detailed per-file logging during attachment download (HTTP status, content-type, error reason) to aid debugging
- **`4a26b12`** — Fix corrupt ZIP: central directory entry had 10–11 zero bytes instead of the required 12, shifting the local-header offset field and making the file unopenable
- **`d4845a0`** — When "Download file attachments" checkbox is active, always produce a `.zip` even if no attachments were detected (previously fell back to `.json` silently)
- **`821f14a`** — Bundle JSON + all attachments into a single ZIP instead of triggering one download per file (browsers block multiple automatic downloads); pure-JS ZIP builder with no external dependencies
- **`ed8a647`** — Fix `create_time` handling: field can be Unix timestamp (float) or ISO 8601 string depending on account type; add `toUnixTime()` helper used in sort, `formatConvDate`, `safeISODate`. Add audio attachment detection for `sediment://` asset pointers (TTS/voice output) and `real_time_user_audio_video_asset_pointer` parts (voice user input)
- **`3676121`** — Fix false "Error" shown at export start: `chrome.tabs.sendMessage` response callback fires with `lastError = "message port closed"` when content script doesn't call `sendResponse`; ignore that specific error, only surface real connection failures
- **`baa9fd2`** — Fix `Invalid time value` exception: conversations with fetch errors have no `create_time`; `safeISODate()` and `formatConvDate()` now return `null`/`"unknown"` instead of throwing
- **`08ed33f`** — Fix `totalCount is not defined`: variable was renamed `serverTotal` in the listing section but stale references remained in export-building and summary code; also fix `toIdx` (now relative) used in absolute comparisons via `absTo = toIdx + approxStart`
- **`70425ba`** — Partial export with smart pagination: range inputs (from/to, oldest-first), fetch only the API pages overlapping the range (2 pages instead of 8 for a batch of 100 out of 800), persistent history tracking in `chrome.storage.local` / `localStorage`, "Continue from next batch" shortcut, filename encodes export timestamp + first/last conversation datetime, fix missing `storage`+`tabs` manifest permissions

### 2026-05-20 — Initial release (`03841a6`)
- Bulk export all ChatGPT conversations including Team/Business workspaces
- Three delivery formats: browser console script, Chrome extension (MV3), macOS SwiftUI app
- Handles rate limiting with exponential backoff
- Detects file attachments via `metadata.attachments` and `file-service://` asset pointers
- Archived conversations support

## What this project is

A ChatGPT bulk conversation exporter with three delivery formats, all sharing the same core export algorithm:

1. **Browser console script** (`scripts/export.js`) — paste into DevTools console, runs immediately
2. **Chrome extension** (`extension/`) — Manifest V3, adds a UI with progress bar and options
3. **macOS native app** (`macos-app/`) — SwiftUI app embedding a WKWebView of chatgpt.com

## Running / building

**Browser script**: No build step. Copy `scripts/export.js` into a browser console on chatgpt.com.

**Chrome extension** (dev mode):
1. Open `chrome://extensions/`
2. Enable Developer mode
3. Load unpacked → select the `extension/` subfolder (not the repo root)
4. After any code change: reload the extension AND refresh the chatgpt.com tab

**macOS app**: Open `macos-app/ChatGPTExport.xcodeproj` in Xcode and run. Requires macOS 13+. The export JS is bundled as `macos-app/ChatGPTExport/Resources/export-webview.js` — Xcode includes it at build time.

To regenerate icon assets: `python3 generate-assets.py` (requires Pillow) or `bash macos-app/generate-icons.sh` (requires Inkscape/rsvg-convert).

## Architecture: three variants of the same script

The export algorithm is implemented three times with minor adaptations:

| File | Communication channel | Output |
|------|----------------------|--------|
| `scripts/export.js` | `console.log()` | `.zip` (or `.json` if no attachments) via `<a>` click |
| `extension/content.js` | `chrome.runtime.sendMessage()` | `.zip` (or `.json`) via `<a>` click |
| `macos-app/.../export-webview.js` | `webkit.messageHandlers.<name>.postMessage()` | Sends JSON string to Swift; Swift uses `NSSavePanel` |

**Rule**: when changing export behavior, update all three files unless the change is platform-specific.

## Export flow (per variant)

1. **Auth**: fetch `/api/auth/session` → `accessToken`; read `_account` cookie for workspace
2. **Smart listing**: fetch page 0 to get `total`, then fetch only the API pages that overlap with the requested range (see below). Sort results by `create_time` oldest-first.
3. **Range slice**: apply `[fromIndex, toIndex]` with `approxStart` offset correction
4. **Full content**: fetch `/backend-api/conversation/{id}` for each conversation in the slice; extract attachment references into `fileAttachments`
5. **Bundle**: build a `.zip` containing `export.json` + `attachments/*`; or plain `.json` if attachments checkbox is off

## Smart pagination

The ChatGPT API returns conversations **newest-first**. Our ordering is **oldest-first**. Key insight: oldest conversations sit at the **end** of the API pagination (high offsets). The first API response includes a `total` count, so we can jump straight to the relevant pages.

```
pageStart = floor((total - toIndex - PAGE_SIZE) / PAGE_SIZE) * PAGE_SIZE
pageEnd   = ceil((total - fromIndex + 1 + PAGE_SIZE) / PAGE_SIZE) * PAGE_SIZE
```

One extra `PAGE_SIZE` of buffer on each side absorbs ordering differences between `update_time` (API order) and `create_time` (our order). After fetching, sort by `create_time` and use `approxStart = max(0, total - pageEnd)` to map absolute positions to indices within the fetched subset.

`create_time` may be a Unix timestamp (float) or an ISO 8601 string depending on account type. Use `toUnixTime()` helper for both sorting and date formatting.

## Attachment detection

Two storage backends appear in conversation data:

| Prefix | Content type | Where found |
|--------|-------------|-------------|
| `file-service://` | Uploaded files (PDF, docx, images…) | `content.parts[].asset_pointer` |
| `sediment://` | Audio TTS / voice mode output | `content.parts[].asset_pointer` (content_type `audio_asset_pointer`) |
| `sediment://` | Voice mode user input | `content.parts[].audio_asset_pointer.asset_pointer` (content_type `real_time_user_audio_video_asset_pointer`) |
| — | Any uploaded file | `message.metadata.attachments[].id` |

All attachment IDs (with prefix stripped) are downloaded via `/backend-api/files/{id}/download`. That endpoint may return:
- **Binary directly** → read as `arrayBuffer()`
- **JSON with `download_url`** → fetch that URL, then read as `arrayBuffer()`

Audio files carry a `format` field (e.g. `"wav"`); the filename is `{id}.{format}`.

## ZIP builder

`makeZip(entries)` in `content.js` and `scripts/export.js` is a pure-JS implementation of ZIP STORE (no compression), no external dependencies. Each record is built with explicit labeled sections (`u16`/`u32` little-endian helpers, `Z2`/`Z4` zero constants) to keep byte counts verifiable:

- Local file header: **30 bytes** + filename
- Central directory entry: **46 bytes** + filename
- End of central directory: **22 bytes**

Validated with Python's `zipfile` module. When modifying, re-run the validation:

```python
python3 -c "
import zipfile, io, zlib, time

def make_zip_test(): ...  # replicate the JS logic
zf = zipfile.ZipFile(io.BytesIO(make_zip_test()))
print(zf.namelist())  # must list all entries without error
"
```

## Partial export & history tracking

- **Range inputs** (1-based, oldest-first): `fromIndex` / `toIndex` in popup; `EXPORT_FROM` / `EXPORT_TO` constants in console script
- **Tracking**: exported conversation IDs stored in `chrome.storage.local` (extension) or `localStorage` (console script) under key `chatgptExportHistory`
- **Resume**: popup shows "X already exported" banner with "Continue from next batch" button that pre-fills the next `fromIndex`/`toIndex`
- **Output filename**: `chatgpt-export-YYYYMMDD-HHmmss--YYYYMMDD-to-YYYYMMDD.{zip|json}` where the date range is the `create_time` of the first and last conversation in the batch

## Chrome extension internals

- `manifest.json` — Manifest V3, permissions: `activeTab`, `cookies`, `storage`, `tabs`; host: `https://chatgpt.com/*`
- `content.js` — injected at `document_idle`; listens for `startExport`, sends back: `export-log`, `export-status`, `export-progress`, `export-stats`, `export-ids`, `export-done`, `export-error`
- `popup/popup.js` — sends `startExport` via `chrome.tabs.sendMessage`; reads/writes history via `chrome.storage.local`; the `sendMessage` response callback only treats `"Receiving end does not exist"` as a real error — `"message port closed"` is ignored (content script doesn't call `sendResponse`)

## macOS app internals

- `ExportState` — `@MainActor ObservableObject` holding all UI state (`ExportPhase` enum, counts, log messages, raw JSON string, `suggestedFilename`)
- `ExportManager` — injects `export-webview.js` into the `WKWebView`; uses `exportState.suggestedFilename` (sent from JS via `exportDone.suggestedFilename`) as the default name in `NSSavePanel`
- `ChatGPTWebView` — `NSViewRepresentable` wrapping `WKWebView`; `Coordinator` implements `WKScriptMessageHandler` to translate JS messages into `ExportState` mutations
- `ContentView` — `HSplitView`; watches `exportState.$exportData` to auto-trigger save dialog

## Key API endpoints

All requests use `credentials: 'include'` and `Authorization: Bearer <token>`. Workspace accounts also need `Chatgpt-Account-Id: <_account-cookie-value>`.

- `GET /api/auth/session` → `{ accessToken }`
- `GET /backend-api/conversations?offset=N&limit=100[&is_archived=true]` → `{ items, total, offset, limit }`
- `GET /backend-api/conversation/{id}` → full conversation with `mapping` tree
- `GET /backend-api/files/{id}/download` → binary or `{ download_url }` JSON

## Licensing

`scripts/` is MIT. `extension/` and `macos-app/` are source-available. See `LICENSE`, `extension/LICENSE`, `macos-app/LICENSE`.
