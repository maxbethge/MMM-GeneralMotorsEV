"use strict";

const { refreshIntervalMs } = require("./refresh-interval");

const DETAILS_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_ASLEEP_MS = 30 * 60 * 1000;

function ignitionOn(vehicle) {
  return String(vehicle?.ignition || "").trim().toUpperCase() === "ON";
}

function hasCoordinates(vehicle) {
  const lat = Number(vehicle?.latitude);
  const lng = Number(vehicle?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function hasVehicleDetails(vehicle) {
  return Boolean(vehicle?.make && (vehicle?.model || vehicle?.year));
}

/**
 * Parked, unplugged, ignition off. Further diagnostics/location/SMS wakes
 * burn quota and GM stops answering after a handful of requests.
 */
function isVehicleAsleep(vehicle) {
  if (!vehicle) {
    return false;
  }
  if (ignitionOn(vehicle) || vehicle.charging || vehicle.pluggedIn) {
    return false;
  }
  return true;
}

function asleepRefreshMs(refreshMs, configured) {
  if (configured != null && configured !== "") {
    return refreshIntervalMs(configured);
  }
  const base = Number(refreshMs);
  const doubled = Number.isFinite(base) && base > 0 ? base * 2 : MIN_ASLEEP_MS;
  return Math.max(doubled, MIN_ASLEEP_MS);
}

function diagnosticsTtlMs(refreshMs) {
  const base = Number(refreshMs);
  const doubled = Number.isFinite(base) && base > 0 ? base * 2 : MIN_ASLEEP_MS;
  return Math.max(doubled, MIN_ASLEEP_MS);
}

function isFresh(timestamp, ttlMs, now) {
  if (!timestamp || !Number.isFinite(Number(ttlMs))) {
    return false;
  }
  return now - Number(timestamp) < Number(ttlMs);
}

/**
 * Choose which OnStar calls to make this cycle. Manual refresh fetches everything.
 */
function planPoll({
  vehicle,
  now = Date.now(),
  refreshMs,
  forceEV = false,
  lastDiagnosticsAt = null,
  lastDetailsAt = null,
  lastLocationAt = null,
  manual = false
} = {}) {
  const asleep = isVehicleAsleep(vehicle);
  const coords = hasCoordinates(vehicle);
  const details = hasVehicleDetails(vehicle);
  const skips = [];

  const calls = {
    diagnostics: true,
    ev: true,
    location: true,
    details: true,
    forceEV: Boolean(forceEV),
    asleep,
    skips
  };

  if (manual) {
    if (hasCoordinates(vehicle)) {
      calls.location = false;
      skips.push("location:cached");
    }
    if (asleep && forceEV) {
      calls.forceEV = false;
      skips.push("forceEV:asleep");
    }
    return calls;
  }

  if (asleep && isFresh(lastDiagnosticsAt, diagnosticsTtlMs(refreshMs), now)) {
    calls.diagnostics = false;
    skips.push("diagnostics:asleep");
  }

  if (coords) {
    calls.location = false;
    skips.push(asleep ? "location:asleep" : "location:cached");
  } else if (isFresh(lastLocationAt, refreshMs, now)) {
    calls.location = false;
    skips.push("location:cached");
  }

  if (details && (lastDetailsAt == null || isFresh(lastDetailsAt, DETAILS_TTL_MS, now))) {
    calls.details = false;
    skips.push("details:cached");
  }

  if (asleep && forceEV) {
    calls.forceEV = false;
    skips.push("forceEV:asleep");
  }

  return calls;
}

function pollDelayMs({ refreshMs, asleepRefresh, asleep, throttle, nextDelayMs }) {
  const base = asleep ? asleepRefreshMs(refreshMs, asleepRefresh) : refreshMs;
  return nextDelayMs(base, throttle);
}

module.exports = {
  ignitionOn,
  hasCoordinates,
  hasVehicleDetails,
  isVehicleAsleep,
  asleepRefreshMs,
  diagnosticsTtlMs,
  planPoll,
  pollDelayMs,
  DETAILS_TTL_MS,
  MIN_ASLEEP_MS
};
