"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { inferPressureUnit, formatTirePressure } = require("./tire-units");

describe("tire-units", () => {
  it("treats kPa-labeled PSI-range values as psi", () => {
    assert.equal(inferPressureUnit([57, 57, 64, 63], "kPa"), "psi");
    assert.equal(formatTirePressure(57, "kPa", true), "57");
    assert.equal(formatTirePressure(64, "kPa", true), "64");
    assert.equal(formatTirePressure(63, "kPa", true), "63");
  });

  it("converts real kPa values to psi when imperial", () => {
    assert.equal(inferPressureUnit([393, 393, 441, 434], "kPa"), "kpa");
    assert.equal(formatTirePressure(393, "kPa", true), "57");
    assert.equal(formatTirePressure(441, "kPa", true), "64");
  });

  it("does not convert psi values already in range", () => {
    assert.equal(formatTirePressure(42, "psi", true), "42");
    assert.equal(inferPressureUnit([42, 41, 40, 39], "psi"), "psi");
  });

  it("converts psi to kPa when metric", () => {
    assert.equal(formatTirePressure(42, "psi", false), "290");
  });

  it("leaves real kPa unchanged when metric", () => {
    assert.equal(formatTirePressure(393, "kPa", false), "393");
  });

  it("treats kPa-labeled PSI values as psi for metric conversion", () => {
    assert.equal(formatTirePressure(57, "kPa", false), "393");
  });
});
