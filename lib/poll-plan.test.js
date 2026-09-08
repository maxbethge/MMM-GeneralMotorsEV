"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isVehicleAsleep, asleepRefreshMs, planPoll, pollDelayMs, MIN_ASLEEP_MS } = require("./poll-plan");
const { nextDelayMs } = require("./throttle");

const parked = {
  ignition: "off",
  pluggedIn: false,
  charging: false,
  latitude: 42.3,
  longitude: -83.7,
  make: "GMC",
  model: "Sierra EV"
};

describe("isVehicleAsleep", () => {
  it("is asleep when parked and unplugged", () => {
    assert.equal(isVehicleAsleep(parked), true);
  });

  it("is awake when charging, plugged in, or ignition is on", () => {
    assert.equal(isVehicleAsleep({ ...parked, charging: true }), false);
    assert.equal(isVehicleAsleep({ ...parked, pluggedIn: true }), false);
    assert.equal(isVehicleAsleep({ ...parked, ignition: "ON" }), false);
  });

  it("is not asleep before any vehicle data exists", () => {
    assert.equal(isVehicleAsleep(null), false);
  });
});

describe("asleepRefreshMs", () => {
  it("defaults to at least 30 minutes and 2x the awake interval", () => {
    assert.equal(asleepRefreshMs(15 * 60 * 1000), 30 * 60 * 1000);
    assert.equal(asleepRefreshMs(45 * 60 * 1000), 90 * 60 * 1000);
    assert.equal(asleepRefreshMs(15 * 60 * 1000, 3600), 3600 * 1000);
  });
});

describe("planPoll", () => {
  const now = 1_700_000_000_000;
  const refreshMs = 15 * 60 * 1000;

  it("fetches EV and diagnostics on the first parked poll, skips location and details when cached", () => {
    const plan = planPoll({ vehicle: parked, now, refreshMs });
    assert.equal(plan.asleep, true);
    assert.equal(plan.ev, true);
    assert.equal(plan.diagnostics, true);
    assert.equal(plan.location, false);
    assert.equal(plan.details, false);
    assert.ok(plan.skips.includes("location:asleep"));
    assert.ok(plan.skips.includes("details:cached"));
  });

  it("skips diagnostics while asleep if they were fetched recently", () => {
    const plan = planPoll({
      vehicle: parked,
      now,
      refreshMs,
      lastDiagnosticsAt: now - 5 * 60 * 1000
    });
    assert.equal(plan.diagnostics, false);
    assert.ok(plan.skips.includes("diagnostics:asleep"));
  });

  it("does not wake the vehicle with forceRefreshEV while asleep", () => {
    const plan = planPoll({ vehicle: parked, now, refreshMs, forceEV: true });
    assert.equal(plan.forceEV, false);
    assert.ok(plan.skips.includes("forceEV:asleep"));
  });

  it("fetches live location when coordinates are missing", () => {
    const plan = planPoll({
      vehicle: { ignition: "off", pluggedIn: false, charging: false },
      now,
      refreshMs
    });
    assert.equal(plan.location, true);
    assert.equal(plan.details, true);
  });

  it("fetches diagnostics and EV while charging and skips a cached location", () => {
    const plan = planPoll({
      vehicle: { ...parked, charging: true, pluggedIn: true },
      now,
      refreshMs
    });
    assert.equal(plan.asleep, false);
    assert.equal(plan.diagnostics, true);
    assert.equal(plan.ev, true);
    assert.equal(plan.location, false);
    assert.ok(plan.skips.includes("location:cached"));
  });

  it("manual refresh fetches diagnostics and details but not a live location ping", () => {
    const plan = planPoll({
      vehicle: parked,
      now,
      refreshMs,
      lastDiagnosticsAt: now,
      lastDetailsAt: now,
      lastLocationAt: now,
      manual: true
    });
    assert.equal(plan.diagnostics, true);
    assert.equal(plan.location, false);
    assert.equal(plan.details, true);
    assert.equal(plan.ev, true);
  });
});

describe("pollDelayMs", () => {
  it("uses the longer asleep interval while parked", () => {
    const delay = pollDelayMs({
      refreshMs: 15 * 60 * 1000,
      asleep: true,
      throttle: null,
      nextDelayMs
    });
    assert.equal(delay, MIN_ASLEEP_MS);
  });

  it("still honors a 429 wait when asleep", () => {
    const delay = pollDelayMs({
      refreshMs: 15 * 60 * 1000,
      asleep: true,
      throttle: { status: 429, waitMs: 45 * 60 * 1000 },
      nextDelayMs
    });
    assert.equal(delay, 45 * 60 * 1000);
  });
});
