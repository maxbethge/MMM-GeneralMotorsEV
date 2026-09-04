"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseRetryAfter, extractThrottle, throttleFromSettled, nextDelayMs, formatThrottle } = require("./throttle");

describe("parseRetryAfter", () => {
  it("treats small numbers as seconds", () => {
    assert.equal(parseRetryAfter(120), 120000);
    assert.equal(parseRetryAfter("90"), 90000);
  });

  it("treats unix timestamps as an absolute wait", () => {
    const now = 1_700_000_000_000;
    assert.equal(parseRetryAfter(1_700_000_030, now), 30000);
  });

  it("parses HTTP dates", () => {
    const now = Date.parse("Wed, 03 Sep 2026 20:00:00 GMT");
    const wait = parseRetryAfter("Wed, 03 Sep 2026 20:02:00 GMT", now);
    assert.equal(wait, 120000);
  });
});

describe("extractThrottle", () => {
  it("reads Retry-After and quota headers from a 429", () => {
    const err = {
      message: "Request Failed with status 429 - Too Many Requests",
      getResponse() {
        return {
          status: 429,
          headers: {
            "Retry-After": "180",
            "X-RateLimit-Limit": "100",
            "X-RateLimit-Remaining": "0"
          }
        };
      }
    };
    const throttle = extractThrottle(err);
    assert.equal(throttle.status, 429);
    assert.equal(throttle.waitMs, 180000);
    assert.equal(throttle.limit, 100);
    assert.equal(throttle.remaining, 0);
  });

  it("reads retryAfter from a JSON body when headers were stripped", () => {
    const err = {
      getResponse() {
        return {
          status: 429,
          data: { retryAfter: 45, remaining: 0, quota: 50 }
        };
      }
    };
    const throttle = extractThrottle(err);
    assert.equal(throttle.waitMs, 45000);
    assert.equal(throttle.remaining, 0);
    assert.equal(throttle.limit, 50);
  });

  it("reads nested error.retryAfter used by GM-style bodies", () => {
    const err = {
      message: "Request Failed with status 429 - Too Many Requests",
      getResponse() {
        return {
          status: 429,
          data: { error: { retryAfterSeconds: 90, remaining: 0, limit: 20 } }
        };
      }
    };
    const throttle = extractThrottle(err);
    assert.equal(throttle.waitMs, 90000);
    assert.equal(throttle.remaining, 0);
    assert.equal(throttle.limit, 20);
  });

  it("keeps axios Retry-After headers even if getResponse stripped them", () => {
    const err = {
      message: "Request Failed with status 429 - Too Many Requests",
      getResponse() {
        return { status: 429, statusText: "Too Many Requests", data: {} };
      },
      response: {
        status: 429,
        headers: {
          "Retry-After": "120",
          "X-RateLimit-Limit": "80",
          "X-RateLimit-Remaining": "0"
        }
      }
    };
    const throttle = extractThrottle(err);
    assert.equal(throttle.waitMs, 120000);
    assert.equal(throttle.remaining, 0);
    assert.equal(throttle.limit, 80);
  });

  it("uses RateLimit-Reset as a wait when Retry-After is missing", () => {
    const now = 1_700_000_000_000;
    const err = {
      getResponse() {
        return {
          status: 429,
          headers: { "RateLimit-Reset": String(1_700_000_000 + 600) }
        };
      }
    };
    const throttle = extractThrottle(err, now);
    assert.equal(throttle.waitMs, 600000);
  });

  it("reads gmvRetryAfter copied from axios headers", () => {
    const throttle = extractThrottle({
      message: "Request Failed with status 429 - Too Many Requests",
      gmvRetryAfter: "90",
      getResponse() {
        return { status: 429, data: {} };
      }
    });
    assert.equal(throttle.waitMs, 90000);
    assert.equal(throttle.retryAfter, "90");
  });
});

describe("throttleFromSettled", () => {
  it("finds a 429 among settled results", () => {
    const throttle = throttleFromSettled([
      { status: "fulfilled", value: {} },
      { status: "rejected", reason: { message: "Request Failed with status 429", getResponse: () => ({ status: 429, headers: { "retry-after": "10" } }) } }
    ]);
    assert.equal(throttle.waitMs, 10000);
  });

  it("uses the longest Retry-After among rejected calls", () => {
    const throttle = throttleFromSettled([
      { status: "rejected", reason: { getResponse: () => ({ status: 429, headers: { "retry-after": "10" } }) } },
      { status: "rejected", reason: { getResponse: () => ({ status: 429, headers: { "retry-after": "180" } }) } }
    ]);
    assert.equal(throttle.waitMs, 180000);
  });
});

describe("nextDelayMs", () => {
  it("uses the longer of the refresh interval and Retry-After", () => {
    assert.equal(nextDelayMs(900000, { waitMs: 120000 }), 900000);
    assert.equal(nextDelayMs(900000, { waitMs: 1800000 }), 1800000);
    assert.equal(nextDelayMs(900000, null), 900000);
  });

  it("backs off to 2x refresh when a 429 has no Retry-After", () => {
    assert.equal(nextDelayMs(900000, { status: 429 }), 1800000);
    assert.equal(nextDelayMs(900000, { status: 429, waitMs: null }), 1800000);
  });
});

describe("formatThrottle", () => {
  it("includes quota and retry-after", () => {
    const text = formatThrottle({
      status: 429,
      retryAfter: "180",
      waitMs: 180000,
      remaining: 0,
      limit: 100
    });
    assert.match(text, /status=429/);
    assert.match(text, /retry-after=180/);
    assert.match(text, /wait=3m/);
    assert.match(text, /quota=0\/100/);
  });

  it("marks a missing Retry-After on 429", () => {
    assert.match(formatThrottle({ status: 429 }), /retry-after=missing/);
  });
});
