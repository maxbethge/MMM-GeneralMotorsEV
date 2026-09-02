"use strict";

/**
 * Normalize OnStar / myGMC API payloads into a single vehicle state object.
 * Supports v3 HealthStatus diagnostics, legacy diagnosticResponse, EV charging
 * metrics (tcl/soc/cplug/...), and location / digital-twin telemetry.
 */

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const cleaned = String(value).replace(/[% ,]/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function asString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const s = String(value).trim();
  return s.length ? s : null;
}

function upper(value) {
  return String(value || "").toUpperCase();
}

function walk(node, visitor, depth) {
  if (node === null || node === undefined || depth > 12) {
    return;
  }
  visitor(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visitor, depth + 1);
    }
    return;
  }
  if (typeof node === "object") {
    for (const key of Object.keys(node)) {
      walk(node[key], visitor, depth + 1);
    }
  }
}

function unwrapResult(raw) {
  if (!raw) {
    return {};
  }
  return raw.response?.data || raw.data || raw;
}

function diagnosticGroups(data) {
  if (Array.isArray(data?.diagnostics)) {
    return data.diagnostics;
  }
  const legacy = data?.commandResponse?.body?.diagnosticResponse;
  if (Array.isArray(legacy)) {
    return legacy;
  }
  if (Array.isArray(data?.diagnosticResponse)) {
    return data.diagnosticResponse;
  }
  return [];
}

function diagnosticElements(group) {
  const els = group?.diagnosticElements || group?.diagnosticElement || [];
  return Array.isArray(els) ? els : [];
}

function groupHaystack(group) {
  return upper([group?.name, group?.displayName].filter(Boolean).join(" "));
}

function elementHaystack(el) {
  return upper([el?.name, el?.displayName, el?.description].filter(Boolean).join(" "));
}

function firstNumericElement(group) {
  for (const el of diagnosticElements(group)) {
    const n = asNumber(el.value);
    if (n !== null) {
      return { value: n, unit: el.uom || el.unit || null, name: el.name };
    }
  }
  return null;
}

function parseTires(groups) {
  const tires = { fl: null, fr: null, rl: null, rr: null, unit: null, count: 0 };

  const assignCorner = (hay, value, unit) => {
    if (value === null) {
      return false;
    }
    if (unit && !tires.unit) {
      tires.unit = unit;
    }
    if (/LEFT FRONT|FRONT LEFT|\bLF\b|TIRE PRESSURE LF/.test(hay)) {
      tires.fl = value;
      return true;
    }
    if (/RIGHT FRONT|FRONT RIGHT|\bRF\b|TIRE PRESSURE RF/.test(hay)) {
      tires.fr = value;
      return true;
    }
    if (/LEFT REAR|REAR LEFT|\bLR\b|TIRE PRESSURE LR/.test(hay)) {
      tires.rl = value;
      return true;
    }
    if (/RIGHT REAR|REAR RIGHT|\bRR\b|TIRE PRESSURE RR/.test(hay)) {
      tires.rr = value;
      return true;
    }
    return false;
  };

  const ordered = [];
  for (const group of groups) {
    const gHay = groupHaystack(group);
    if (!/TIRE/.test(gHay) && !/TPMS/.test(gHay)) {
      continue;
    }
    for (const el of diagnosticElements(group)) {
      const value = asNumber(el.value);
      if (value === null) {
        continue;
      }
      const unit = el.uom || el.unit || null;
      const hay = `${gHay} ${elementHaystack(el)}`;
      if (!assignCorner(hay, value, unit)) {
        ordered.push({ value, unit });
      }
    }
  }

  if (tires.fl === null && tires.fr === null && tires.rl === null && tires.rr === null && ordered.length >= 4) {
    tires.fl = ordered[0].value;
    tires.fr = ordered[1].value;
    tires.rl = ordered[2].value;
    tires.rr = ordered[3].value;
    tires.unit = ordered[0].unit;
  } else if (tires.fl === null && ordered.length === 1) {
    tires.fl = ordered[0].value;
    tires.unit = ordered[0].unit;
  }

  tires.count = [tires.fl, tires.fr, tires.rl, tires.rr].filter((v) => v !== null).length;
  return tires;
}

