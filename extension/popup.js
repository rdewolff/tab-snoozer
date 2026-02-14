const statusEl = document.getElementById("status");
const confirmationEl = document.getElementById("confirmation");
const confirmationTextEl = document.getElementById("confirmationText");

const viewTabButtons = Array.from(document.querySelectorAll(".view-tab"));
const viewSnoozeEl = document.getElementById("viewSnooze");
const viewAutomationEl = document.getElementById("viewAutomation");
const viewHistoryEl = document.getElementById("viewHistory");

const customDueEl = document.getElementById("customDue");
const customSnoozeEl = document.getElementById("customSnooze");
const snoozedListEl = document.getElementById("snoozedList");
const snoozedCountEl = document.getElementById("snoozedCount");
const emptyStateEl = document.getElementById("emptyState");
const refreshListEl = document.getElementById("refreshList");
const copyAllUrlsEl = document.getElementById("copyAllUrls");
const presetButtons = Array.from(document.querySelectorAll("button[data-minutes]"));
const tomorrowButton = document.querySelector('button[data-preset="tomorrow"]');
const adjustButtons = Array.from(document.querySelectorAll("button[data-adjust-minutes]"));

const automationTypeEl = document.getElementById("automationType");
const automationScheduleModeEl = document.getElementById("automationScheduleMode");
const automationOpenFieldsEl = document.getElementById("automationOpenFields");
const automationCloseFieldsEl = document.getElementById("automationCloseFields");
const automationIntervalFieldsEl = document.getElementById("automationIntervalFields");
const automationUrlEl = document.getElementById("automationUrl");
const automationMatchFieldEl = document.getElementById("automationMatchField");
const automationMatchModeEl = document.getElementById("automationMatchMode");
const automationPatternEl = document.getElementById("automationPattern");
const automationEveryEl = document.getElementById("automationEvery");
const intervalButtons = Array.from(document.querySelectorAll(".interval-btn"));
const createAutomationEl = document.getElementById("createAutomation");
const refreshJobsEl = document.getElementById("refreshJobs");
const jobsListEl = document.getElementById("jobsList");
const jobsCountEl = document.getElementById("jobsCount");
const jobsEmptyEl = document.getElementById("jobsEmpty");
const refreshHistoryEl = document.getElementById("refreshHistory");
const historyListEl = document.getElementById("historyList");
const historyCountEl = document.getElementById("historyCount");
const historyEmptyEl = document.getElementById("historyEmpty");

const snoozeActionButtons = [
  ...presetButtons,
  ...adjustButtons,
  tomorrowButton,
  copyAllUrlsEl,
  refreshListEl,
  customSnoozeEl
].filter(Boolean);

let currentSnoozedItems = [];
let currentRecurringJobs = [];
let currentHistoryItems = [];
let activeView = "snooze";

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.className = `status-bar${tone ? ` ${tone}` : ""}`;
}

function setConfirmation(message, tone) {
  confirmationEl.classList.remove("hidden", "warning");
  if (tone === "warning") {
    confirmationEl.classList.add("warning");
  }
  confirmationTextEl.textContent = message;
}

function setControlsDisabled(disabled) {
  snoozeActionButtons.forEach((button) => {
    button.disabled = disabled;
  });
  customDueEl.disabled = disabled;
}

function setActiveView(viewName) {
  if (viewName === "automation") {
    activeView = "automation";
  } else if (viewName === "history") {
    activeView = "history";
  } else {
    activeView = "snooze";
  }

  viewTabButtons.forEach((button) => {
    const isActive = button.dataset.viewTarget === activeView;
    button.classList.toggle("active", isActive);
  });

  viewSnoozeEl.classList.toggle("hidden", activeView !== "snooze");
  viewAutomationEl.classList.toggle("hidden", activeView !== "automation");
  viewHistoryEl.classList.toggle("hidden", activeView !== "history");
}

function sendMessage(message) {
  const sendMessageOnce = () => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });

  return sendMessageOnce().catch(async (error) => {
    const messageText = (error && error.message ? error.message : "").toLowerCase();
    const shouldRetry =
      messageText.includes("message port closed before a response was received") ||
      messageText.includes("receiving end does not exist");

    if (!shouldRetry) {
      throw error;
    }

    // Service worker can spin up slowly after extension reload; one retry is enough.
    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });

    return sendMessageOnce();
  });
}

