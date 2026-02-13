# Manual Test Checklist

## Setup
1. Start helper server:
   - `TAB_SNOOZER_MD_PATH=~/TODO.md node helper/server.js`
2. Load extension unpacked from `extension/`.
3. Keep Chrome running.

## Test 1: Snooze event append
1. Open a normal website tab.
2. Click extension icon.
3. Click `Snooze 30m`.
4. Verify line appended in markdown file with `Snoozed` and `due=` fields.

## Test 2: Due tab reopen
1. Use custom snooze for 1-2 minutes in the future.
2. Wait for due time.
3. Verify tab reopens.
4. Verify `Reopened` line appended in markdown file with matching `id=`.

## Test 3: Helper offline retry
1. Stop helper server.
2. Snooze a tab.
3. Start helper server again.
4. Wait for alarm cycle (up to ~1 minute).
5. Verify queued `Snoozed` event appears in markdown file.

## Test 4: Health endpoint
1. Run `curl http://127.0.0.1:17333/health`.
2. Verify JSON response with `ok: true`.
