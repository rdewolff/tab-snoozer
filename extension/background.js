const STORAGE_KEYS = {
  SNOOZED_TABS: "snoozedTabs",
  PENDING_EVENTS: "pendingEvents"
};

const HELPER_BASE_URL = "http://127.0.0.1:17333";
const ALARM_NAME = "tab-snoozer-check";
const ITEM_ALARM_PREFIX = "tab-snoozer-item-";
const ALARM_PERIOD_MINUTES = 1;
const MAX_PENDING_EVENTS = 500;

function createId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function helperEndpointForEvent(event) {
  return event.type === "reopened" ? "/reopened" : "/snooze";
}

function itemAlarmName(itemId) {
  return `${ITEM_ALARM_PREFIX}${itemId}`;
}

function itemIdFromAlarmName(alarmName) {
  if (typeof alarmName !== "string" || !alarmName.startsWith(ITEM_ALARM_PREFIX)) {
    return null;
  }

  const itemId = alarmName.slice(ITEM_ALARM_PREFIX.length);
  return itemId || null;
}

async function getSnoozedTabs() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.SNOOZED_TABS]);
  return Array.isArray(data[STORAGE_KEYS.SNOOZED_TABS])
    ? data[STORAGE_KEYS.SNOOZED_TABS]
    : [];
}

async function saveSnoozedTabs(snoozedTabs) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SNOOZED_TABS]: snoozedTabs });
}

async function queuePendingEvent(event) {
  const data = await chrome.storage.local.get([STORAGE_KEYS.PENDING_EVENTS]);
  const pendingEvents = Array.isArray(data[STORAGE_KEYS.PENDING_EVENTS])
    ? data[STORAGE_KEYS.PENDING_EVENTS]
    : [];

  pendingEvents.push(event);

  if (pendingEvents.length > MAX_PENDING_EVENTS) {
    pendingEvents.splice(0, pendingEvents.length - MAX_PENDING_EVENTS);
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_EVENTS]: pendingEvents });
}

async function postEventToHelper(event) {
  const endpoint = helperEndpointForEvent(event);
  const response = await fetch(`${HELPER_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(event)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Helper responded ${response.status}: ${errorBody}`);
  }
}

async function sendOrQueueEvent(event) {
  try {
    await postEventToHelper(event);
    return { queued: false };
  } catch (error) {
    console.warn("Failed to send event to helper, queued for retry", error);
    await queuePendingEvent(event);
    return { queued: true };
  }
}

async function flushPendingEvents() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.PENDING_EVENTS]);
  const pendingEvents = Array.isArray(data[STORAGE_KEYS.PENDING_EVENTS])
    ? data[STORAGE_KEYS.PENDING_EVENTS]
    : [];

  if (pendingEvents.length === 0) {
    return;
  }

  const failedEvents = [];

  for (const event of pendingEvents) {
    try {
      await postEventToHelper(event);
    } catch (error) {
      console.warn("Pending event retry failed", error);
      failedEvents.push(event);
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_EVENTS]: failedEvents });
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);

  if (!existing) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  }
}

async function scheduleAlarmForItem(item) {
  if (!item || item.status !== "snoozed" || typeof item.id !== "string") {
    return;
  }

  const dueMs = Date.parse(item.dueAt);
  if (Number.isNaN(dueMs)) {
    return;
  }

  const alarmName = itemAlarmName(item.id);
  const scheduledTime = Math.max(dueMs, Date.now() + 1000);
  const existing = await chrome.alarms.get(alarmName);

  if (!existing || Math.abs((existing.scheduledTime || 0) - scheduledTime) > 2000) {
    chrome.alarms.create(alarmName, { when: scheduledTime });
  }
}

async function clearAlarmForItemId(itemId) {
  await chrome.alarms.clear(itemAlarmName(itemId));
}

async function ensureItemAlarmsForPendingTabs() {
  const snoozedTabs = await getSnoozedTabs();

  for (const item of snoozedTabs) {
    if (item.status === "snoozed") {
      await scheduleAlarmForItem(item);
    } else if (typeof item.id === "string") {
      await clearAlarmForItemId(item.id);
    }
  }
}

async function openDueTab(url) {
  try {
    await chrome.tabs.create({ url, active: true });
    return;
  } catch (tabError) {
    console.warn("tabs.create failed, trying windows.create fallback", tabError);
  }

  await chrome.windows.create({ url, focused: true });
}

async function reopenSnoozedItem(snoozedTabs, index) {
  const item = snoozedTabs[index];
  if (!item || item.status !== "snoozed") {
    return false;
  }

  try {
    await openDueTab(item.url);
    item.status = "reopened";
    item.reopenedAt = new Date().toISOString();

    await sendOrQueueEvent({
      type: "reopened",
      id: item.id,
      url: item.url,
      title: item.title,
      createdAt: item.createdAt,
      dueAt: item.dueAt,
      eventAt: item.reopenedAt
    });

    await clearAlarmForItemId(item.id);
    return true;
  } catch (error) {
    console.error("Failed to reopen due tab", item, error);
    return false;
  }
}

