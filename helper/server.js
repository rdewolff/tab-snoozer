"use strict";

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const HOST = "127.0.0.1";
const PORT = Number(process.env.TAB_SNOOZER_PORT || 17333);
const MAX_BODY_SIZE = 64 * 1024;
const MARKDOWN_PATH = resolveMarkdownPath(process.env.TAB_SNOOZER_MD_PATH || "~/TODO.md");

function resolveMarkdownPath(inputPath) {
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return path.resolve(inputPath);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_SIZE) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON payload"));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function validateCommonPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return "Request body must be a JSON object";
  }

  if (typeof payload.id !== "string" || payload.id.trim() === "") {
    return "Field 'id' is required";
  }

  if (typeof payload.url !== "string" || payload.url.trim() === "") {
    return "Field 'url' is required";
  }

  try {
    // Basic URL validation.
    new URL(payload.url);
  } catch (error) {
    return "Field 'url' must be a valid URL";
  }

  if (typeof payload.title !== "string" || payload.title.trim() === "") {
    return "Field 'title' is required";
  }

  return null;
}

function validatePayload(type, payload) {
  const commonError = validateCommonPayload(payload);
  if (commonError) {
    return commonError;
  }

  if (type === "snoozed") {
    if (typeof payload.dueAt !== "string" || Number.isNaN(Date.parse(payload.dueAt))) {
      return "Field 'dueAt' is required and must be an ISO date";
    }
  }

  return null;
}

function buildMarkdownLine(type, payload) {
  const eventAt = sanitizeText(payload.eventAt || new Date().toISOString());
  const title = sanitizeText(payload.title) || sanitizeText(payload.url);
  const url = sanitizeText(payload.url);
  const id = sanitizeText(payload.id);

  if (type === "snoozed") {
    const dueAt = sanitizeText(payload.dueAt);
    return `- [ ] ${eventAt} | Snoozed | [${title}](${url}) | id=${id} | due=${dueAt}`;
  }

  return `- [x] ${eventAt} | Reopened | [${title}](${url}) | id=${id}`;
}

async function appendMarkdownLine(line) {
  await fs.mkdir(path.dirname(MARKDOWN_PATH), { recursive: true });
  await fs.appendFile(MARKDOWN_PATH, `${line}\n`, "utf8");
}

async function handleEvent(req, res, type) {
  try {
    const payload = await readJsonBody(req);
    const validationError = validatePayload(type, payload);

    if (validationError) {
      sendJson(res, 400, { ok: false, error: validationError });
      return;
    }

    const line = buildMarkdownLine(type, payload);
    await appendMarkdownLine(line);

    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error && error.message ? error.message : "Internal server error"
    });
  }
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "";
  const url = req.url || "";

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, { ok: true, markdownPath: MARKDOWN_PATH });
    return;
  }

  if (method === "POST" && url === "/snooze") {
    await handleEvent(req, res, "snoozed");
    return;
  }

  if (method === "POST" && url === "/reopened") {
    await handleEvent(req, res, "reopened");
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Tab Snoozer helper listening on http://${HOST}:${PORT}`);
  console.log(`Markdown log file: ${MARKDOWN_PATH}`);
});

process.on("SIGINT", () => {
  server.close(() => {
    process.exit(0);
  });
});
