# Tab Snoozer - Implementation Plan

## Objective
Build a minimal Chrome extension that lets you snooze the current tab, stores snoozed entries, appends events to a local Markdown file, and re-opens tabs when they are due.

## Principles
- Keep it simple and stupid.
- Prefer append-only logging over complex file edits.
- Avoid infrastructure unless it is required for reliability.

## MVP Scope (v1)
- Chrome extension button to snooze current tab.
- Presets: `30m`, `2h`, `tomorrow`, and `custom` datetime.
- Store snoozed tab metadata in `chrome.storage.local`.
- Schedule wake-up checks with `chrome.alarms`.
- Reopen due tabs in Chrome automatically.
- Send events to a local helper app that appends to a Markdown file.

## Out of Scope (v1)
- Cloud sync and multi-device sync.
- Editing/deleting previously snoozed entries from UI.
- Full cron language parsing.
- Guaranteed wake-up while Chrome is fully closed.

## Architecture

### 1) Chrome Extension (Manifest V3)
- `service_worker`: background logic and alarms.
- `action` popup: snooze controls.
- `permissions`: `tabs`, `storage`, `alarms`.
- `host_permissions`: `http://127.0.0.1:17333/*` for local helper calls.

Responsibilities:
- Read active tab URL/title.
- Compute `dueAt` from preset/custom input.
- Save item to `chrome.storage.local`.
- Emit `snoozed` and `reopened` events to helper.
- Reopen due tabs and mark them completed.

### 2) Local Helper App (Node.js)
- Small HTTP server listening on `127.0.0.1:17333`.
- Endpoints:
  - `POST /snooze`
  - `POST /reopened`
  - `GET /health`
- Appends Markdown lines to configured file path (for example `~/TODO.md`).

Responsibilities:
- Validate payload shape.
- Format markdown line.
- Append line atomically.

### 3) Markdown Log File
Append-only entries such as:

```md
- [ ] 2026-02-13T10:30:00-08:00 | Snoozed | [Page title](https://example.com) | id=abc123 | due=2026-02-13T11:00:00-08:00
- [x] 2026-02-13T11:00:03-08:00 | Reopened | [Page title](https://example.com) | id=abc123
```

## Data Model

```ts
{
  id: string,
  url: string,
  title: string,
  createdAt: string, // ISO
  dueAt: string,     // ISO
  status: 'snoozed' | 'reopened'
}
```

## Detailed Build Steps

1. Project setup
- Create folders: `extension/`, `helper/`, `docs/`.
- Add `README.md` with setup/run instructions.

2. Extension skeleton
- Add `manifest.json`, `background.js`, `popup.html`, `popup.js`, `popup.css`.
- Add action popup UI with snooze preset buttons and custom datetime input.

3. Snooze write path
- Read active tab from `chrome.tabs.query`.
- Create item (`id`, `url`, `title`, timestamps).
- Persist to storage list `snoozedTabs`.
- Fire-and-forget `fetch('http://127.0.0.1:17333/snooze')`.

4. Alarm scheduler
- Create one repeating alarm (e.g. every minute).
- On alarm, load all `snoozedTabs`, compare `dueAt <= now`.
- For due items: `chrome.tabs.create({ url })` and mark `status=reopened`.
- Send `POST /reopened` for each reopened item.

5. Retry strategy for helper outages
- Keep `pendingEvents` queue in `chrome.storage.local`.
- On each alarm tick, retry queued HTTP events.
- Keep max queue size (for example 500) to avoid growth.

6. Node helper implementation
- Use plain Node `http` + `fs/promises` (no framework required).
- Parse JSON body, validate required fields.
- Append single Markdown line per event.
- Return clear status codes and errors.

7. Local config
- Helper reads env var `TAB_SNOOZER_MD_PATH`.
- Default to `~/TODO.md` if env var absent.

8. Manual test plan
- Snooze active tab for 1 minute.
- Verify entry appears in markdown file.
- Wait for due time and verify tab reopens.
- Verify reopened entry appended.
- Stop helper and snooze again; verify queue/retry once helper restarts.

9. Packaging
- Extension: load unpacked from `extension/` in `chrome://extensions`.
- Helper: run with `node helper/server.js`.
- Add short troubleshooting notes.

## Risks and Mitigations
- Chrome closed at due time: reopen on next browser launch and alarm tick.
- Helper unavailable: local queue + retry.
- Markdown path invalid: helper returns error; document setup clearly.

## Milestones
1. M1: Extension can snooze + store data locally.
2. M2: Due tabs reopen with alarms.
3. M3: Helper logs snooze/reopen events to markdown.
4. M4: End-to-end reliability (retry + docs).

## Immediate Next Actions
1. Scaffold `extension/` and `helper/` folders.
2. Implement the extension snooze/reopen loop first.
3. Implement helper endpoints and markdown writer.
4. Run the manual test checklist.
