"use strict";

/**
 * onstarjs2 deletes ./temp-browser-profile with fs.rmSync({ recursive, force })
 * and no retries. On Raspberry Pi / Linux that throws ENOTEMPTY when Chromium
 * still has files open (auth retry, or two vehicle instances logging in at once).
 * Patch fs.rmSync before requiring onstarjs2.
 */

const fs = require("fs");
const path = require("path");

function isBrowserProfile(target) {
  return String(target || "").replace(/\\/g, "/").includes("temp-browser-profile");
}

function wrapRmSync(original, fsApi) {
  const io = fsApi || fs;
  return function patchedRmSync(target, options) {
    const opts = Object.assign({}, options || {});
    if (isBrowserProfile(target)) {
      if (opts.maxRetries == null) {
        opts.maxRetries = 10;
      }
      if (opts.retryDelay == null) {
        opts.retryDelay = 200;
      }
      opts.recursive = true;
      opts.force = true;
    }
    try {
      return original.call(io, target, opts);
    } catch (err) {
      if (!isBrowserProfile(target)) {
        throw err;
      }
      const code = err && err.code;
      if (!["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(code)) {
        throw err;
      }
      const backup = `${String(target).replace(/[\\/]+$/, "")}.stale-${process.pid}-${Date.now()}`;
      try {
        io.renameSync(target, backup);
      } catch (renameErr) {
        // Leave the folder in place; launchPersistentContext can reuse it.
      }
    }
  };
}

function apply() {
  if (!fs.rmSync || fs.rmSync.__gmvPatched) {
    return fs.rmSync;
  }
  const patched = wrapRmSync(fs.rmSync);
  patched.__gmvPatched = true;
  fs.rmSync = patched;
  return patched;
}

function cleanupBrowserProfile() {
  apply();
  const dir = path.resolve(process.cwd(), "temp-browser-profile");
  if (!fs.existsSync(dir)) {
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    // apply() already swallows ENOTEMPTY after rename; ignore leftovers
  }
}

module.exports = { apply, wrapRmSync, isBrowserProfile, cleanupBrowserProfile };
