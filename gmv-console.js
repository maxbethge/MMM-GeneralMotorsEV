"use strict";

/**
 * MagicMirror's logger tags console output from the caller's folder, but skips
 * any stack frame under node_modules — so onstarjs2 logs show as [unknown].
 * Re-emit those lines from this file so the tag becomes [MMM-GeneralMotorsEV].
 * The console wrapper itself is eval'd with sourceURL node:gmv-console so it
 * is skipped the same way js/logger.js is, and other modules keep their names.
 */

function isOnStarConsoleStack(stack) {
  return /[/\\]onstarjs2[/\\]/.test(String(stack || ""));
}

function apply() {
  if (console.error && console.error.__gmvTagged) {
    return;
  }

  const orig = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function emit(method, args) {
    orig[method](...args);
  }

  const install = eval(
    "(function (orig, emit, isOnStarConsoleStack) {\n" +
      "  for (const method of Object.keys(orig)) {\n" +
      "    const fn = function (...args) {\n" +
      "      const stack = new Error().stack || \"\";\n" +
      "      if (isOnStarConsoleStack(stack)) {\n" +
      "        return emit(method, args);\n" +
      "      }\n" +
      "      return orig[method](...args);\n" +
      "    };\n" +
      "    Object.defineProperty(fn, \"__gmvTagged\", { value: true });\n" +
      "    console[method] = fn;\n" +
      "  }\n" +
      "})\n//# sourceURL=node:gmv-console\n"
  );

  install(orig, emit, isOnStarConsoleStack);
}

module.exports = { apply, isOnStarConsoleStack };
