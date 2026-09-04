"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { attachRetryAfter } = require("./axios-429-patch");
const { extractThrottle } = require("./throttle");

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
});
