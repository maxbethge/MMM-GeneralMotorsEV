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
const { apply: tagOnStarConsole } = require("./gmv-console");
const parser = require("./lib/gm-parser");
const { demoForVin } = require("./lib/demo-data");
const { refreshIntervalMs, formatDuration, settledLabel } = require("./lib/refresh-interval");

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
    tagOnStarConsole();
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
        this.enqueuePoll(instance, { force: true, reason: "manual" }).catch((err) => {
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
    return `${this.name}: ${config.displayName || config.vin || config.identifier || "?"}`;
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
    const key = this.instanceKey(config);
    const existing = this.instances.get(key);
    if (existing && existing.config.vin === config.vin && existing.refreshMs === refreshMs && Boolean(existing.config.demo) === Boolean(config.demo) && Boolean(existing.config.forceRefreshEV) === Boolean(config.forceRefreshEV)) {
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
      polling: false,
      timer: null,
      generation: (existing?.generation || 0) + 1,
      sentSnapshot: false
    };
    this.instances.set(key, instance);

    this.logInfo(
      `${this.label(instance)} starting poll loop every ${formatDuration(refreshMs)} ` +
        `(refreshInterval=${config.refreshInterval}, demo=${Boolean(config.demo)}, forceRefreshEV=${Boolean(config.forceRefreshEV)})`
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
      still.timer = setTimeout(tick, still.refreshMs);
      this.logInfo(`${this.label(still)} next poll in ${formatDuration(still.refreshMs)}`);
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
    const started = Date.now();
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
        this.sendVehicle(config.identifier, snapshot, { cached: true });
        this.logInfo(`${this.label(instance)} painted cached snapshot while fetching live data`);
      }

      const client = this.getClient(resolved);
      const evCall = config.forceRefreshEV ? "refreshEVChargingMetrics" : "getEVChargingMetrics";
      this.logInfo(`${this.label(instance)} calling diagnostics, ${evCall}, location, getVehicleDetails`);
      const [diagnostics, evMetrics, location, details] = await Promise.allSettled([
        client.diagnostics(),
        config.forceRefreshEV ? client.refreshEVChargingMetrics() : client.getEVChargingMetrics(),
        client.location(),
        client.getVehicleDetails(config.vin)
      ]);

      const vehicle = parser.parseAll({
        diagnostics: diagnostics.status === "fulfilled" ? diagnostics.value : null,
        evMetrics: evMetrics.status === "fulfilled" ? evMetrics.value : null,
        location: location.status === "fulfilled" ? location.value : null,
        vehicleDetails: details.status === "fulfilled" ? details.value : null,
        vin: config.vin
      });

      vehicle.vin = config.vin;
      vehicle.displayName = config.displayName || vehicle.displayName || config.vin;
      vehicle.fetchErrors = {
        diagnostics: diagnostics.status === "rejected" ? String(diagnostics.reason?.message || diagnostics.reason) : null,
        evMetrics: evMetrics.status === "rejected" ? String(evMetrics.reason?.message || evMetrics.reason) : null,
        location: location.status === "rejected" ? String(location.reason?.message || location.reason) : null
      };

      this.store.saveSnapshot(config.vin, vehicle);
      instance.sentSnapshot = true;
      this.sendVehicle(config.identifier, vehicle, { cached: false });
      this.logInfo(
        `${this.label(instance)} poll done in ${Date.now() - started}ms ` +
          `diag=${settledLabel(diagnostics)} ev=${settledLabel(evMetrics)} loc=${settledLabel(location)} ` +
          `details=${settledLabel(details)} soc=${vehicle.batteryLevel} rangeKm=${vehicle.rangeKm} ` +
          `vin=${config.vin} id=${config.identifier} evCall=${evCall}`
      );
    } catch (err) {
      this.logError(`${this.label(instance)} poll error after ${Date.now() - started}ms: ${err.message || err}`);
      const snapshot = config.vin ? this.store.loadSnapshot(config.vin) : null;
      this.sendSocketNotification("GMV_ERROR", {
        identifier: config.identifier,
        vin: config.vin || snapshot?.vin || null,
        message: err.message || String(err),
        vehicle: snapshot
      });
    } finally {
      instance.polling = false;
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
      requestPollingTimeoutSeconds: config.requestPollingTimeoutSeconds || 90
    });
    this.clients.set(key, client);
    this.logInfo(`${this.name}: OnStar client created for ${config.vin}; tokens cached in ${tokenLocation}`);
    return client;
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
