"use strict";

const SECRET_KEY = /token|password|secret|pin|auth|cookie|jwt|credential|authorization/i;
const MAX_STRING = 800;
const MAX_JSON = 12000;
const MAX_ARRAY = 40;
const MAX_DEPTH = 8;

function nameFromUrl(url) {
  const raw = String(url || "");
  if (/getVehicleChargingMetrics/i.test(raw)) {
    return "getEVChargingMetrics";
  }
  if (/performVehicleChargingMetricsQuery/i.test(raw)) {
    return "refreshEVChargingMetrics";
  }
  if (/initSession/i.test(raw)) {
    return "initEVSession";
  }
  if (/healthstatus/i.test(raw)) {
    return "diagnostics";
  }
  if (/digitaltwin/i.test(raw)) {
    return "location";
  }
  if (/garage/i.test(raw)) {
    return "getVehicleDetails";
  }
  if (/oauth|openid|token/i.test(raw)) {
    return "auth";
  }
  try {
    const path = new URL(raw).pathname;
    return path.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("/") || raw;
  } catch (err) {
    return raw.slice(-80) || "request";
  }
}

function redact(value, depth = 0) {
  if (value == null) {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return "[…]";
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(child, depth + 1);
  }
  return out;
}

function stringifyBody(body) {
  if (body == null || body === "") {
    return "";
  }
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return stringifyBody(JSON.parse(trimmed));
    } catch (err) {
      return trimmed.length > MAX_JSON ? `${trimmed.slice(0, MAX_JSON)}…` : trimmed;
    }
  }
  try {
    const text = JSON.stringify(redact(body), null, 2);
    return text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}\n…` : text;
  } catch (err) {
    return String(body).slice(0, MAX_JSON);
  }
}

function entryFromAxios(response, error) {
  const res = response || error?.response || null;
  const config = res?.config || error?.config || {};
  const url = res?.config?.url || config.url || error?.config?.url || "";
  const method = String(config.method || (url ? "get" : "") || "").toUpperCase();
  const status = Number(res?.status);
  return {
    name: nameFromUrl(url),
    method: method || null,
    url: url || null,
    status: Number.isFinite(status) && status > 0 ? status : error ? "error" : null,
    ok: Number.isFinite(status) ? status >= 200 && status < 400 : false,
    skipped: false,
    error: error && !res ? String(error.message || error) : null,
    body: stringifyBody(res?.data)
  };
}

function skipped(name, reason) {
  return {
    name,
    method: null,
    url: null,
    status: "skip",
    ok: false,
    skipped: true,
    reason: reason || "skipped",
    body: ""
  };
}

function skippedFromPlan(plan) {
  if (!plan) {
    return [];
  }
  const skips = Array.isArray(plan.skips) ? plan.skips : [];
  const out = [];
  if (!plan.diagnostics) {
    out.push(skipped("diagnostics", skips.find((s) => s.startsWith("diagnostics")) || "skipped"));
  }
  if (!plan.location) {
    out.push(skipped("location", skips.find((s) => s.startsWith("location")) || "skipped"));
  }
  if (!plan.details) {
    out.push(skipped("getVehicleDetails", skips.find((s) => s.startsWith("details")) || "skipped"));
  }
  const forceSkip = skips.find((s) => s.startsWith("forceEV"));
  if (forceSkip) {
    out.push(skipped("refreshEVChargingMetrics", forceSkip));
  }
  return out;
}

let active = null;

function begin(enabled) {
  active = enabled ? [] : null;
}

function recordAxios(response, error) {
  if (!active) {
    return;
  }
  active.push(entryFromAxios(response, error));
}

function recordSkipped(name, reason) {
  if (!active) {
    return;
  }
  active.push(skipped(name, reason));
}

function take() {
  const out = active;
  active = null;
  return out || [];
}

function isRecording() {
  return Array.isArray(active);
}

function formatApiCallLog(call) {
  if (!call) {
    return "";
  }
  const status = call.skipped
    ? `skip:${call.reason || "skipped"}`
    : call.status != null
      ? call.status
      : call.error || "error";
  const head = `api ${call.method || "-"} ${call.name || "request"} ${status}`;
  if (call.body) {
    return `${head}\n${call.body}`;
  }
  return head;
}

module.exports = {
  nameFromUrl,
  redact,
  stringifyBody,
  entryFromAxios,
  skipped,
  skippedFromPlan,
  begin,
  recordAxios,
  recordSkipped,
  take,
  isRecording,
  formatApiCallLog
};
