"use strict";

/**
 * Normalize OnStar / myGMC API payloads into a single vehicle state object.
 * Supports v3 HealthStatus diagnostics, legacy diagnosticResponse, EV charging
 * metrics (tcl/soc/cplug/...), and location / digital-twin telemetry.
 */

const { inferPressureUnit } = require("./tire-units");

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

function isValidSoc(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

function isSocUnit(unit) {
  const u = upper(unit);
  if (!u || /^(NA|N\/A)$/.test(u)) {
    return true;
  }
  return /%|PERCENT/.test(u);
}

function isSocHaystack(hay) {
  const text = upper(hay).replace(/[_-]/g, " ");
  if (/TARGET|CAPACITY|HEALTH|LIMIT|SETTING|MAX SOC|MAXIMUM/.test(text)) {
    return false;
  }
  if (/EV BATTERY LEVEL|STATE OF CHARGE/.test(text)) {
    return true;
  }
  if (/VOLTAGE/.test(text)) {
    return false;
  }
  return /\bSOC\b/.test(text);
}

function parseBatteryLevel(groups) {
  let found = null;
  for (const group of groups) {
    for (const { el, hay } of flattenDiagnosticElements(group)) {
      if (!isSocHaystack(`${groupHaystack(group)} ${hay}`)) {
        continue;
      }
      const n = asNumber(el.value);
      const unit = el.uom || el.unit || null;
      if (isValidSoc(n) && isSocUnit(unit)) {
        found = n;
      }
    }
  }
  return found;
}

function isTireReading(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function flattenDiagnosticElements(group) {
  const out = [];
  const visit = (el, parentHay) => {
    if (!el || typeof el !== "object") {
      return;
    }
    const hay = `${parentHay} ${elementHaystack(el)}`.replace(/[_-]/g, " ").trim();
    out.push({ el, hay });
    const kids = el.diagnosticElements || el.diagnosticElement;
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        visit(kid, hay);
      }
    }
  };
  for (const el of diagnosticElements(group)) {
    visit(el, groupHaystack(group).replace(/[_-]/g, " "));
  }
  return out;
}

