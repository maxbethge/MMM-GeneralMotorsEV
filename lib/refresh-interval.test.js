"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { refreshIntervalMs, formatDuration, settledLabel, shouldForceRefreshEV, DEFAULT_MS, MIN_MS } = require("./refresh-interval");

describe("refreshIntervalMs", () => {
  it("defaults invalid values to 15 minutes", () => {
    assert.equal(refreshIntervalMs(undefined), DEFAULT_MS);
    assert.equal(refreshIntervalMs(0), DEFAULT_MS);
    assert.equal(refreshIntervalMs("nope"), DEFAULT_MS);
  });

  it("treats small numbers as seconds", () => {
    assert.equal(refreshIntervalMs(900), 900 * 1000);
    assert.equal(refreshIntervalMs("300"), 300 * 1000);
    assert.equal(refreshIntervalMs(60), MIN_MS);
  });

  it("clamps intervals below 60 seconds", () => {
    assert.equal(refreshIntervalMs(15), MIN_MS);
    assert.equal(refreshIntervalMs(1), MIN_MS);
  });

  it("treats 60000+ as milliseconds", () => {
    assert.equal(refreshIntervalMs(60000), 60000);
    assert.equal(refreshIntervalMs(900000), 900000);
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    assert.equal(formatDuration(15000), "15s");
    assert.equal(formatDuration(900000), "15m");
    assert.equal(formatDuration(90000), "1m 30s");
  });
});

describe("shouldForceRefreshEV", () => {
  it("is off when force refresh is disabled", () => {
    assert.equal(shouldForceRefreshEV(false, null, 3600000), false);
  });

  it("runs the first time, then waits for the interval", () => {
    const now = 1_000_000;
    assert.equal(shouldForceRefreshEV(true, null, 3600000, now), true);
    assert.equal(shouldForceRefreshEV(true, now, 3600000, now + 900000), false);
    assert.equal(shouldForceRefreshEV(true, now, 3600000, now + 3600000), true);
  });
});

describe("settledLabel", () => {
  it("labels fulfilled and rejected results", () => {
    assert.equal(settledLabel({ status: "fulfilled", value: {} }), "ok");
    assert.equal(settledLabel({ status: "rejected", reason: new Error("Access Denied") }), "fail:Access Denied");
    assert.equal(settledLabel(null), "skip");
  });
});
