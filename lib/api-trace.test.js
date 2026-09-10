"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  nameFromUrl,
  redact,
  stringifyBody,
  entryFromAxios,
  skippedFromPlan,
  begin,
  recordAxios,
  recordSkipped,
  take,
  formatApiCallLog
} = require("./api-trace");

describe("nameFromUrl", () => {
  it("labels known GM endpoints", () => {
    assert.equal(nameFromUrl("https://eve-vcn.ext.gm.com/api/gmone/v1/vehicle/getVehicleChargingMetrics"), "getEVChargingMetrics");
    assert.equal(nameFromUrl("https://x/healthstatus/VIN"), "diagnostics");
    assert.equal(nameFromUrl("https://x/veh/datadelivery/digitaltwin/v1/vehicles/VIN"), "location");
  });
});

describe("redact", () => {
  it("strips token-like keys", () => {
    const out = redact({ token: "abc", results: [{ loginResponse: { token: "jwt" }, soc: 52 }] });
    assert.equal(out.token, "[redacted]");
    assert.equal(out.results[0].loginResponse.token, "[redacted]");
    assert.equal(out.results[0].soc, 52);
  });
});

describe("entryFromAxios", () => {
  it("captures status and JSON body", () => {
    const entry = entryFromAxios({
      status: 200,
      config: { method: "get", url: "https://example/getVehicleChargingMetrics" },
      data: { success: true, results: [{ soc: 61.4 }] }
    });
    assert.equal(entry.name, "getEVChargingMetrics");
    assert.equal(entry.status, 200);
    assert.equal(entry.ok, true);
    assert.match(entry.body, /"soc": 61.4/);
  });

  it("captures a 400 error response", () => {
    const entry = entryFromAxios(
      {
        status: 400,
        config: { method: "post", url: "https://x/performVehicleChargingMetricsQuery" },
        data: { message: "Bad Request" }
      },
      new Error("Request Failed with status 400 - Bad Request")
    );
    assert.equal(entry.name, "refreshEVChargingMetrics");
    assert.equal(entry.status, 400);
    assert.equal(entry.ok, false);
    assert.match(entry.body, /Bad Request/);
  });
});

describe("skippedFromPlan", () => {
  it("records skipped endpoints from the poll plan", () => {
    const skips = skippedFromPlan({
      diagnostics: false,
      location: false,
      details: false,
      forceEV: false,
      skips: ["diagnostics:asleep", "location:asleep", "details:cached", "forceEV:asleep"]
    });
    assert.equal(skips.length, 4);
    assert.equal(skips[0].status, "skip");
    assert.equal(skips[0].name, "diagnostics");
  });
});

describe("collector", () => {
  it("records only while a debug poll is active", () => {
    begin(false);
    recordAxios({ status: 200, config: { url: "https://x/healthstatus" }, data: {} });
    assert.deepEqual(take(), []);
    begin(true);
    recordAxios({ status: 200, config: { url: "https://x/healthstatus" }, data: { ok: true } });
    recordSkipped("location", "after 429 on ev");
    const entries = take();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "diagnostics");
    assert.equal(entries[1].skipped, true);
    assert.equal(entries[1].reason, "after 429 on ev");
  });
});

describe("formatApiCallLog", () => {
  it("includes status and JSON body", () => {
    const text = formatApiCallLog({
      method: "GET",
      name: "getEVChargingMetrics",
      status: 200,
      body: '{\n  "soc": 61.4\n}'
    });
    assert.match(text, /api GET getEVChargingMetrics 200/);
    assert.match(text, /"soc": 61\.4/);
  });

  it("includes skip reason", () => {
    const text = formatApiCallLog({
      name: "location",
      skipped: true,
      reason: "location:asleep"
    });
    assert.equal(text, "api - location skip:location:asleep");
  });
});
