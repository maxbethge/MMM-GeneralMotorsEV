"use strict";

const MIN_MS = 60 * 1000;
const DEFAULT_MS = 900 * 1000;

/**
 * Convert config.refreshInterval to milliseconds.
 * Values below 60_000 are treated as seconds (900 → 15 min).
 * Values of 60_000 or more are treated as milliseconds (MagicMirror-style).
 */
function refreshIntervalMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_MS;
  }
  const asMs = n >= MIN_MS ? n : n * 1000;
  return Math.max(MIN_MS, Math.round(asMs));
}

function formatDuration(ms) {
  const sec = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(sec) || sec < 0) {
    return "?";
  }
  if (sec < 60) {
    return `${sec}s`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) {
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function shouldForceRefreshEV(enabled, lastAt, intervalMs, now = Date.now()) {
  if (!enabled) {
    return false;
  }
  if (!lastAt) {
    return true;
  }
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval <= 0) {
    return true;
  }
  return now - Number(lastAt) >= interval;
}

function settledLabel(result) {
  if (!result) {
    return "skip";
  }
  if (result.status === "fulfilled") {
    return "ok";
  }
  const reason = result.reason;
  const message = reason && (reason.message || String(reason));
  const short = String(message || "error").replace(/\s+/g, " ").slice(0, 80);
  return `fail:${short}`;
}

module.exports = { refreshIntervalMs, formatDuration, settledLabel, shouldForceRefreshEV, MIN_MS, DEFAULT_MS };
