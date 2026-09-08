"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { httpStatus, errorBodyPreview, shouldFallbackEvRefresh } = require("./http-error");

describe("httpStatus", () => {
  it("reads RequestError getResponse status", () => {
    assert.equal(
      httpStatus({
        message: "Request Failed with status 400 - Bad Request",
        getResponse: () => ({ status: 400, data: { message: "nope" } })
      }),
      400
    );
  });

  it("parses status from the error message", () => {
    assert.equal(httpStatus(new Error("Request Failed with status 400 - Bad Request")), 400);
  });
});

describe("errorBodyPreview", () => {
  it("flattens a JSON body", () => {
    const text = errorBodyPreview({
      getResponse: () => ({ status: 400, data: { error: "vehicle telemetry not supported" } })
    });
    assert.match(text, /telemetry not supported/);
  });
});

describe("shouldFallbackEvRefresh", () => {
  it("falls back on 400 Bad Request", () => {
    assert.equal(shouldFallbackEvRefresh({ getResponse: () => ({ status: 400 }) }), true);
    assert.equal(shouldFallbackEvRefresh({ getResponse: () => ({ status: 429 }) }), false);
    assert.equal(shouldFallbackEvRefresh({ getResponse: () => ({ status: 500 }) }), false);
  });
});
