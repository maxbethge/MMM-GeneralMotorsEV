"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class CredentialStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  accountKey(username) {
    return crypto.createHash("sha256").update(String(username || "").toLowerCase().trim()).digest("hex").slice(0, 16);
  }

  accountDir(username) {
    const dir = path.join(this.baseDir, "accounts", this.accountKey(username));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  tokenLocation(username) {
    return this.accountDir(username);
  }

  getOrCreateDeviceId(username, configuredId) {
    if (configuredId && String(configuredId).trim()) {
      return String(configuredId).trim();
    }
    const file = path.join(this.accountDir(username), "device-id.json");
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed.deviceId) {
          return parsed.deviceId;
        }
      } catch (err) {
        // regenerate below
      }
    }
    const deviceId = crypto.randomUUID();
    fs.writeFileSync(
      file,
      JSON.stringify({ deviceId, createdAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    return deviceId;
  }

  snapshotPath(vin) {
    const dir = path.join(this.baseDir, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${String(vin || "unknown").replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  }

  saveSnapshot(vin, data) {
    const payload = {
      savedAt: new Date().toISOString(),
      vehicle: data
    };
    fs.writeFileSync(this.snapshotPath(vin), JSON.stringify(payload, null, 2), "utf8");
  }

  loadSnapshot(vin) {
    const file = this.snapshotPath(vin);
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed.vehicle || parsed;
    } catch (err) {
      return null;
    }
  }
}

module.exports = { CredentialStore };
