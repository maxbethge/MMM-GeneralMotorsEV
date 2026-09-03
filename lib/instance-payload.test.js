"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { payloadIsForInstance, wantsRangeDisplay } = require("./instance-payload");

describe("payloadIsForInstance", () => {
  it("accepts a matching identifier", () => {
    assert.equal(
      payloadIsForInstance({ identifier: "mod_1" }, { identifier: "mod_1", vin: "AAA" }),
      true
    );
  });

  it("rejects a different identifier even if VIN matches", () => {
    assert.equal(
      payloadIsForInstance(
        { identifier: "mod_2", vin: "AAA" },
        { identifier: "mod_1", vin: "AAA" }
      ),
      false
    );
  });

  it("rejects a different VIN even if identifier matches", () => {
    assert.equal(
      payloadIsForInstance(
        { identifier: "mod_1", vin: "BBB", vehicle: { vin: "BBB" } },
        { identifier: "mod_1", vin: "AAA" }
      ),
      false
    );
  });

  it("accepts VIN match when identifiers are missing", () => {
    assert.equal(
      payloadIsForInstance({ vin: "aaa" }, { vin: "AAA" }),
      true
    );
  });
});

describe("wantsRangeDisplay", () => {
  it("treats range as range mode", () => {
    assert.equal(wantsRangeDisplay("range"), true);
    assert.equal(wantsRangeDisplay("Range"), true);
  });

  it("treats percent as SOC mode", () => {
    assert.equal(wantsRangeDisplay("%"), false);
    assert.equal(wantsRangeDisplay("soc"), false);
  });
});
