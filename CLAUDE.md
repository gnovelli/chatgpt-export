# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A ChatGPT bulk conversation exporter with three delivery formats, all sharing the same core export algorithm:

1. **Browser console script** (`scripts/export.js`) — paste into DevTools console, runs immediately
2. **Chrome extension** (`extension/`) — Manifest V3, adds a UI with progress bar and options
3. **macOS native app** (`macos-app/`) — SwiftUI app embedding a WKWebView of chatgpt.com

The core logic in all three: authenticate via `/api/auth/session`, detect workspace via `_account` cookie, paginate `/backend-api/conversations`, fetch each conversation, extract attachment references, download as JSON.

## Running / building

**Browser script**: No build step. Copy `scripts/export.js` into a browser console on chatgpt.com.

**Chrome extension** (dev mode):
1. Open `chrome://extensions/`
2. Enable Developer mode
3. Load unpacked → select the `extension/` folder

**macOS app**: Open `macos-app/ChatGPTExport.xcodeproj` in Xcode and run. Requires macOS 13+. The export JS is bundled as `macos-app/ChatGPTExport/Resources/export-webview.js` — Xcode includes it in the app bundle at build time.

To regenerate icon assets: `python3 generate-assets.py` (requires Pillow) or `bash macos-app/generate-icons.sh` (requires Inkscape/rsvg-convert).

## Architecture: three variants of the same script

The export algorithm is implemented three times with minor adaptations:

| File | Communication channel | Download mechanism |
|------|----------------------|-------------------|
| `scripts/export.js` | `console.log()` | `URL.createObjectURL` + `<a>` click |
| `extension/content.js` | `chrome.runtime.sendMessage()` | `URL.createObjectURL` + `<a>` click |
| `macos-app/.../export-webview.js` | `webkit.messageHandlers.<name>.postMessage()` | Sends JSON string to Swift via `exportData` handler; Swift uses `NSSavePanel` |

When changing export behavior, update all three unless the change is platform-specific.

## macOS app internals

- `ExportState` — `@MainActor ObservableObject` holding all UI state (`ExportPhase` enum, counts, log messages, the raw JSON string)
- `ExportManager` — injects `export-webview.js` into the `WKWebView` and handles the `NSSavePanel` save flow
- `ChatGPTWebView` — `NSViewRepresentable` wrapping `WKWebView`; its `Coordinator` implements `WKScriptMessageHandler` to translate JS `webkit.messageHandlers` calls into `ExportState` mutations
- `ContentView` — `HSplitView` with WebView on the left and `ExportSidebar` on the right; watches `exportState.$exportData` to auto-trigger the save dialog when export completes

Options (`includeArchived`, `includeAttachments`) are passed to the JS by injecting `window.__EXPORT_OPTIONS = {...}` as a preamble before the script runs.

## Chrome extension internals

- `manifest.json` — Manifest V3, permissions: `activeTab`, `cookies`; host permission: `https://chatgpt.com/*`
- `content.js` — injected into chatgpt.com pages; listens for `startExport` message from popup, runs export, sends typed messages back (`export-log`, `export-status`, `export-progress`, `export-stats`, `export-done`, `export-error`)
- `popup/popup.js` — sends `startExport` to content script via `chrome.tabs.sendMessage`; listens for progress messages via `chrome.runtime.onMessage`

## Key API endpoints

All accessed with `credentials: 'include'` (browser session) and `Authorization: Bearer <token>`:

- `GET /api/auth/session` → get `accessToken`
- `GET /backend-api/conversations?offset=N&limit=100` → paginated conversation list
- `GET /backend-api/conversations?offset=0&limit=100&is_archived=true` → archived conversations
- `GET /backend-api/conversation/{id}` → full conversation with `mapping` tree
- `GET /backend-api/files/{fileId}/download` → attachment download (may return redirect URL in JSON)

For workspace accounts, add header `Chatgpt-Account-Id: <value-from-_account-cookie>`.

## Licensing

`scripts/` is MIT. `extension/` and `macos-app/` are source-available (not open source). See `LICENSE`, `extension/LICENSE`, and `macos-app/LICENSE`.
