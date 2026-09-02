"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isOnStarConsoleStack } = require("../gmv-console");

describe("gmv-console", () => {
  it("tags onstarjs2 stack frames", () => {
    const stack = "Error\n    at GMAuth.authenticate (/home/pi/MagicMirror/modules/MMM-GeneralMotorsEV/node_modules/onstarjs2/dist/index.cjs:2092:13)";
    assert.equal(isOnStarConsoleStack(stack), true);
  });

  it("does not tag other modules", () => {
    const stack = "Error\n    at calendar (/home/pi/MagicMirror/modules/default/calendar/node_helper.js:10:3)";
    assert.equal(isOnStarConsoleStack(stack), false);
  });
});
