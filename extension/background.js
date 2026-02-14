const STORAGE_KEYS = {
  SNOOZED_TABS: "snoozedTabs",
  PENDING_EVENTS: "pendingEvents",
  RECURRING_JOBS: "recurringJobs"
};

const HELPER_BASE_URL = "http://127.0.0.1:17333";
const ALARM_NAME = "tab-snoozer-check";
const ITEM_ALARM_PREFIX = "tab-snoozer-item-";
const RECURRING_ALARM_PREFIX = "tab-snoozer-recurring-";
const ALARM_PERIOD_MINUTES = 1;
const MAX_PENDING_EVENTS = 500;
const MIN_RECURRING_MINUTES = 1;
const MORNING_HOUR = 9;
const EVENING_HOUR = 18;

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

function recurringAlarmName(jobId) {
  return `${RECURRING_ALARM_PREFIX}${jobId}`;
}

function recurringJobIdFromAlarmName(alarmName) {
  if (typeof alarmName !== "string" || !alarmName.startsWith(RECURRING_ALARM_PREFIX)) {
    return null;
  }

  const jobId = alarmName.slice(RECURRING_ALARM_PREFIX.length);
  return jobId || null;
}

function normalizeScheduleMode(value) {
  const allowed = new Set([
    "interval",
    "hourly",
    "daily_morning",
    "daily_evening",
    "weekdays_morning"
  ]);

  return allowed.has(value) ? value : "interval";
}

function nextDailyRunMs(nowMs, hour, weekdaysOnly) {
  const now = new Date(nowMs);
  const todayBase = new Date(nowMs);
  todayBase.setHours(hour, 0, 0, 0);

  for (let offset = 0; offset <= 8; offset += 1) {
    const candidate = new Date(todayBase);
    candidate.setDate(todayBase.getDate() + offset);

    if (candidate.getTime() <= now.getTime()) {
      continue;
    }

    if (weekdaysOnly) {
      const day = candidate.getDay();
      if (day === 0 || day === 6) {
        continue;
      }
    }

    return candidate.getTime();
  }

  return nowMs + 24 * 60 * 60 * 1000;
}

function nextHourlyRunMs(nowMs) {
  const candidate = new Date(nowMs);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(0);
  candidate.setHours(candidate.getHours() + 1);
  return candidate.getTime();
}

function computeNextRecurringRunMs(job, nowMs = Date.now()) {
  const scheduleMode = normalizeScheduleMode(job && job.scheduleMode);

  if (scheduleMode === "hourly") {
    return nextHourlyRunMs(nowMs);
  }

  if (scheduleMode === "daily_morning") {
    return nextDailyRunMs(nowMs, MORNING_HOUR, false);
  }

  if (scheduleMode === "daily_evening") {
    return nextDailyRunMs(nowMs, EVENING_HOUR, false);
  }

  if (scheduleMode === "weekdays_morning") {
    return nextDailyRunMs(nowMs, MORNING_HOUR, true);
  }

  const everyMinutes = Math.max(MIN_RECURRING_MINUTES, Number(job && job.everyMinutes) || MIN_RECURRING_MINUTES);
  return nowMs + everyMinutes * 60 * 1000;
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

async function getRecurringJobs() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.RECURRING_JOBS]);
  return Array.isArray(data[STORAGE_KEYS.RECURRING_JOBS])
    ? data[STORAGE_KEYS.RECURRING_JOBS]
    : [];
}

async function saveRecurringJobs(recurringJobs) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RECURRING_JOBS]: recurringJobs });
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

async function clearAlarmForRecurringJobId(jobId) {
  await chrome.alarms.clear(recurringAlarmName(jobId));
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

function normalizeRecurringJobInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Recurring job is required.");
  }

  const type = input.type === "close" ? "close" : "open";
  const scheduleMode = normalizeScheduleMode(input.scheduleMode);

  let everyMinutes = Number(input.everyMinutes);
  if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_RECURRING_MINUTES) {
    everyMinutes = 5;
  }

  if (scheduleMode === "hourly") {
    everyMinutes = 60;
  } else if (scheduleMode === "daily_morning" || scheduleMode === "daily_evening" || scheduleMode === "weekdays_morning") {
    everyMinutes = 24 * 60;
  }

  if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_RECURRING_MINUTES) {
    throw new Error("Interval must be at least 1 minute.");
  }

  const normalized = {
    id: createId(),
    type,
    scheduleMode,
    everyMinutes: Math.floor(everyMinutes),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null
  };

  if (type === "open") {
    if (typeof input.url !== "string" || input.url.trim() === "") {
      throw new Error("URL is required for open job.");
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(input.url.trim());
    } catch (error) {
      throw new Error("Open job URL must be valid.");
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Open job URL must be http or https.");
    }

    normalized.url = parsedUrl.toString();
    return normalized;
  }

  const matchField = input.matchField === "title" ? "title" : "url";
  const matchMode = input.matchMode === "regex" ? "regex" : "contains";

  if (typeof input.pattern !== "string" || input.pattern.trim() === "") {
    throw new Error("Pattern is required for close job.");
  }

  const pattern = input.pattern.trim();

  if (matchMode === "regex") {
    try {
      // Validate pattern early so recurring execution never crashes on invalid regex.
      new RegExp(pattern, "i");
    } catch (error) {
      throw new Error("Regex pattern is invalid.");
    }
  }

  normalized.matchField = matchField;
  normalized.matchMode = matchMode;
  normalized.pattern = pattern;
  return normalized;
}