function parseDiagnostics(data) {
  const groups = diagnosticGroups(data);
  const out = {};

  for (const group of groups) {
    const hay = groupHaystack(group);
    if (/OIL LIFE/.test(hay)) {
      continue;
    }

    if (/ODOMETER/.test(hay) && !/TRIP|LIFETIME EV/.test(hay)) {
      const item = firstNumericElement(group);
      if (item) {
        out.odometerKm = toKm(item.value, item.unit);
        out.odometerRaw = item.value;
        out.odometerUnit = item.unit;
      }
    } else if (/EV BATTERY LEVEL|HIGH VOLTAGE BATTERY|STATE OF CHARGE|\bSOC\b/.test(hay) && !/12/.test(hay)) {
      const item = firstNumericElement(group);
      if (item) {
        out.batteryLevel = item.value;
      }
    } else if (/VEHICLE RANGE|EV RANGE|ELECTRIC RANGE|ESTIMATED RANGE/.test(hay)) {
      const item = firstNumericElement(group);
      if (item) {
        out.rangeKm = toKm(item.value, item.unit);
      }
    } else if (/INTERM VOLT|INTERMEDIATE VOLT|12 VOLT|12V|LV BATTERY/.test(hay)) {
      const item = firstNumericElement(group);
      if (item) {
        out.battery12v = item.value;
        out.battery12vUnit = item.unit || "V";
      }
    } else if (/EV PLUG STATE|PLUG STATE/.test(hay)) {
      const el = diagnosticElements(group)[0];
      out.plugState = asString(el?.value || el?.message);
    } else if (/EV CHARGE STATE|CHARGE STATE/.test(hay) && !/BATTERY/.test(hay)) {
      const el = diagnosticElements(group)[0];
      out.chargeState = asString(el?.value || el?.message);
    } else if (/AMBIENT AIR TEMPERATURE|OUTSIDE TEMP|AMBIENT TEMP/.test(hay)) {
      const item = firstNumericElement(group);
      if (item) {
        out.outsideTempC = toCelsius(item.value, item.unit);
      }
    } else if (/GET CHARGE MODE|CHARGE MODE/.test(hay) && !/SCHEDULE/.test(hay)) {
      const el = diagnosticElements(group)[0];
      out.chargeMode = asString(el?.value || el?.message);
    } else if (/EV ESTIMATED CHARGE END|CHARGE END/.test(hay)) {
      const el = diagnosticElements(group)[0];
      out.chargeEta = asString(el?.value || el?.message);
    } else if (/EV PLUG VOLTAGE|PLUG VOLTAGE/.test(hay)) {
      const item = firstNumericElement(group);
      if (item && item.value > 0) {
        out.plugVoltage = item.value;
        out.plugVoltageUnit = item.unit && !/^N\/?A$/i.test(item.unit) ? item.unit : "V";
      }
    } else if (/SCHEDULED CHARGE START/.test(hay)) {
      const el = diagnosticElements(group).find((e) => asString(e.value) || asString(e.message));
      const scheduled = parseScheduledStart(el?.value || el?.message);
      if (scheduled) {
        out.scheduledChargeStart = scheduled;
      }
    }
  }

  out.tires = parseTires(groups);
  out.pluggedIn = isPlugged(out.plugState);
  out.charging = isCharging(out.chargeState, out.pluggedIn);
  return out;
}

function toKm(value, unit) {
  const u = upper(unit);
  if (!u || /KM/.test(u)) {
    return value;
  }
  if (/\bMI\b|MILE/.test(u)) {
    return value * 1.609344;
  }
  return value;
}

function toCelsius(value, unit) {
  const u = upper(unit);
  if (/F/.test(u) && !/C/.test(u)) {
    return (value - 32) * (5 / 9);
  }
  return value;
}

function isPlugged(plugState) {
  const s = upper(plugState);
  if (!s) {
    return false;
  }
  return /PLUG/.test(s) && !/UNPLUG/.test(s) && !/NOT.?PLUG/.test(s);
}

function parseScheduledStart(raw) {
  const s = asString(raw);
  if (!s) {
    return null;
  }
  if (/^(NA|N\/A|NONE|NULL|NOT.?SET|UNAVAILABLE|UNKNOWN|--|FALSE|F)$/i.test(s)) {
    return null;
  }
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length > 10 ? Number(s) : Number(s) * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return s;
}

function isCharging(chargeState, pluggedIn) {
  const s = upper(chargeState);
  if (/CHARGING|ACTIVE|IN_PROGRESS|IN PROGRESS/.test(s)) {
    return true;
  }
  if (/UNCONNECTED|NOT_CHARGING|IDLE|COMPLETE|FINISHED/.test(s)) {
    return false;
  }
  return Boolean(pluggedIn && /CHARGE/.test(s));
}

function evMetricsRow(data) {
  const root = unwrapResult(data);
  if (root?.results && Array.isArray(root.results) && root.results[0]) {
    return root.results[0];
  }
  if (root?.success && root?.results?.[0]) {
    return root.results[0];
  }
  return root?.results?.[0] || null;
}