async function copyText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new Error("Nothing to copy yet.");
  }

  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("Couldn't copy. Please try again.");
  }
}

function toInputDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + "T" + [pad(date.getHours()), pad(date.getMinutes())].join(":");
}

function tomorrowAtNineAM() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function getMinimumCustomDate() {
  return new Date(Date.now() + 60 * 1000);
}

function getCustomDueDate() {
  if (!customDueEl.value) {
    return null;
  }

  const date = new Date(customDueEl.value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function setCustomDueDate(date) {
  const minDate = getMinimumCustomDate();
  const normalized = date.getTime() < minDate.getTime() ? minDate : date;
  customDueEl.min = toInputDateTimeValue(minDate);
  customDueEl.value = toInputDateTimeValue(normalized);
}

function formatDateTime(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return "Invalid date";
  }
  return date.toLocaleString();
}

function trimTitle(title) {
  if (!title) {
    return "(Untitled tab)";
  }
  if (title.length <= 72) {
    return title;
  }
  return `${title.slice(0, 69)}...`;
}

function formatAdjustmentLabel(deltaMinutes) {
  const absolute = Math.abs(deltaMinutes);
  if (absolute >= 1440 && absolute % 1440 === 0) {
    return `${absolute / 1440}d`;
  }
  return `${absolute}m`;
}

function formatMinutesLabel(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours}h`;
  }
  return `${minutes}m`;
}

function isHttpUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
}

async function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(tab);
    });
  });
}

async function removeSnoozedTab(itemId) {
  const result = await sendMessage({ type: "REMOVE_SNOOZED_TAB", id: itemId });
  if (!result || !result.ok) {
    throw new Error((result && result.error) || "Couldn't remove this snoozed tab.");
  }
  return Boolean(result.removed);
}

function adjustCustomDueByMinutes(deltaMinutes) {
  const baseDate = getCustomDueDate() || new Date(Date.now() + 60 * 60 * 1000);
  const adjustedDate = new Date(baseDate.getTime() + deltaMinutes * 60 * 1000);
  setCustomDueDate(adjustedDate);

  const sign = deltaMinutes >= 0 ? "+" : "-";
  setStatus(`Custom time ${sign}${formatAdjustmentLabel(deltaMinutes)}.`, "");
}

function renderSnoozedTabs(items) {
  currentSnoozedItems = Array.isArray(items) ? items : [];
  snoozedListEl.innerHTML = "";

  if (!currentSnoozedItems.length) {
    snoozedCountEl.textContent = "0 pending";
    emptyStateEl.classList.remove("hidden");
    return;
  }

  emptyStateEl.classList.add("hidden");
  snoozedCountEl.textContent = `${currentSnoozedItems.length} pending`;

  currentSnoozedItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "snoozed-item";

    const top = document.createElement("div");
    top.className = "snoozed-item-top";

    const link = document.createElement("a");
    link.href = item.url;
    link.dataset.action = "open";
    link.dataset.id = item.id;
    link.dataset.url = item.url;
    link.textContent = trimTitle(item.title);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "copy-item-button";
    copyButton.textContent = "Copy";
    copyButton.title = "Copy link";
    copyButton.setAttribute("aria-label", "Copy link");
    copyButton.dataset.action = "copy-url";
    copyButton.dataset.id = item.id;
    copyButton.dataset.url = item.url;

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-button";
    removeButton.textContent = "X";
    removeButton.title = "Remove snooze";
    removeButton.setAttribute("aria-label", "Remove snooze");
    removeButton.dataset.action = "remove";
    removeButton.dataset.id = item.id;

    const due = document.createElement("p");
    due.className = "due";
    due.textContent = `Due: ${formatDateTime(item.dueAt)}`;

    top.appendChild(link);
    top.appendChild(copyButton);
    top.appendChild(removeButton);
    li.appendChild(top);
    li.appendChild(due);
    snoozedListEl.appendChild(li);
  });
}

async function refreshSnoozedTabs() {
  try {
    const result = await sendMessage({ type: "LIST_SNOOZED_TABS" });
    if (!result || !result.ok || !Array.isArray(result.items)) {
      throw new Error((result && result.error) || "Couldn't load your snoozed tabs.");
    }
    renderSnoozedTabs(result.items);
  } catch (error) {
    setStatus(error.message || "Couldn't load your snoozed tabs.", "error");
  }
}

async function snoozeAt(dueAtIso) {
  setStatus("Saving your snooze...", "");
  setControlsDisabled(true);

  try {
    const result = await sendMessage({ type: "SNOOZE_ACTIVE_TAB", dueAt: dueAtIso });

    if (!result || !result.ok) {
      throw new Error((result && result.error) || "Couldn't snooze this tab.");
    }

    const dueLabel = formatDateTime(result.item.dueAt);
    const baseMessage = `Saved "${trimTitle(result.item.title)}" until ${dueLabel}.`;
    if (result.helperQueued) {
      setConfirmation(`${baseMessage} It is already in your snoozed list.`, "warning");
      setStatus("Snoozed.", "success");
    } else {
      setConfirmation(baseMessage, "success");
      setStatus("Snoozed.", "success");
    }
    await refreshSnoozedTabs();
  } catch (error) {
    setStatus(error.message || "Couldn't snooze this tab.", "error");
  } finally {
    setControlsDisabled(false);
  }
}

function toggleAutomationFields() {
  const isOpenMode = automationTypeEl.value === "open";
  automationOpenFieldsEl.classList.toggle("hidden", !isOpenMode);
  automationCloseFieldsEl.classList.toggle("hidden", isOpenMode);
}

function getEveryMinutes() {
  const everyMinutes = Number(automationEveryEl.value);
  if (!Number.isFinite(everyMinutes) || everyMinutes < 1) {
    throw new Error("Repeat time must be at least 1 minute.");
  }
  return Math.floor(everyMinutes);
}

function syncIntervalButtons(selectedMinutes) {
  intervalButtons.forEach((button) => {
    const value = Number(button.dataset.intervalMinutes);
    button.classList.toggle("active", Number.isFinite(selectedMinutes) && value === selectedMinutes);
  });
}

function normalizeRecurringJobPayload() {
  const type = automationTypeEl.value === "close" ? "close" : "open";
  const scheduleMode = automationScheduleModeEl.value || "interval";
  const everyMinutes = scheduleMode === "interval" ? getEveryMinutes() : 5;

  if (type === "open") {
    const urlInput = (automationUrlEl.value || "").trim();
    if (!urlInput) {
      throw new Error("Please add a link to open.");
    }

    let parsed;
    try {
      parsed = new URL(urlInput);
    } catch (error) {
      throw new Error("That link doesn't look valid.");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Use a link starting with http:// or https://.");
    }

    return {
      type,
      scheduleMode,
      everyMinutes,
      url: parsed.toString()
    };
  }

  const pattern = (automationPatternEl.value || "").trim();
  if (!pattern) {
    throw new Error("Please add text or a pattern to match.");
  }

  const matchField = automationMatchFieldEl.value === "title" ? "title" : "url";
  const matchMode = automationMatchModeEl.value === "regex" ? "regex" : "contains";

  return {
    type,
    scheduleMode,
    everyMinutes,
    matchField,
    matchMode,
    pattern
  };
}

function formatScheduleModeLabel(job) {
  const mode = job && job.scheduleMode ? job.scheduleMode : "interval";

  if (mode === "hourly") {
    return "Every hour";
  }

  if (mode === "daily_morning") {
    return "Every morning (9:00)";
  }

  if (mode === "daily_evening") {
    return "Every evening (18:00)";
  }

  if (mode === "weekdays_morning") {
    return "Weekday mornings (9:00)";
  }

  return `Every ${formatMinutesLabel(Number(job.everyMinutes) || 1)}`;
}

function formatRecurringJobTitle(job) {
  if (job.type === "open") {
    return `Open ${job.url}`;
  }

  const fieldLabel = job.matchField === "title" ? "title" : "link";
  const modeLabel = job.matchMode === "regex" ? "matches pattern" : "contains";
  return `Close tabs where ${fieldLabel} ${modeLabel} "${job.pattern}"`;
}

function formatHistoryActionLabel(item) {
  if (!item || typeof item !== "object") {
    return "Action";
  }

  if (item.action === "snoozed") {
    return "Snoozed";
  }

  if (item.action === "opened") {
    return "Opened";
  }

  if (item.action === "closed") {
    return "Closed";
  }

  return "Action";
}

function formatHistoryDetails(item) {
  let source = "System";
  if (item && item.source === "manual_snooze") {
    source = "Snooze";
  } else if (item && item.source === "snooze_due") {
    source = "Snooze Reopen";
  } else if (item && item.source === "recurring_open") {
    source = "Automation Open";
  } else if (item && item.source === "recurring_close") {
    source = "Automation Close";
  }
  const when = formatDateTime(item.eventAt);

  if (item.action === "snoozed" && item.meta && typeof item.meta.dueAt === "string") {
    return `${when} | due ${formatDateTime(item.meta.dueAt)} | ${source}`;
  }

  return `${when} | ${source}`;
}

function renderRecurringJobs(jobs) {
  currentRecurringJobs = Array.isArray(jobs) ? jobs : [];
  jobsListEl.innerHTML = "";

  if (!currentRecurringJobs.length) {
    jobsCountEl.textContent = "0 jobs";
    jobsEmptyEl.classList.remove("hidden");
    return;
  }

  jobsEmptyEl.classList.add("hidden");
  jobsCountEl.textContent = `${currentRecurringJobs.length} job${currentRecurringJobs.length === 1 ? "" : "s"}`;

  currentRecurringJobs.forEach((job) => {
    const li = document.createElement("li");
    li.className = "job-item";

    const top = document.createElement("div");
    top.className = "job-item-top";

    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = formatRecurringJobTitle(job);

    if (job.type === "open" && typeof job.url === "string") {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "copy-item-button";
      copyButton.textContent = "Copy";
      copyButton.title = "Copy link";
      copyButton.dataset.action = "copy-job-url";
      copyButton.dataset.id = job.id;
      copyButton.dataset.url = job.url;
      top.appendChild(copyButton);
    }

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-button";
    removeButton.textContent = "X";
    removeButton.title = "Remove recurring job";
    removeButton.dataset.action = "remove-job";
    removeButton.dataset.id = job.id;

    const details = document.createElement("p");
    details.className = "job-details";
    const scheduleLabel = formatScheduleModeLabel(job);
    const lastRunLabel = job.lastRunAt ? `Last run: ${formatDateTime(job.lastRunAt)}` : "Last run: never";
    details.textContent = `${scheduleLabel}. ${lastRunLabel}.`;

    top.appendChild(title);
    top.appendChild(removeButton);
    li.appendChild(top);
    li.appendChild(details);
    jobsListEl.appendChild(li);
  });
}

async function refreshRecurringJobs() {
  try {
    const result = await sendMessage({ type: "LIST_RECURRING_JOBS" });
    if (!result || !result.ok || !Array.isArray(result.jobs)) {
      throw new Error((result && result.error) || "Couldn't load your automations.");
    }

    renderRecurringJobs(result.jobs);
  } catch (error) {
    setStatus(error.message || "Couldn't load your automations.", "error");
  }
}

function renderActionHistory(items) {
  currentHistoryItems = Array.isArray(items) ? items : [];
  historyListEl.innerHTML = "";

  if (!currentHistoryItems.length) {
    historyCountEl.textContent = "0 events";
    historyEmptyEl.classList.remove("hidden");
    return;
  }

  historyEmptyEl.classList.add("hidden");
  historyCountEl.textContent = `${currentHistoryItems.length} event${currentHistoryItems.length === 1 ? "" : "s"}`;

  currentHistoryItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const top = document.createElement("div");
    top.className = "history-item-top";

    const link = document.createElement("a");
    link.className = "history-link";
    link.textContent = trimTitle(item.title || item.url || "(No title)");
    link.href = item.url || "#";
    link.dataset.action = "open-history";
    link.dataset.url = item.url || "";

    const badge = document.createElement("span");
    badge.className = "history-badge";
    badge.textContent = formatHistoryActionLabel(item);

    const details = document.createElement("p");
    details.className = "history-details";
    details.textContent = formatHistoryDetails(item);

    top.appendChild(link);
    top.appendChild(badge);
    li.appendChild(top);
    li.appendChild(details);
    historyListEl.appendChild(li);
  });
}

async function refreshActionHistory() {
  try {
    const result = await sendMessage({ type: "LIST_ACTION_HISTORY", limit: 300 });
    if (!result || !result.ok || !Array.isArray(result.items)) {
      throw new Error((result && result.error) || "Couldn't load your history.");
    }

    renderActionHistory(result.items);
  } catch (error) {
    setStatus(error.message || "Couldn't load your history.", "error");
  }
}

async function createRecurringJob() {
  const jobPayload = normalizeRecurringJobPayload();
  const result = await sendMessage({ type: "CREATE_RECURRING_JOB", job: jobPayload });

  if (!result || !result.ok || !result.job) {
    throw new Error((result && result.error) || "Couldn't save this automation.");
  }

  return result.job;
}

async function removeRecurringJob(jobId) {
  const result = await sendMessage({ type: "REMOVE_RECURRING_JOB", id: jobId });

  if (!result || !result.ok) {
    throw new Error((result && result.error) || "Couldn't remove this automation.");
  }

  return Boolean(result.removed);
}

async function fillAutomationUrlFromActiveTab() {
  if (!automationUrlEl || automationTypeEl.value !== "open") {
    return;
  }

  if (automationUrlEl.value.trim() !== "") {
    return;
  }

  const result = await sendMessage({ type: "GET_ACTIVE_TAB_INFO" });
  if (!result || !result.ok || !result.tab) {
    return;
  }

  const activeUrl = typeof result.tab.url === "string" ? result.tab.url : "";
  if (!isHttpUrl(activeUrl)) {
    return;
  }

  automationUrlEl.value = activeUrl;
}

viewTabButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const targetView = button.dataset.viewTarget === "automation"
      ? "automation"
      : button.dataset.viewTarget === "history"
        ? "history"
        : "snooze";
    setActiveView(targetView);

    if (targetView === "automation") {
      await refreshRecurringJobs();
      await fillAutomationUrlFromActiveTab();
    } else if (targetView === "history") {
      await refreshActionHistory();
    } else {
      await refreshSnoozedTabs();
    }
  });
});

presetButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const minutes = Number(button.dataset.minutes);

    if (!Number.isFinite(minutes) || minutes <= 0) {
      setStatus("That preset time isn't valid.", "error");
      return;
    }

    const dueAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await snoozeAt(dueAt);
  });
});

if (tomorrowButton) {
  tomorrowButton.addEventListener("click", async () => {
    await snoozeAt(tomorrowAtNineAM());
  });
}

customSnoozeEl.addEventListener("click", async () => {
  const dueAt = getCustomDueDate();

  if (!dueAt) {
    setStatus("Pick a custom date and time first.", "error");
    return;
  }

  await snoozeAt(dueAt.toISOString());
});

adjustButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const deltaMinutes = Number(button.dataset.adjustMinutes);
    if (!Number.isFinite(deltaMinutes) || deltaMinutes === 0) {
      setStatus("That time adjustment isn't valid.", "error");
      return;
    }
    adjustCustomDueByMinutes(deltaMinutes);
  });
});

refreshListEl.addEventListener("click", async () => {
  await refreshSnoozedTabs();
});

copyAllUrlsEl.addEventListener("click", async () => {
  if (!currentSnoozedItems.length) {
    setStatus("No snoozed links yet.", "error");
    return;
  }

  const urls = currentSnoozedItems
    .map((item) => item.url)
    .filter((url) => typeof url === "string" && url.trim() !== "");

  if (!urls.length) {
    setStatus("No valid links to copy.", "error");
    return;
  }

  try {
    await copyText(urls.join("\n"));
    setStatus(`Copied ${urls.length} link${urls.length === 1 ? "" : "s"}.`, "success");
  } catch (error) {
    setStatus(error.message || "Couldn't copy those links.", "error");
  }
});

snoozedListEl.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;
  const itemId = actionTarget.dataset.id;

  if (!itemId) {
    return;
  }

  if (action === "remove") {
    try {
      await removeSnoozedTab(itemId);
      setStatus("Removed from your snoozed list.", "success");
      await refreshSnoozedTabs();
    } catch (error) {
      setStatus(error.message || "Couldn't remove this snoozed tab.", "error");
    }
    return;
  }

  if (action === "copy-url") {
    const url = actionTarget.dataset.url;
    if (!url) {
      setStatus("This item has no link to copy.", "error");
      return;
    }

    try {
      await copyText(url);
      setStatus("Link copied.", "success");
    } catch (error) {
      setStatus(error.message || "Couldn't copy this link.", "error");
    }
    return;
  }

  if (action === "open") {
    event.preventDefault();
    const url = actionTarget.dataset.url;
    if (!url) {
      setStatus("This item has no link.", "error");
      return;
    }

    try {
      await removeSnoozedTab(itemId);
      await createTab(url);
      setStatus("Opened and removed from your snoozed list.", "success");
      await refreshSnoozedTabs();
      window.close();
    } catch (error) {
      setStatus(error.message || "Couldn't open this snoozed tab.", "error");
    }
  }
});

automationTypeEl.addEventListener("change", () => {
  toggleAutomationFields();
  fillAutomationUrlFromActiveTab().catch(() => {});
});

function toggleAutomationScheduleFields() {
  const scheduleMode = automationScheduleModeEl.value || "interval";
  const intervalMode = scheduleMode === "interval";
  automationIntervalFieldsEl.classList.toggle("hidden", !intervalMode);
}

intervalButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const minutes = Number(button.dataset.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      setStatus("That repeat option isn't valid.", "error");
      return;
    }

    automationEveryEl.value = String(minutes);
    syncIntervalButtons(minutes);
    setStatus(`Repeats every ${formatMinutesLabel(minutes)}.`, "");
  });
});

automationEveryEl.addEventListener("input", () => {
  const minutes = Number(automationEveryEl.value);
  syncIntervalButtons(minutes);
});

automationScheduleModeEl.addEventListener("change", () => {
  toggleAutomationScheduleFields();
  const scheduleMode = automationScheduleModeEl.value || "interval";

  if (scheduleMode === "interval") {
    setStatus("Pick how many minutes between each run.", "");
  } else if (scheduleMode === "hourly") {
    setStatus("This automation will run every hour.", "");
  } else if (scheduleMode === "daily_morning") {
    setStatus("This automation will run every day at 9:00.", "");
  } else if (scheduleMode === "daily_evening") {
    setStatus("This automation will run every day at 18:00.", "");
  } else if (scheduleMode === "weekdays_morning") {
    setStatus("This automation will run on weekdays at 9:00.", "");
  }
});

createAutomationEl.addEventListener("click", async () => {
  try {
    const job = await createRecurringJob();
    await refreshRecurringJobs();

    if (job.type === "open") {
      automationUrlEl.value = "";
    }

    setStatus("Automation saved.", "success");
    setActiveView("automation");
  } catch (error) {
    setStatus(error.message || "Couldn't save this automation.", "error");
  }
});

refreshJobsEl.addEventListener("click", async () => {
  await refreshRecurringJobs();
});

refreshHistoryEl.addEventListener("click", async () => {
  await refreshActionHistory();
});

jobsListEl.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;
  const jobId = actionTarget.dataset.id;

  if (!jobId) {
    return;
  }

  if (action === "remove-job") {
    try {
      await removeRecurringJob(jobId);
      setStatus("Automation removed.", "success");
      await refreshRecurringJobs();
    } catch (error) {
      setStatus(error.message || "Couldn't remove this automation.", "error");
    }
    return;
  }

  if (action === "copy-job-url") {
    const url = actionTarget.dataset.url;
    if (!url) {
      setStatus("This automation has no link to copy.", "error");
      return;
    }

    try {
      await copyText(url);
      setStatus("Automation link copied.", "success");
    } catch (error) {
      setStatus(error.message || "Couldn't copy this link.", "error");
    }
  }
});

historyListEl.addEventListener("click", async (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  if (actionTarget.dataset.action !== "open-history") {
    return;
  }

  event.preventDefault();
  const url = actionTarget.dataset.url;
  if (!url) {
    setStatus("This history item has no link.", "error");
    return;
  }

  try {
    await createTab(url);
    setStatus("Opened from history.", "success");
    window.close();
  } catch (error) {
    setStatus(error.message || "Couldn't open this history link.", "error");
  }
});

setCustomDueDate(new Date(Date.now() + 60 * 60 * 1000));
toggleAutomationFields();
toggleAutomationScheduleFields();
syncIntervalButtons(Number(automationEveryEl.value));
setActiveView("snooze");

Promise.all([refreshSnoozedTabs(), refreshRecurringJobs(), refreshActionHistory()]).catch((error) => {
  setStatus(error.message || "Couldn't load your data.", "error");
});

fillAutomationUrlFromActiveTab().catch(() => {});
