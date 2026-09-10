"use strict";

const NodeHelper = require("node_helper");
const path = require("path");
let Log = console;
try {
  Log = require("logger");
} catch (err) {
  // Running outside MagicMirror
}
const { CredentialStore } = require("./lib/credential-store");
const { apply: patchOnStarFs, cleanupBrowserProfile } = require("./lib/onstar-fs-patch");
const { apply: patchAxios429 } = require("./lib/axios-429-patch");
const { apply: tagOnStarConsole } = require("./gmv-console");
const parser = require("./lib/gm-parser");
const { demoForVin } = require("./lib/demo-data");
const { refreshIntervalMs, formatDuration, settledLabel, shouldForceRefreshEV } = require("./lib/refresh-interval");
const { extractThrottle, throttleFromSettled, nextDelayMs, formatThrottle } = require("./lib/throttle");
const { fetchWithBackoff, is429Error, sleep, withJitter } = require("./lib/backoff");
const { planPoll, pollDelayMs, isVehicleAsleep, hasCoordinates } = require("./lib/poll-plan");
const { httpStatus, errorBodyPreview, shouldFallbackEvRefresh } = require("./lib/http-error");

function tireLog(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : "-";
}

function loadOnStar() {
  try {
    const mod = require("onstarjs2");
    return mod.default || mod.OnStar || mod;
  } catch (err) {
    return null;
  }
}