function parseEvMetrics(data) {
  const row = evMetricsRow(data);
  if (!row || typeof row !== "object") {
    return {};
  }

  const out = {
    batteryLevel: asNumber(row.soc),
    chargeTarget: asNumber(row.tcl),
    rangeKm: asNumber(row.ravg),
    odometerKm: asNumber(row.odo),
    energyKwh: asNumber(row.kwh),
    outsideTempC: asNumber(row.temp),
    plugState: asString(row.cplug),
    chargeState: asString(row.cstate),
    chargeMode: asString(row.cmode),
    ignition: asString(row.ign),
    chargeEta: asString(row.ceta),
    heading: asNumber(row.dir),
    speedKph: asNumber(row.gpsspd),
    latitude: asNumber(row.lat),
    longitude: asNumber(row.lng),
    lifetimeKwh: asNumber(row.lifekwh),
    tripKm: asNumber(row.tripodo)
  };

  if (out.latitude === null || out.longitude === null) {
    const loc = parseLatLngString(row.loc);
    if (loc) {
      out.latitude = loc.latitude;
      out.longitude = loc.longitude;
    }
  }

  out.pluggedIn = isPlugged(out.plugState);
  out.charging = isCharging(out.chargeState, out.pluggedIn);
  return compact(out);
}

function parseLatLngString(value) {
  if (!value || typeof value !== "string" || !value.includes(",")) {
    return null;
  }
  const [lat, lng] = value.split(",").map((p) => asNumber(p));
  if (lat === null || lng === null) {
    return null;
  }
  return { latitude: lat, longitude: lng };
}

function parseLocation(data) {
  const root = unwrapResult(data);
  const found = { latitude: null, longitude: null, heading: null };

  const loc = root?.location || root?.telemetry?.data?.location || root?.telemetry?.location;
  if (loc) {
    found.latitude = asNumber(loc.lat ?? loc.latitude);
    found.longitude = asNumber(loc.long ?? loc.lng ?? loc.longitude);
    found.heading = asNumber(loc.heading ?? loc.dir);
  }

  if (found.latitude !== null && found.longitude !== null) {
    return compact(found);
  }

  walk(root, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const lat = asNumber(node.lat ?? node.latitude);
    const lng = asNumber(node.long ?? node.lng ?? node.longitude);
    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      if (found.latitude === null) {
        found.latitude = lat;
        found.longitude = lng;
        found.heading = asNumber(node.heading ?? node.dir);
      }
    }
  }, 0);

  return compact(found);
}

function parseVehicleDetails(data) {
  const root = unwrapResult(data);
  const details = root?.vehicleDetails || root?.data?.vehicleDetails || root;
  const vehicle = Array.isArray(root?.vehicles) ? root.vehicles[0] : details;
  if (!vehicle || typeof vehicle !== "object") {
    return {};
  }
  return compact({
    vin: asString(vehicle.vin),
    make: asString(vehicle.make),
    model: asString(vehicle.model),
    year: asString(vehicle.year),
    displayName: asString(vehicle.nickName || vehicle.nickname || vehicle.displayName),
    imageUrl: asString(vehicle.imageUrl)
  });
}

function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

function mergeState(parts) {
  const state = {
    batteryLevel: null,
    chargeTarget: null,
    rangeKm: null,
    odometerKm: null,
    battery12v: null,
    battery12vUnit: "V",
    tires: { fl: null, fr: null, rl: null, rr: null, unit: "psi", count: 0 },
    pluggedIn: false,
    charging: false,
    plugState: null,
    chargeState: null,
    chargeMode: null,
    ignition: null,
    latitude: null,
    longitude: null,
    heading: null,
    outsideTempC: null,
    chargeEta: null,
    scheduledChargeStart: null,
    plugVoltage: null,
    plugVoltageUnit: "V",
    energyKwh: null,
    make: null,
    model: null,
    year: null,
    displayName: null,
    imageUrl: null,
    lastUpdated: new Date().toISOString()
  };

  for (const part of parts) {
    if (!part) {
      continue;
    }
    for (const [key, value] of Object.entries(part)) {
      if (key === "tires" && value) {
        state.tires = {
          ...state.tires,
          ...compact(value),
          count: [value.fl, value.fr, value.rl, value.rr].filter((v) => v !== null && v !== undefined).length
        };
        continue;
      }
      if (value !== null && value !== undefined && value !== "") {
        state[key] = value;
      }
    }
  }

  return state;
}

function parseAll({ diagnostics, evMetrics, location, vehicleDetails }) {
  return mergeState([
    parseVehicleDetails(vehicleDetails),
    parseDiagnostics(unwrapResult(diagnostics)),
    parseLocation(location),
    parseEvMetrics(evMetrics)
  ]);
}

module.exports = {
  asNumber,
  unwrapResult,
  parseDiagnostics,
  parseEvMetrics,
  parseLocation,
  parseVehicleDetails,
  parseTires,
  parseAll,
  mergeState,
  parseScheduledStart,
  isPlugged,
  isCharging
};
