"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { demoForVin } = require("./demo-data");

describe("demoForVin", () => {
  it("stamps a fresh lastUpdated on each poll", async () => {
    const first = demoForVin("bolt", "Bolt");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = demoForVin("bolt", "Bolt");
    assert.notEqual(first.lastUpdated, second.lastUpdated);
    assert.ok(Date.parse(second.lastUpdated) >= Date.parse(first.lastUpdated));
  });
});
