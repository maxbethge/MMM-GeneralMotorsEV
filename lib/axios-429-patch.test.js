"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { apply, attachRetryAfter } = require("./axios-429-patch");
const { extractThrottle } = require("./throttle");
const { begin, take } = require("./api-trace");

describe("attachRetryAfter", () => {
  it("copies Retry-After from axios headers onto the body", () => {
    const err = {
      response: {
        status: 429,
        headers: { "Retry-After": "180" },
        data: { message: "Too Many Requests" }
      }
    };
    attachRetryAfter(err);
    assert.equal(err.gmvRetryAfter, "180");
    assert.equal(err.response.data.retryAfter, "180");
    const throttle = extractThrottle({
      message: "Request Failed with status 429 - Too Many Requests",
      getResponse() {
        return { status: 429, data: err.response.data };
      }
    });
    assert.equal(throttle.waitMs, 180000);
    assert.equal(throttle.retryAfter, "180");
  });

  it("does not overwrite an existing body retryAfter", () => {
    const err = {
      response: {
        status: 429,
        headers: { "retry-after": "60" },
        data: { retryAfter: 240 }
      }
    };
    attachRetryAfter(err);
    assert.equal(err.response.data.retryAfter, 240);
  });

  it("keeps RateLimit headers on the body when Retry-After is absent", () => {
    const err = {
      response: {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "X-RateLimit-Reset": "1700000120",
          "X-RateLimit-Remaining": "0"
        },
        data: { message: "Too Many Requests" }
      }
    };
    attachRetryAfter(err);
    assert.equal(err.gmvRetryAfter, null);
    assert.equal(err.response.data.gmvRateLimit.headers["x-ratelimit-reset"], "1700000120");
    assert.equal(err.response.data.gmvRateLimit.headers["x-ratelimit-remaining"], "0");
    const throttle = extractThrottle({
      message: "Request Failed with status 429 - Too Many Requests",
      getResponse() {
        return { status: 429, data: err.response.data };
      }
    }, 1_700_000_000_000);
    assert.equal(throttle.waitMs, 120000);
  });
});

describe("axios interceptors", () => {
  it("records status and JSON when the debug collector is active", async () => {
    apply();
    begin(true);
    const client = axios.create({
      adapter: (config) =>
        Promise.resolve({
          data: { soc: 61.4 },
          status: 200,
          statusText: "OK",
          headers: {},
          config: { ...config, url: "https://example/getVehicleChargingMetrics", method: "get" },
          request: {}
        })
    });
    await client.get("https://example/getVehicleChargingMetrics");
    const entries = take();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "getEVChargingMetrics");
    assert.equal(entries[0].status, 200);
    assert.match(entries[0].body, /61\.4/);
  });

  it("records error responses", async () => {
    apply();
    begin(true);
    const client = axios.create({
      adapter: (config) =>
        Promise.reject({
          message: "Request Failed with status 400",
          config,
          response: {
            status: 400,
            data: { message: "Bad Request" },
            config: { ...config, url: "https://x/performVehicleChargingMetricsQuery", method: "post" }
          }
        })
    });
    await assert.rejects(() => client.post("https://x/performVehicleChargingMetricsQuery"));
    const entries = take();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "refreshEVChargingMetrics");
    assert.equal(entries[0].status, 400);
  });
});
