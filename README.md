# Tab Snoozer

Minimal Chrome extension + local helper app to snooze tabs and log events to a Markdown file.

## What it does
- Snooze active tab from extension popup.
- Reopen snoozed tabs when due.
- Append `Snoozed` / `Reopened` events to a local Markdown file.
- Queue helper events when helper is offline and retry automatically.

## Project structure
- `extension/`: Chrome extension (Manifest V3)
- `helper/`: local Node helper server
- `docs/`: manual test steps
- `PROJECT_PLAN.md`: implementation plan

## Prerequisites
- Chrome or Chromium browser
- Node.js 18+

## 1) Run local helper
By default helper writes to `~/TODO.md`.

```bash
cd /Users/rdewolff/Projects/tab-snoozer
TAB_SNOOZER_MD_PATH=~/TODO.md node helper/server.js
```

Optional env vars:
- `TAB_SNOOZER_MD_PATH`: markdown file path
- `TAB_SNOOZER_PORT`: helper port (default `17333`)

Health check:

```bash
curl http://127.0.0.1:17333/health
```

## 2) Load extension
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `/Users/rdewolff/Projects/tab-snoozer/extension`.

## 3) Use
1. Open any tab.
2. Click Tab Snoozer action icon.
3. Pick `30m`, `2h`, `Tomorrow 9AM`, or custom date/time.
4. Wait for due time; tab should reopen automatically.
5. Check markdown file for appended lines.

## Notes
- Reminder wake-up requires Chrome running; if closed, wake-up occurs after next startup/alarm tick.
- Helper runs only on localhost (`127.0.0.1`).