async function scheduleRecurringAlarmForJob(job) {
  if (!job || typeof job.id !== "string") {
    return;
  }

  const alarmName = recurringAlarmName(job.id);

  if (!job.enabled) {
    await clearAlarmForRecurringJobId(job.id);
    return;
  }

  const existing = await chrome.alarms.get(alarmName);
  const now = Date.now();

  if (existing && typeof existing.scheduledTime === "number" && existing.scheduledTime > now + 3000) {
    return;
  }

  const scheduledTime = computeNextRecurringRunMs(job, now);

  chrome.alarms.create(alarmName, { when: scheduledTime });
}

async function ensureRecurringJobAlarms() {
  const recurringJobs = await getRecurringJobs();
  const activeIds = new Set();

  for (const job of recurringJobs) {
    if (typeof job.id !== "string") {
      continue;
    }

    activeIds.add(job.id);
    await scheduleRecurringAlarmForJob(job);
  }

  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    const jobId = recurringJobIdFromAlarmName(alarm.name);
    if (jobId && !activeIds.has(jobId)) {
      await chrome.alarms.clear(alarm.name);
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

function tabMatchesCloseRule(tab, job) {
  const matchField = job.matchField === "title" ? "title" : "url";
  const matchMode = job.matchMode === "regex" ? "regex" : "contains";
  const pattern = typeof job.pattern === "string" ? job.pattern : "";
  if (!pattern) {
    return false;
  }

  const value = matchField === "title" ? (tab.title || "") : (tab.url || "");
  if (!value) {
    return false;
  }

  if (matchMode === "regex") {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch (error) {
      return false;
    }
  }

  return value.toLowerCase().includes(pattern.toLowerCase());
}

async function executeRecurringJob(job) {
  if (!job || !job.enabled) {
    return { opened: false, closedCount: 0 };
  }

  if (job.type === "open") {
    await openDueTab(job.url);
    return { opened: true, closedCount: 0 };
  }

  const tabs = await chrome.tabs.query({});
  const tabIdsToClose = tabs
    .filter((tab) => typeof tab.id === "number" && tabMatchesCloseRule(tab, job))
    .map((tab) => tab.id);

  if (tabIdsToClose.length > 0) {
    await chrome.tabs.remove(tabIdsToClose);
  }

  return { opened: false, closedCount: tabIdsToClose.length };
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
  await ensureRecurringJobAlarms();
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

async function getActiveTabInfo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];

  if (!activeTab) {
    return null;
  }

  return {
    id: typeof activeTab.id === "number" ? activeTab.id : null,
    url: typeof activeTab.url === "string" ? activeTab.url : "",
    title: typeof activeTab.title === "string" ? activeTab.title : ""
  };
}

async function listRecurringJobs() {
  const recurringJobs = await getRecurringJobs();

  return recurringJobs
    .filter((job) => job && typeof job.id === "string")
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

async function createRecurringJob(input) {
  const job = normalizeRecurringJobInput(input);
  const recurringJobs = await getRecurringJobs();
  recurringJobs.push(job);
  await saveRecurringJobs(recurringJobs);
  await scheduleRecurringAlarmForJob(job);
  return job;
}

async function removeRecurringJobById(jobId) {
  if (typeof jobId !== "string" || jobId.trim() === "") {
    throw new Error("Missing recurring job id.");
  }

  const recurringJobs = await getRecurringJobs();
  const index = recurringJobs.findIndex((job) => job.id === jobId);

  if (index === -1) {
    return { removed: false };
  }

  const [removedJob] = recurringJobs.splice(index, 1);
  await saveRecurringJobs(recurringJobs);
  await clearAlarmForRecurringJobId(jobId);

  return { removed: true, job: removedJob };
}

async function runRecurringJobById(jobId) {
  const recurringJobs = await getRecurringJobs();
  const index = recurringJobs.findIndex((job) => job.id === jobId);

  if (index === -1) {
    await clearAlarmForRecurringJobId(jobId);
    return { ran: false };
  }

  const job = recurringJobs[index];
  if (!job.enabled) {
    return { ran: false };
  }

  const result = await executeRecurringJob(job);
  job.lastRunAt = new Date().toISOString();
  recurringJobs[index] = job;
  await saveRecurringJobs(recurringJobs);
  await scheduleRecurringAlarmForJob(job);

  return {
    ran: true,
    result
  };
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
    return;
  }

  if (alarm.name.startsWith(RECURRING_ALARM_PREFIX)) {
    const jobId = recurringJobIdFromAlarmName(alarm.name);
    if (!jobId) {
      return;
    }

    runRecurringJobById(jobId).catch((error) => {
      console.error("Recurring alarm handling failed", error);
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

  if (message.type === "GET_ACTIVE_TAB_INFO") {
    getActiveTabInfo()
      .then((tab) => {
        sendResponse({ ok: true, tab });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (message.type === "LIST_RECURRING_JOBS") {
    listRecurringJobs()
      .then((jobs) => {
        sendResponse({ ok: true, jobs });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (message.type === "CREATE_RECURRING_JOB") {
    createRecurringJob(message.job)
      .then((job) => {
        sendResponse({ ok: true, job });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  if (message.type === "REMOVE_RECURRING_JOB") {
    removeRecurringJobById(message.id)
      .then((result) => {
        sendResponse({ ok: true, removed: result.removed, job: result.job || null });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || "Unknown error" });
      });

    return true;
  }

  return false;
});
