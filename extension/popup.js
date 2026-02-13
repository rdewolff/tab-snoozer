const statusEl = document.getElementById("status");
const customDueEl = document.getElementById("customDue");
const customSnoozeEl = document.getElementById("customSnooze");

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.className = tone || "";
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

async function snoozeAt(dueAtIso) {
  setStatus("Saving snooze...", "");

  try {
    const result = await sendMessage({ type: "SNOOZE_ACTIVE_TAB", dueAt: dueAtIso });

    if (!result || !result.ok) {
      throw new Error((result && result.error) || "Failed to snooze tab");
    }

    const dueLabel = new Date(result.item.dueAt).toLocaleString();
    setStatus(`Snoozed until ${dueLabel}`, "success");
  } catch (error) {
    setStatus(error.message || "Failed to snooze tab", "error");
  }
}

document.querySelectorAll("button[data-minutes]").forEach((button) => {
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

const tomorrowButton = document.querySelector('button[data-preset="tomorrow"]');
tomorrowButton.addEventListener("click", async () => {
  await snoozeAt(tomorrowAtNineAM());
});

customSnoozeEl.addEventListener("click", async () => {
  if (!customDueEl.value) {
    setStatus("Choose custom date/time first.", "error");
    return;
  }

  const dueAt = new Date(customDueEl.value);

  if (Number.isNaN(dueAt.getTime())) {
    setStatus("Invalid custom date/time.", "error");
    return;
  }

  await snoozeAt(dueAt.toISOString());
});

const minDate = new Date(Date.now() + 5 * 60 * 1000);
customDueEl.min = toInputDateTimeValue(minDate);
customDueEl.value = toInputDateTimeValue(new Date(Date.now() + 60 * 60 * 1000));