async function processDueTabs() {
  const snoozedTabs = await getSnoozedTabs();
  const now = Date.now();
  let updated = false;

  for (const item of snoozedTabs) {
    if (item.status !== "snoozed") {
      continue;
    }

    const dueMs = Date.parse(item.dueAt);
    if (Number.isNaN(dueMs) || dueMs > now) {
      continue;
    }

    if (await reopenSnoozedItem(snoozedTabs, snoozedTabs.indexOf(item))) {
      updated = true;
    }
  }

  if (updated) {
    await saveSnoozedTabs(snoozedTabs);
  }
}

async function handleItemAlarm(alarmName) {
  const itemId = itemIdFromAlarmName(alarmName);
  if (!itemId) {
    return;
  }

  const snoozedTabs = await getSnoozedTabs();
  const index = snoozedTabs.findIndex((item) => item.id === itemId);

  if (index === -1) {
    return;
  }

  const item = snoozedTabs[index];
  if (item.status !== "snoozed") {
    await clearAlarmForItemId(itemId);
    return;
  }

  const dueMs = Date.parse(item.dueAt);
  if (Number.isNaN(dueMs)) {
    return;
  }

  // Guard against clock skew or early alarm delivery.
  if (dueMs > Date.now() + 1000) {
    await scheduleAlarmForItem(item);
    return;
  }

  const reopened = await reopenSnoozedItem(snoozedTabs, index);
  if (reopened) {
    await saveSnoozedTabs(snoozedTabs);
  }
}

async function runMaintenanceCycle() {
  await ensureAlarm();
  await ensureItemAlarmsForPendingTabs();
  await processDueTabs();
  await flushPendingEvents();
}

async function snoozeActiveTab(dueAt) {
  const dueAtMs = Date.parse(dueAt);

  if (Number.isNaN(dueAtMs)) {
    throw new Error("Invalid due date.");
  }

  if (dueAtMs <= Date.now()) {
    throw new Error("Due date must be in the future.");
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  const activeTabId = activeTab && typeof activeTab.id === "number" ? activeTab.id : null;

  if (!activeTab || !activeTab.url) {
    throw new Error("Could not read active tab URL.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(activeTab.url);
  } catch (error) {
    throw new Error("Tab URL is not valid.");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Only http/https tabs can be snoozed.");
  }

  const item = {
    id: createId(),
    url: activeTab.url,
    title: activeTab.title || activeTab.url,
    createdAt: new Date().toISOString(),
    dueAt: new Date(dueAtMs).toISOString(),
    status: "snoozed"
  };

  const snoozedTabs = await getSnoozedTabs();
  snoozedTabs.push(item);
  await saveSnoozedTabs(snoozedTabs);
  await scheduleAlarmForItem(item);

  const delivery = await sendOrQueueEvent({
    type: "snoozed",
    id: item.id,
    url: item.url,
    title: item.title,
    createdAt: item.createdAt,
    dueAt: item.dueAt,
    eventAt: new Date().toISOString()
  });

  await ensureAlarm();

  let tabClosed = false;
  if (activeTabId !== null) {
    try {
      await chrome.tabs.remove(activeTabId);
      tabClosed = true;
    } catch (error) {
      console.warn("Snooze saved, but failed to close active tab", error);
    }
  }

  return {
    item,
    helperQueued: delivery.queued,
    tabClosed
  };
}

async function listPendingSnoozedTabs() {
  const snoozedTabs = await getSnoozedTabs();

  return snoozedTabs
    .filter((item) => item.status === "snoozed")
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

async function removeSnoozedTabById(itemId) {
  if (typeof itemId !== "string" || itemId.trim() === "") {
    throw new Error("Missing snoozed tab id.");
  }

  const snoozedTabs = await getSnoozedTabs();
  const index = snoozedTabs.findIndex((item) => item.id === itemId);

  if (index === -1) {
    return { removed: false };
  }

  const [removedItem] = snoozedTabs.splice(index, 1);
  await saveSnoozedTabs(snoozedTabs);
  await clearAlarmForItemId(itemId);

  return { removed: true, item: removedItem };
}

chrome.runtime.onInstalled.addListener(() => {
  runMaintenanceCycle().catch((error) => {
    console.error("onInstalled maintenance failed", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  runMaintenanceCycle().catch((error) => {
    console.error("onStartup maintenance failed", error);
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || !alarm.name) {
    return;
  }

  if (alarm.name === ALARM_NAME) {
    runMaintenanceCycle().catch((error) => {
      console.error("Alarm maintenance failed", error);
    });
    return;
  }

  if (alarm.name.startsWith(ITEM_ALARM_PREFIX)) {
    handleItemAlarm(alarm.name)
      .then(() => flushPendingEvents())
      .catch((error) => {
        console.error("Item alarm handling failed", error);
      });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "SNOOZE_ACTIVE_TAB") {
    snoozeActiveTab(message.dueAt)
      .then((result) => {
        sendResponse({ ok: true, item: result.item, helperQueued: result.helperQueued });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (message.type === "LIST_SNOOZED_TABS") {
    listPendingSnoozedTabs()
      .then((items) => {
        sendResponse({ ok: true, items });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (message.type === "REMOVE_SNOOZED_TAB") {
    removeSnoozedTabById(message.id)
      .then((result) => {
        sendResponse({ ok: true, removed: result.removed, item: result.item || null });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  return false;
});