function parseTires(groups) {
  const tires = { fl: null, fr: null, rl: null, rr: null, unit: null, count: 0 };

  const assignCorner = (hay, value, unit) => {
    if (!isTireReading(value)) {
      return false;
    }
    if (unit && !tires.unit && !/^(NA|N\/A)$/i.test(String(unit))) {
      tires.unit = unit;
    }
    if (/LEFT FRONT|FRONT LEFT|\bLF\b|TIRE PRESSURE LF|PRESSURE.?LF/.test(hay)) {
      tires.fl = value;
      return true;
    }
    if (/RIGHT FRONT|FRONT RIGHT|\bRF\b|TIRE PRESSURE RF|PRESSURE.?RF/.test(hay)) {
      tires.fr = value;
      return true;
    }
    if (/LEFT REAR|REAR LEFT|\bLR\b|TIRE PRESSURE LR|PRESSURE.?LR/.test(hay)) {
      tires.rl = value;
      return true;
    }
    if (/RIGHT REAR|REAR RIGHT|\bRR\b|TIRE PRESSURE RR|PRESSURE.?RR/.test(hay)) {
      tires.rr = value;
      return true;
    }
    return false;
  };

  const ordered = [];
  for (const group of groups) {
    const gHay = groupHaystack(group).replace(/[_-]/g, " ");
    if (!/TIRE/.test(gHay) && !/TPMS/.test(gHay)) {
      continue;
    }
    for (const { el, hay } of flattenDiagnosticElements(group)) {
      const value = asNumber(el.value);
      if (!isTireReading(value)) {
        continue;
      }
      const unit = el.uom || el.unit || null;
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

  tires.count = [tires.fl, tires.fr, tires.rl, tires.rr].filter(isTireReading).length;
  tires.unit = inferPressureUnit([tires.fl, tires.fr, tires.rl, tires.rr], tires.unit);
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

  const batteryLevel = parseBatteryLevel(groups);
  if (batteryLevel !== null) {
    out.batteryLevel = batteryLevel;
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

function vinKey(value) {
  return String(value || "").trim().toUpperCase();
}

function rowVin(row) {
  return asString(row?.vin || row?.vehicleVin || row?.vehicleVIN || row?.vehicle_vin);
}

function flattenEvResult(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const nested = item.getVehicleChargingMetricsResponse;
  if (nested && typeof nested === "object") {
    return { ...item, ...nested };
  }
  return item;
}

function evMetricsRows(data) {
  const root = unwrapResult(data);
  const results = Array.isArray(root?.results) ? root.results : [];
  const rows = results.map(flattenEvResult).filter(Boolean);
  if (!rows.length && root && typeof root === "object" && (root.soc != null || root.ravg != null)) {
    rows.push(root);
  }
  return rows;
}

function evMetricsRow(data, vin) {
  const rows = evMetricsRows(data);
  if (!rows.length) {
    return null;
  }
  const want = vinKey(vin);
  if (want) {
    const match = rows.find((row) => vinKey(rowVin(row)) === want);
    if (match) {
      return match;
    }
    if (rows.some((row) => rowVin(row))) {
      return null;
    }
  }
  return rows[0];
}

function parseEvMetrics(data, vin) {
  const row = evMetricsRow(data, vin);
  if (!row || typeof row !== "object") {
    return {};
  }

  const soc = asNumber(row.soc);
  const out = {
    batteryLevel: isValidSoc(soc) ? soc : null,
    chargeTarget: asNumber(row.tcl),
    rangeKm: asNumber(row.ravg ?? row.range ?? row.evRange ?? row.estimatedRange),
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

function parseVehicleDetails(data, vin) {
  const root = unwrapResult(data);
  const list = Array.isArray(root?.vehicles)
    ? root.vehicles
    : Array.isArray(root?.data?.vehicles)
      ? root.data.vehicles
      : null;
  let vehicle = null;
  if (list) {
    const want = vinKey(vin);
    vehicle = want ? list.find((item) => vinKey(item?.vin) === want) : list[0];
  } else {
    vehicle = root?.vehicleDetails || root?.data?.vehicleDetails || root;
  }
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
          count: [value.fl, value.fr, value.rl, value.rr].filter(isTireReading).length
        };
        continue;
      }
      if (key === "batteryLevel" && !isValidSoc(value)) {
        continue;
      }
      if (value !== null && value !== undefined && value !== "") {
        state[key] = value;
      }
    }
  }

  return state;
}

function isEmptyValue(value) {
  return value === null || value === undefined || value === "";
}

function mergeTires(previous, next) {
  const prev = previous && typeof previous === "object" ? previous : {};
  const incoming = next && typeof next === "object" ? next : {};
  const out = {
    fl: null,
    fr: null,
    rl: null,
    rr: null,
    unit: incoming.unit || prev.unit || "psi",
    count: 0
  };
  for (const key of ["fl", "fr", "rl", "rr"]) {
    if (isTireReading(incoming[key])) {
      out[key] = Number(incoming[key]);
    } else if (isTireReading(prev[key])) {
      out[key] = Number(prev[key]);
    }
  }
  if (!incoming.unit && prev.unit) {
    out.unit = prev.unit;
  }
  out.count = [out.fl, out.fr, out.rl, out.rr].filter(isTireReading).length;
  out.unit = inferPressureUnit([out.fl, out.fr, out.rl, out.rr], out.unit);
  return out;
}

function keepPreviousValues(previous, next) {
  if (!previous) {
    return next || {};
  }
  if (!next) {
    return { ...previous };
  }
  const out = { ...next };
  for (const [key, value] of Object.entries(previous)) {
    if (key === "fetchErrors" || key === "stale" || key === "lastAttemptAt" || key === "lastUpdated" || key === "rateLimited" || key === "nextRefreshAt" || key === "retryAfter") {
      continue;
    }
    if (key === "tires") {
      out.tires = mergeTires(value, out.tires);
      continue;
    }
    if (key === "batteryLevel") {
      if (!isValidSoc(out.batteryLevel) && isValidSoc(value)) {
        out.batteryLevel = value;
      }
      continue;
    }
    if (isEmptyValue(out[key]) && !isEmptyValue(value)) {
      out[key] = value;
    }
  }
  if (!next.plugState && !next.chargeState) {
    if (previous.pluggedIn !== undefined) {
      out.pluggedIn = previous.pluggedIn;
    }
    if (previous.charging !== undefined) {
      out.charging = previous.charging;
    }
  }
  return out;
}

function parseAll({ diagnostics, evMetrics, location, vehicleDetails, vin }) {
  return mergeState([
    parseVehicleDetails(vehicleDetails, vin),
    parseDiagnostics(unwrapResult(diagnostics)),
    parseEvMetrics(evMetrics, vin),
    parseLocation(location)
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
  keepPreviousValues,
  parseScheduledStart,
  isPlugged,
  isCharging,
  isValidSoc,
  vinKey
};
