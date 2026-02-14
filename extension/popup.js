const statusEl = document.getElementById("status");
const customDueEl = document.getElementById("customDue");
const customSnoozeEl = document.getElementById("customSnooze");
const confirmationEl = document.getElementById("confirmation");
const confirmationTextEl = document.getElementById("confirmationText");
const snoozedListEl = document.getElementById("snoozedList");
const snoozedCountEl = document.getElementById("snoozedCount");
const emptyStateEl = document.getElementById("emptyState");
const refreshListEl = document.getElementById("refreshList");
const presetButtons = Array.from(document.querySelectorAll("button[data-minutes]"));
const tomorrowButton = document.querySelector('button[data-preset="tomorrow"]');
const adjustButtons = Array.from(document.querySelectorAll("button[data-adjust-minutes]"));
const actionButtons = [
  ...presetButtons,
  ...adjustButtons,
  tomorrowButton,
  refreshListEl,
  customSnoozeEl
].filter(Boolean);

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.className = `status-bar${tone ? ` ${tone}` : ""}`;
}

function setControlsDisabled(disabled) {
  actionButtons.forEach((button) => {
    button.disabled = disabled;
  });
  customDueEl.disabled = disabled;
}

function setConfirmation(message, tone) {
  confirmationEl.classList.remove("hidden", "warning");
  if (tone === "warning") {
    confirmationEl.classList.add("warning");
  }
  confirmationTextEl.textContent = message;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
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
    throw new Error((result && result.error) || "Could not remove snoozed tab");
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
  snoozedListEl.innerHTML = "";

  if (!items.length) {
    snoozedCountEl.textContent = "0 pending";
    emptyStateEl.classList.remove("hidden");
    return;
  }

  emptyStateEl.classList.add("hidden");
  snoozedCountEl.textContent = `${items.length} pending`;

  items.forEach((item) => {
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
      throw new Error((result && result.error) || "Could not load snoozed tabs");
    }
    renderSnoozedTabs(result.items);
  } catch (error) {
    setStatus(error.message || "Could not load snoozed tabs", "error");
  }
}

async function snoozeAt(dueAtIso) {
  setStatus("Saving snooze...", "");
  setControlsDisabled(true);

  try {
    const result = await sendMessage({ type: "SNOOZE_ACTIVE_TAB", dueAt: dueAtIso });

    if (!result || !result.ok) {
      throw new Error((result && result.error) || "Failed to snooze tab");
    }

    const dueLabel = formatDateTime(result.item.dueAt);
    const baseMessage = `Saved "${trimTitle(result.item.title)}" until ${dueLabel}.`;
    if (result.helperQueued) {
      setConfirmation(`${baseMessage} Markdown sync is queued and will retry.`, "warning");
      setStatus("Saved locally. Waiting for helper sync.", "success");
    } else {
      setConfirmation(`${baseMessage} Logged to markdown.`, "success");
      setStatus("Snooze saved and synced.", "success");
    }
    await refreshSnoozedTabs();
  } catch (error) {
    setStatus(error.message || "Failed to snooze tab", "error");
  } finally {
    setControlsDisabled(false);
  }
}

presetButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const minutes = Number(button.dataset.minutes);

    if (!Number.isFinite(minutes) || minutes <= 0) {
      setStatus("Invalid preset value.", "error");
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
    setStatus("Choose custom date/time first.", "error");
    return;
  }

  await snoozeAt(dueAt.toISOString());
});

adjustButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const deltaMinutes = Number(button.dataset.adjustMinutes);
    if (!Number.isFinite(deltaMinutes) || deltaMinutes === 0) {
      setStatus("Invalid time adjustment.", "error");
      return;
    }
    adjustCustomDueByMinutes(deltaMinutes);
  });
});

refreshListEl.addEventListener("click", async () => {
  await refreshSnoozedTabs();
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
      setStatus("Removed snoozed tab.", "success");
      await refreshSnoozedTabs();
    } catch (error) {
      setStatus(error.message || "Could not remove snoozed tab", "error");
    }
    return;
  }

  if (action === "open") {
    event.preventDefault();
    const url = actionTarget.dataset.url;
    if (!url) {
      setStatus("Missing tab URL.", "error");
      return;
    }

    try {
      await removeSnoozedTab(itemId);
      await createTab(url);
      setStatus("Opened tab and removed snooze.", "success");
      await refreshSnoozedTabs();
      window.close();
    } catch (error) {
      setStatus(error.message || "Could not open snoozed tab", "error");
    }
  }
});

setCustomDueDate(new Date(Date.now() + 60 * 60 * 1000));
refreshSnoozedTabs().catch((error) => {
  setStatus(error.message || "Could not load snoozed tabs", "error");
});
