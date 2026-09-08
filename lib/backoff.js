"use strict";

const { extractThrottle } = require("./throttle");

const DEFAULT_RETRIES = 3;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30 * 1000;

function sleep(ms, wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))) {
  return wait(Math.max(0, Number(ms) || 0));
}

/**
 * Spread a delay by ±spread (default 20%) so two vehicles do not retry in lockstep.
 */
function withJitter(ms, spread = 0.2, random = Math.random) {
  const base = Math.max(0, Number(ms) || 0);
  const ratio = Math.max(0, Number(spread) || 0);
  if (base === 0 || ratio === 0) {
    return Math.round(base);
  }
  const delta = base * ratio;
  return Math.max(0, Math.round(base - delta + random() * 2 * delta));
}

function is429Error(err) {
  if (!err) {
    return false;
  }
  const throttle = extractThrottle(err);
  if (Number(throttle?.status) === 429) {
    return true;
  }
  return Number(err.response?.status || err.status) === 429;
}

/**
 * Retry a request on 429 with exponential backoff and jitter.
 * If Retry-After (or equivalent) is longer than maxDelay, do not retry in-loop —
 * the poll scheduler should wait that long instead.
 */
async function fetchWithBackoff(requestFunc, options = {}) {
  const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : DEFAULT_RETRIES;
  const maxDelay = Number.isFinite(Number(options.maxDelay)) ? Number(options.maxDelay) : DEFAULT_MAX_DELAY_MS;
  const sleepFn = options.sleep || sleep;
  const random = options.random || Math.random;
  let delay = Number.isFinite(Number(options.delay)) ? Number(options.delay) : DEFAULT_DELAY_MS;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await requestFunc();
    } catch (error) {
      lastError = error;
      const remaining = retries - attempt;
      if (remaining <= 0 || !is429Error(error)) {
        throw error;
      }
      const throttle = extractThrottle(error);
      const hinted = Number(throttle?.waitMs);
      if (Number.isFinite(hinted) && hinted > maxDelay) {
        throw error;
      }
      const wait = withJitter(
        Number.isFinite(hinted) && hinted > 0 ? Math.min(hinted, maxDelay) : Math.min(delay, maxDelay),
        0.2,
        random
      );
      await sleepFn(wait);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
  throw lastError;
}

module.exports = {
  sleep,
  withJitter,
  is429Error,
  fetchWithBackoff,
  DEFAULT_RETRIES,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_DELAY_MS
};
