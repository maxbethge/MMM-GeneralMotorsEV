"use strict";

const { formatDuration } = require("./refresh-interval");

const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
const WAIT_KEYS = ["retryAfter", "retry_after", "retryAfterSeconds", "retry_after_seconds", "wait", "waitSeconds", "retryDelay", "retry_delay"];
const WAIT_MS_KEYS = ["retryAfterMs", "retry_after_ms", "waitMs", "wait_ms"];
const RESET_KEYS = ["reset", "rateLimitReset", "rate_limit_reset", "resetAt", "reset_at"];
const LIMIT_KEYS = ["limit", "quota", "quotaLimit", "rateLimitLimit", "rate_limit_limit"];
const REMAINING_KEYS = ["remaining", "quotaRemaining", "rateLimitRemaining", "rate_limit_remaining"];

function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  if (typeof headers.get === "function") {
    try {
      const got = headers.get(name) ?? headers.get(String(name).toLowerCase());
      if (got != null && got !== "") {
        return Array.isArray(got) ? got[0] : got;
      }
    } catch (err) {
      // AxiosHeaders and Maps are both handled below
    }
  }
  if (typeof headers !== "object") {
    return null;
  }
  const want = String(name).toLowerCase();
  const json = typeof headers.toJSON === "function" ? headers.toJSON() : headers;
  for (const [key, value] of Object.entries(json || {})) {
    if (String(key).toLowerCase() === want) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

function normalizeHeaders(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.toJSON === "function") {
    try {
      return headers.toJSON() || {};
    } catch (err) {
      return {};
    }
  }
  if (typeof headers === "object") {
    return headers;
  }
  return {};
}

function responseFromError(err) {
  if (!err || typeof err !== "object") {
    return { status: null, headers: {}, data: null };
  }
  const wrapped = typeof err.getResponse === "function" ? err.getResponse() : null;
  const axiosResp = err.response || err.cause?.response || null;
  return {
    status: wrapped?.status || axiosResp?.status || err.status || null,
    headers: {
      ...normalizeHeaders(err.headers),
      ...normalizeHeaders(axiosResp?.headers),
      ...normalizeHeaders(wrapped?.headers)
    },
    data: wrapped?.data !== undefined ? wrapped.data : axiosResp?.data !== undefined ? axiosResp.data : err.data
  };
}

function parseRetryAfter(raw, now = Date.now()) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw > 1e12) {
      return Math.max(0, raw - now);
    }
    if (raw > 1e9) {
      return Math.max(0, raw * 1000 - now);
    }
    return Math.max(0, raw * 1000);
  }
  const text = String(raw).trim();
  if (!text) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return parseRetryAfter(Number(text), now);
  }
  const ts = Date.parse(text);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - now);
  }
  return null;
}

function parseQuotaNumber(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function bodyObject(data) {
  if (!data) {
    return {};
  }
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  if (typeof data === "object") {
    return data;
  }
  return {};
}

function pickDeep(obj, keys, depth = 2) {
  if (!obj || typeof obj !== "object" || depth < 0) {
    return undefined;
  }
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") {
      return obj[key];
    }
  }
  for (const child of [obj.error, obj.errors, obj.data, obj.details]) {
    const node = Array.isArray(child) ? child[0] : child;
    const found = pickDeep(node, keys, depth - 1);
    if (found != null) {
      return found;
    }
  }
  return undefined;
}

function looksLikeThrottle(status, err) {
  if (status === 429) {
    return true;
  }
  return /429|too many requests|throttl|rate limit/i.test(String(err?.message || ""));
}

function extractThrottle(err, now = Date.now()) {
  if (!err) {
    return null;
  }
  const response = responseFromError(err);
  const status = response.status || err.status || null;
  const headers = response.headers || {};
  const body = bodyObject(response.data);
  const throttled = looksLikeThrottle(status, err);

  const retryAfterRaw =
    headerValue(headers, "retry-after") ??
    headerValue(headers, "x-retry-after") ??
    (throttled ? pickDeep(body, WAIT_KEYS) : undefined);

  const retryAfterMsRaw = throttled ? pickDeep(body, WAIT_MS_KEYS) : undefined;

  const resetRaw =
    headerValue(headers, "ratelimit-reset") ??
    headerValue(headers, "x-ratelimit-reset") ??
    headerValue(headers, "x-rate-limit-reset") ??
    (throttled ? pickDeep(body, RESET_KEYS) : undefined);

  const limit = parseQuotaNumber(
    headerValue(headers, "ratelimit-limit") ??
      headerValue(headers, "x-ratelimit-limit") ??
      headerValue(headers, "x-rate-limit-limit") ??
      (throttled ? pickDeep(body, LIMIT_KEYS) : undefined)
  );
  const remaining = parseQuotaNumber(
    headerValue(headers, "ratelimit-remaining") ??
      headerValue(headers, "x-ratelimit-remaining") ??
      headerValue(headers, "x-rate-limit-remaining") ??
      (throttled ? pickDeep(body, REMAINING_KEYS) : undefined)
  );

  let waitMs = parseRetryAfter(retryAfterRaw, now);
  if (waitMs === null && retryAfterMsRaw != null) {
    const asMs = Number(retryAfterMsRaw);
    waitMs = Number.isFinite(asMs) ? Math.max(0, asMs) : null;
  }
  if (waitMs === null) {
    waitMs = parseRetryAfter(resetRaw, now);
  }

  if (!throttled && waitMs === null && remaining === null && limit === null) {
    return null;
  }

  if (waitMs !== null) {
    waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.round(waitMs)));
  }

  return {
    status: status || (waitMs !== null ? 429 : null),
    waitMs,
    retryAfter: retryAfterRaw ?? retryAfterMsRaw ?? null,
    reset: resetRaw ?? null,
    limit,
    remaining
  };
}

function throttleFromSettled(results, now = Date.now()) {
  let best = null;
  for (const result of results || []) {
    if (!result || result.status !== "rejected") {
      continue;
    }
    const throttle = extractThrottle(result.reason, now);
    if (!throttle) {
      continue;
    }
    if (!best || (throttle.waitMs || 0) > (best.waitMs || 0)) {
      best = throttle;
    }
  }
  return best;
}

function nextDelayMs(refreshMs, throttle) {
  const base = Number(refreshMs);
  const wait = throttle?.waitMs;
  if (!Number.isFinite(wait) || wait <= 0) {
    return base;
  }
  if (!Number.isFinite(base) || base <= 0) {
    return wait;
  }
  return Math.max(base, wait);
}

function formatThrottle(throttle) {
  if (!throttle) {
    return "";
  }
  const parts = [];
  if (throttle.status) {
    parts.push(`status=${throttle.status}`);
  }
  if (throttle.retryAfter != null && throttle.retryAfter !== "") {
    parts.push(`retry-after=${throttle.retryAfter}`);
  }
  if (throttle.waitMs != null) {
    parts.push(`wait=${formatDuration(throttle.waitMs)}`);
  }
  if (throttle.limit != null || throttle.remaining != null) {
    const remaining = throttle.remaining == null ? "?" : throttle.remaining;
    const limit = throttle.limit == null ? "?" : throttle.limit;
    parts.push(`quota=${remaining}/${limit}`);
  }
  if (throttle.reset != null && throttle.reset !== "") {
    parts.push(`reset=${throttle.reset}`);
  }
  return parts.join(" ");
}

module.exports = {
  headerValue,
  parseRetryAfter,
  extractThrottle,
  throttleFromSettled,
  nextDelayMs,
  formatThrottle,
  MAX_WAIT_MS
};