module.exports = NodeHelper.create({
  requiresVersion: "2.1.0",
  start() {
    this.activeLogLabel = null;
    tagOnStarConsole(() => this.activeLogLabel);
    patchAxios429();
    patchOnStarFs();
    cleanupBrowserProfile();
    this.instances = new Map();
    this.clients = new Map();
    this.pollQueue = Promise.resolve();
    this.store = new CredentialStore(path.join(this.path, "cache"));
    this.OnStar = loadOnStar();
    this.logInfo(`${this.name}: node helper started`);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GMV_CONFIG") {
      this.setupInstance(payload);
    } else if (notification === "GMV_REFRESH") {
      const instance = this.findInstance(payload);
      if (instance) {
        this.logInfo(`${this.label(instance)} manual refresh requested`);
        this.enqueuePoll(instance, { force: true, reason: "manual", forceEV: true }).catch((err) => {
          this.logError(`${this.label(instance)} refresh failed: ${err.message}`);
        });
      } else {
        this.logInfo(`${this.name}: GMV_REFRESH ignored (no instance for ${payload?.identifier || payload?.vin || "?"})`);
      }
    }
  },

  instanceKey(config) {
    const id = String(config?.identifier || "");
    const vin = String(config?.vin || "").trim().toUpperCase();
    return vin ? `${id}::${vin}` : id;
  },

  findInstance(payload) {
    if (!payload) {
      return null;
    }
    const key = this.instanceKey(payload);
    if (key && this.instances.has(key)) {
      return this.instances.get(key);
    }
    if (payload.identifier) {
      for (const instance of this.instances.values()) {
        if (instance.identifier === payload.identifier) {
          return instance;
        }
      }
    }
    const vin = String(payload.vin || "").trim().toUpperCase();
    if (vin) {
      for (const instance of this.instances.values()) {
        if (String(instance.config.vin || "").trim().toUpperCase() === vin) {
          return instance;
        }
      }
    }
    return null;
  },

  label(instance) {
    const config = instance?.config || {};
    const id = instance?.identifier || config.identifier || "?";
    const name = config.displayName || config.vin || "";
    return name ? `${this.name} [${id}] ${name}` : `${this.name} [${id}]`;
  },

  logInfo(message) {
    console.log(message);
  },

  logError(message) {
    console.error(message);
  },

  setupInstance(config) {
    if (!config || !config.identifier) {
      this.logError(`${this.name}: missing identifier in config`);
      return;
    }

    const refreshMs = refreshIntervalMs(config.refreshInterval);
    const forceRefreshMs = config.forceRefreshEV
      ? refreshIntervalMs(config.forceRefreshEVInterval != null && config.forceRefreshEVInterval !== "" ? config.forceRefreshEVInterval : config.refreshInterval)
      : refreshMs;
    const key = this.instanceKey(config);
    const existing = this.instances.get(key);
    if (
      existing &&
      existing.config.vin === config.vin &&
      existing.refreshMs === refreshMs &&
      existing.forceRefreshMs === forceRefreshMs &&
      Boolean(existing.config.demo) === Boolean(config.demo) &&
      Boolean(existing.config.forceRefreshEV) === Boolean(config.forceRefreshEV)
    ) {
      this.logInfo(`${this.label(existing)} already polling every ${formatDuration(refreshMs)} (refreshInterval=${config.refreshInterval})`);
      if (existing.config.demo) {
        this.sendVehicle(config.identifier, demoForVin(config.vin, config.displayName), { demo: true });
      } else if (config.vin) {
        const snapshot = this.store.loadSnapshot(config.vin);
        if (snapshot) {
          this.sendVehicle(config.identifier, snapshot, { cached: true });
        }
      }
      return;
    }

    if (existing?.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    if (existing) {
      existing.generation = (existing.generation || 0) + 1;
    }

    const instance = {
      identifier: config.identifier,
      key,
      config,
      refreshMs,
      forceRefreshMs,
      lastForceRefreshAt: existing?.lastForceRefreshAt || null,
      nextForceRefreshAt: existing?.nextForceRefreshAt || null,
      lastDiagnosticsAt: existing?.lastDiagnosticsAt || null,
      lastDetailsAt: existing?.lastDetailsAt || null,
      lastLocationAt: existing?.lastLocationAt || null,
      lastVehicle: existing?.lastVehicle || null,
      forceEvUnsupported: existing?.forceEvUnsupported || false,
      forceEvFailCount: existing?.forceEvFailCount || 0,
      polling: false,
      timer: null,
      generation: (existing?.generation || 0) + 1,
      sentSnapshot: false
    };
    this.instances.set(key, instance);

    this.logInfo(
      `${this.label(instance)} starting poll loop every ${formatDuration(refreshMs)} ` +
        `(refreshInterval=${config.refreshInterval}, demo=${Boolean(config.demo)}, ` +
        `forceRefreshEV=${Boolean(config.forceRefreshEV)}, forceRefreshEVInterval=${formatDuration(forceRefreshMs)})`
    );
    this.runPollLoop(instance);
  },

  runPollLoop(instance) {
    const gen = instance.generation;
    const tick = async () => {
      const current = this.instances.get(instance.key);
      if (!current || current.generation !== gen) {
        return;
      }
      try {
        await this.enqueuePoll(current, { force: true, reason: current.timer ? "scheduled" : "initial" });
      } catch (err) {
        this.logError(`${this.label(current)} poll failed: ${err.message}`);
      }
      const still = this.instances.get(instance.key);
      if (!still || still.generation !== gen) {
        return;
      }
      const delay = Number.isFinite(Number(still.nextDelayMs)) && still.nextDelayMs > 0 ? still.nextDelayMs : still.refreshMs;
      still.timer = setTimeout(tick, delay);
      this.logInfo(`${this.label(still)} next poll in ${formatDuration(delay)}`);
    };
    tick();
  },

  enqueuePoll(instance, options) {
    const run = () => this.pollInstance(instance, options);
    this.pollQueue = this.pollQueue.then(run, run);
    return this.pollQueue;
  },

  async pollInstance(instance, options) {
    if (instance.polling && !options?.force) {
      this.logInfo(`${this.label(instance)} skip overlapping poll`);
      return;
    }
    instance.polling = true;
    this.activeLogLabel = this.label(instance);
    const started = Date.now();
    let delay = instance.refreshMs;
    const reason = options?.reason || "poll";
    const { config } = instance;
    const username = config.username || process.env.GM_USERNAME;
    const password = config.password || process.env.GM_PASSWORD;
    const totpSecret = config.totpSecret || config.onStarTOTP || process.env.GM_TOTP;
    const onStarPin = config.onStarPin || process.env.GM_PIN;
    const resolved = { ...config, username, password, totpSecret, onStarPin };
    try {
      this.logInfo(`${this.label(instance)} ${reason} poll starting`);
      if (config.demo) {
        const vehicle = demoForVin(config.vin, config.displayName);
        this.sendVehicle(config.identifier, vehicle, { demo: true });
        this.logInfo(`${this.label(instance)} demo poll done in ${Date.now() - started}ms soc=${vehicle.batteryLevel}`);
        return;
      }

      if (!resolved.username || !resolved.password || !config.vin) {
        throw new Error("username, password, and vin are required (or set demo: true). Credentials may be set in config or GM_USERNAME / GM_PASSWORD / GM_TOTP / GM_PIN env vars.");
      }

      const snapshot = this.store.loadSnapshot(config.vin);
      if (snapshot && !instance.sentSnapshot) {
        instance.sentSnapshot = true;
        instance.lastVehicle = snapshot;
        this.sendVehicle(config.identifier, snapshot, { cached: true });
        this.logInfo(`${this.label(instance)} painted cached snapshot while fetching live data`);
      }

      const previous = instance.lastVehicle || snapshot || null;
      const client = this.getClient(resolved);
      const forceEVWanted = this.wantsForceRefresh(instance, options);
      const plan = planPoll({
        vehicle: previous,
        refreshMs: instance.refreshMs,
        asleepRefresh: instance.config.asleepRefreshInterval,
        forceEV: forceEVWanted,
        forceEVUnsupported: instance.forceEvUnsupported,
        lastDiagnosticsAt: instance.lastDiagnosticsAt,
        lastDetailsAt: instance.lastDetailsAt,
        lastLocationAt: instance.lastLocationAt,
        manual: reason === "manual"
      });
      if (!plan.location && !instance.lastLocationAt && hasCoordinates(previous)) {
        instance.lastLocationAt = Date.now();
      }
      let evCall = plan.forceEV ? "refreshEVChargingMetrics" : "getEVChargingMetrics";
      this.logInfo(
        `${this.label(instance)} poll plan asleep=${plan.asleep} ` +
          `calls=${["ev", plan.diagnostics && "diagnostics", plan.location && "location", plan.details && "details"].filter(Boolean).join(",")} ` +
          `skip=${plan.skips.join(",") || "none"} evCall=${evCall}`
      );

      const [diagnostics, evMetrics, location, details] = await this.pollEndpoints(instance, client, plan);
      evCall = instance.lastEvCall || evCall;

      const fresh = parser.parseAll({
        diagnostics: diagnostics?.status === "fulfilled" ? diagnostics.value : null,
        evMetrics: evMetrics?.status === "fulfilled" ? evMetrics.value : null,
        location: location?.status === "fulfilled" ? location.value : null,
        vehicleDetails: details?.status === "fulfilled" ? details.value : null,
        vin: config.vin
      });

      let vehicle = parser.keepPreviousValues(previous, fresh);
      const evFailed = evMetrics?.status === "rejected";
      const diagFailed = diagnostics?.status === "rejected";
      const attemptedAt = new Date().toISOString();
      if (evFailed && parser.isValidSoc(previous?.batteryLevel)) {
        vehicle.batteryLevel = previous.batteryLevel;
      }

      vehicle.vin = config.vin;
      vehicle.displayName = config.displayName || vehicle.displayName || config.vin;
      vehicle.fetchErrors = {
        diagnostics: diagFailed ? String(diagnostics.reason?.message || diagnostics.reason) : null,
        evMetrics: evFailed ? String(evMetrics.reason?.message || evMetrics.reason) : null,
        location: location?.status === "rejected" ? String(location.reason?.message || location.reason) : null
      };
      vehicle.lastAttemptAt = attemptedAt;
      vehicle.stale = evFailed || diagFailed;
      if (evFailed) {
        vehicle.lastUpdated = previous?.lastUpdated || vehicle.lastUpdated;
      }

      const throttle = throttleFromSettled([diagnostics, evMetrics, location, details]);
      delay = this.scheduleAfterPoll(instance, {
        forceEV: plan.forceEV,
        evFailed,
        throttle,
        asleep: plan.asleep
      });
      this.applyThrottleToVehicle(vehicle, throttle, delay);

      this.store.saveSnapshot(config.vin, vehicle);
      instance.lastVehicle = vehicle;
      instance.sentSnapshot = true;
      this.sendVehicle(config.identifier, vehicle, { cached: false, stale: vehicle.stale });
      const tires = vehicle.tires || {};
      this.logInfo(
        `${this.label(instance)} poll done in ${Date.now() - started}ms ` +
          `diag=${settledLabel(diagnostics)} ev=${settledLabel(evMetrics)} loc=${settledLabel(location)} ` +
          `details=${settledLabel(details)} soc=${vehicle.batteryLevel} rangeKm=${vehicle.rangeKm} ` +
          `tires=${tireLog(tires.fl)}/${tireLog(tires.fr)}/${tireLog(tires.rl)}/${tireLog(tires.rr)}${tires.unit ? ` ${tires.unit}` : ""} ` +
          `stale=${vehicle.stale} asleep=${plan.asleep} vin=${config.vin} id=${config.identifier} evCall=${evCall} ` +
          `nextPoll=${formatDuration(delay)}${throttle ? ` throttle=${formatThrottle(throttle)}` : ""}`
      );
      this.logThrottle(instance, throttle, delay);
    } catch (err) {
      this.logError(`${this.label(instance)} poll error after ${Date.now() - started}ms: ${err.message || err}`);
      const throttle = extractThrottle(err);
      delay = this.scheduleAfterPoll(instance, {
        forceEV: false,
        evFailed: true,
        throttle,
        asleep: isVehicleAsleep(instance.lastVehicle)
      });
      this.logThrottle(instance, throttle, delay);
      const snapshot = instance.lastVehicle || (config.vin ? this.store.loadSnapshot(config.vin) : null);
      if (snapshot) {
        snapshot.stale = true;
        snapshot.lastAttemptAt = new Date().toISOString();
        this.applyThrottleToVehicle(snapshot, throttle, delay);
        instance.lastVehicle = snapshot;
      }
      this.sendSocketNotification("GMV_ERROR", {
        identifier: config.identifier,
        vin: config.vin || snapshot?.vin || null,
        message: err.message || String(err),
        vehicle: snapshot,
        stale: true
      });
    } finally {
      instance.nextDelayMs = delay;
      instance.polling = false;
      this.activeLogLabel = null;
    }
  },

  wantsForceRefresh(instance, options) {
    if (options?.forceEV && instance.config.forceRefreshEV) {
      return true;
    }
    if (!instance.config.forceRefreshEV) {
      return false;
    }
    const now = Date.now();
    if (instance.nextForceRefreshAt && now < instance.nextForceRefreshAt) {
      return false;
    }
    return shouldForceRefreshEV(true, instance.lastForceRefreshAt, instance.forceRefreshMs, now);
  },

  scheduleAfterPoll(instance, { forceEV, evFailed, throttle, asleep }) {
    const now = Date.now();
    if (forceEV) {
      instance.lastForceRefreshAt = now;
      const wait = evFailed && throttle?.waitMs ? throttle.waitMs : 0;
      instance.nextForceRefreshAt = now + Math.max(instance.forceRefreshMs || instance.refreshMs, wait);
      this.logInfo(
        `${this.label(instance)} next forceRefreshEV in ${formatDuration(instance.nextForceRefreshAt - now)}`
      );
    }
    const scheduled = pollDelayMs({
      refreshMs: instance.refreshMs,
      throttle,
      nextDelayMs
    });
    const floor = Number(throttle?.waitMs);
    const jittered = withJitter(scheduled, 0.1);
    return Number.isFinite(floor) && floor > 0 ? Math.max(floor, jittered) : jittered;
  },

  async pollEndpoints(instance, client, plan) {
    const results = { diagnostics: null, ev: null, location: null, details: null };
    let aborted = null;
    const run = async (name, fn, backoff) => {
      if (aborted) {
        this.logInfo(`${this.label(instance)} skip ${name} after 429 on ${aborted}`);
        return null;
      }
      try {
        const value = await fetchWithBackoff(fn, backoff);
        return { status: "fulfilled", value };
      } catch (reason) {
        if (is429Error(reason)) {
          aborted = name;
          this.logInfo(`${this.label(instance)} 429 on ${name}; serving cached values for remaining calls`);
        }
        return { status: "rejected", reason };
      }
    };
    const pause = async () => {
      if (!aborted) {
        await sleep(withJitter(1000, 0.4));
      }
    };

    if (plan.ev) {
      instance.lastEvCall = plan.forceEV ? "refreshEVChargingMetrics" : "getEVChargingMetrics";
      results.ev = await run("ev", () => this.fetchEvMetrics(instance, client, plan), {
        retries: 3,
        delay: 2000,
        maxDelay: 20000
      });
    }
    if (plan.diagnostics) {
      await pause();
      results.diagnostics = await run("diagnostics", () => client.diagnostics(), {
        retries: 0,
        delay: 2000,
        maxDelay: 20000
      });
      if (results.diagnostics?.status === "fulfilled") {
        instance.lastDiagnosticsAt = Date.now();
      }
    }
    if (plan.location) {
      await pause();
      results.location = await run("location", () => client.location(), {
        retries: 0,
        delay: 2000,
        maxDelay: 20000
      });
      if (results.location?.status === "fulfilled") {
        instance.lastLocationAt = Date.now();
      }
    }
    if (plan.details) {
      await pause();
      results.details = await run("details", () => client.getVehicleDetails(instance.config.vin), {
        retries: 3,
        delay: 2000,
        maxDelay: 20000
      });
      if (results.details?.status === "fulfilled") {
        instance.lastDetailsAt = Date.now();
      }
    }
    return [results.diagnostics, results.ev, results.location, results.details];
  },

  async fetchEvMetrics(instance, client, plan) {
    if (!plan.forceEV) {
      return client.getEVChargingMetrics();
    }
    try {
      const value = await client.refreshEVChargingMetrics();
      instance.forceEvFailCount = 0;
      instance.lastEvCall = "refreshEVChargingMetrics";
      return value;
    } catch (err) {
      if (!shouldFallbackEvRefresh(err)) {
        throw err;
      }
      const status = httpStatus(err);
      const preview = errorBodyPreview(err);
      instance.forceEvFailCount = (instance.forceEvFailCount || 0) + 1;
      instance.lastEvCall = "getEVChargingMetrics(fallback)";
      this.logInfo(
        `${this.label(instance)} refreshEVChargingMetrics returned ${status}` +
          `${preview ? ` body=${preview}` : ""}` +
          `; falling back to getEVChargingMetrics (live telemetry wake is not supported on some vehicles, including Gen 1 Bolt)`
      );
      if (instance.forceEvFailCount >= 2) {
        instance.forceEvUnsupported = true;
        this.logInfo(
          `${this.label(instance)} disabling forceRefreshEV until restart after repeated ${status} on refreshEVChargingMetrics`
        );
      }
      return client.getEVChargingMetrics();
    }
  },

  getClient(config) {
    const key = `${String(config.username).toLowerCase()}::${config.vin}`;
    if (this.clients.has(key)) {
      return this.clients.get(key);
    }
    if (!this.OnStar) {
      throw new Error("onstarjs2 is not installed. Run npm install in the MMM-GeneralMotorsEV folder.");
    }

    const username = config.username;
    const tokenLocation = this.store.tokenLocation(username);
    const deviceId = this.store.getOrCreateDeviceId(username, config.deviceId);
    const client = this.OnStar.create({
      deviceId,
      vin: config.vin,
      username,
      password: config.password,
      onStarPin: String(config.onStarPin || ""),
      onStarTOTP: config.totpSecret || config.onStarTOTP || "",
      tokenLocation,
      checkRequestStatus: config.checkRequestStatus !== false,
      requestPollingIntervalSeconds: config.requestPollingIntervalSeconds || 6,
      requestPollingTimeoutSeconds: config.requestPollingTimeoutSeconds || 90,
      max429Retries: 2,
      retryOn429ForPost: false,
      initial429DelayMs: 2000,
      backoffFactor: 2,
      jitterMs: 400,
      max429DelayMs: 20000
    });
    this.clients.set(key, client);
    this.logInfo(`${this.name} [${config.identifier || "?"}] OnStar client created for ${config.vin}; tokens cached in ${tokenLocation}`);
    return client;
  },

  applyThrottleToVehicle(vehicle, throttle, delay) {
    if (!vehicle) {
      return;
    }
    const limited = Boolean(throttle && (Number(throttle.status) === 429 || Number(throttle.waitMs) > 0));
    vehicle.rateLimited = limited;
    vehicle.retryAfter = limited ? throttle.retryAfter ?? null : null;
    vehicle.nextRefreshAt = limited && Number.isFinite(delay) && delay > 0
      ? new Date(Date.now() + delay).toISOString()
      : null;
  },

  logThrottle(instance, throttle, delay) {
    if (!throttle) {
      return;
    }
    const next = Number.isFinite(delay) ? ` next-poll=${formatDuration(delay)}` : "";
    const refresh = Number.isFinite(instance.refreshMs)
      ? delay > instance.refreshMs
        ? ` (extended from refresh ${formatDuration(instance.refreshMs)})`
        : ` (refresh ${formatDuration(instance.refreshMs)})`
      : "";
    let extra = "";
    const noRetryAfter = Number(throttle.status) === 429 && (throttle.retryAfter == null || throttle.retryAfter === "");
    if (noRetryAfter) {
      const captured = throttle.rateLimitHeaders && Object.keys(throttle.rateLimitHeaders).length
        ? Object.entries(throttle.rateLimitHeaders).map(([k, v]) => `${k}=${v}`).join(",")
        : "";
      const names = Array.isArray(throttle.headerNames) ? throttle.headerNames.join(",") : "";
      if (captured) {
        extra += ` rate-headers=${captured}`;
      } else if (names) {
        extra += ` 429-headers=${names}`;
      } else {
        extra += " 429-headers=(none captured)";
      }
    }
    this.logInfo(`${this.label(instance)} throttle ${formatThrottle(throttle)}${next}${refresh}${extra}`);
  },

  sendVehicle(identifier, vehicle, meta) {
    this.sendSocketNotification("GMV_VEHICLE", {
      identifier,
      vin: vehicle?.vin || null,
      vehicle,
      meta: meta || {}
    });
  },

  stop() {
    for (const instance of this.instances.values()) {
      instance.generation = (instance.generation || 0) + 1;
      if (instance.timer) {
        clearTimeout(instance.timer);
        instance.timer = null;
      }
    }
    this.instances.clear();
  }
});
