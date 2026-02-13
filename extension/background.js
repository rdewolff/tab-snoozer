const STORAGE_KEYS = {
  SNOOZED_TABS: "snoozedTabs",
  PENDING_EVENTS: "pendingEvents"
};

const HELPER_BASE_URL = "http://127.0.0.1:17333";
const ALARM_NAME = "tab-snoozer-check";
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
  } catch (error) {
    console.warn("Failed to send event to helper, queued for retry", error);
    await queuePendingEvent(event);
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

    try {
      await chrome.tabs.create({ url: item.url, active: true });
      item.status = "reopened";
      item.reopenedAt = new Date().toISOString();
      updated = true;

      await sendOrQueueEvent({
        type: "reopened",
        id: item.id,
        url: item.url,
        title: item.title,
        createdAt: item.createdAt,
        dueAt: item.dueAt,
        eventAt: item.reopenedAt
      });
    } catch (error) {
      console.error("Failed to reopen due tab", item, error);
    }
  }

  if (updated) {
    await saveSnoozedTabs(snoozedTabs);
  }
}

async function runMaintenanceCycle() {
  await ensureAlarm();
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

  if (!activeTab || !activeTab.url) {
    throw new Error("Could not read active tab URL.");
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

  await sendOrQueueEvent({
    type: "snoozed",
    id: item.id,
    url: item.url,
    title: item.title,
    createdAt: item.createdAt,
    dueAt: item.dueAt,
    eventAt: new Date().toISOString()
  });

  await ensureAlarm();

  return item;
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
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  runMaintenanceCycle().catch((error) => {
    console.error("Alarm maintenance failed", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SNOOZE_ACTIVE_TAB") {
    return false;
  }

  snoozeActiveTab(message.dueAt)
    .then((item) => {
      sendResponse({ ok: true, item });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});
