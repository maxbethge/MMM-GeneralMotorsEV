"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { wrapRmSync, isBrowserProfile } = require("./onstar-fs-patch");

describe("onstar-fs-patch", () => {
  it("recognizes the Chromium profile path", () => {
    assert.equal(isBrowserProfile("/home/pi/MagicMirror/temp-browser-profile"), true);
    assert.equal(isBrowserProfile("/tmp/other"), false);
  });

  it("does not throw ENOTEMPTY for the browser profile", () => {
    const err = new Error("Directory not empty");
    err.code = "ENOTEMPTY";
    const orig = () => {
      throw err;
    };
    const renamed = [];
    const fakeFs = {
      renameSync(from, to) {
        renamed.push([from, to]);
      }
    };
    const rm = wrapRmSync(orig, fakeFs);
    rm("/home/pi/MagicMirror/temp-browser-profile", { recursive: true, force: true });
    assert.equal(renamed.length, 1);
    assert.match(renamed[0][1], /temp-browser-profile\.stale-/);
  });

  it("still throws for other paths", () => {
    const err = new Error("Directory not empty");
    err.code = "ENOTEMPTY";
    const rm = wrapRmSync(() => {
      throw err;
    });
    assert.throws(() => rm("/tmp/not-the-profile"), (e) => e.code === "ENOTEMPTY");
  });
});
