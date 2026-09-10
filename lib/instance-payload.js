"use strict";

function vinKey(value) {
  return String(value || "").trim().toUpperCase();
}

function payloadIsForInstance(payload, instance) {
  if (!payload) {
    return false;
  }
  const myId = String(instance?.identifier || "");
  const theirId = String(payload.identifier || "");
  if (myId && theirId && myId !== theirId) {
    return false;
  }
  const myVin = vinKey(instance?.vin);
  const theirVin = vinKey(payload.vin || payload.vehicle?.vin);
  if (myVin && theirVin && myVin !== theirVin) {
    return false;
  }
  return Boolean((myId && theirId && myId === theirId) || (myVin && theirVin && myVin === theirVin));
}

function wantsRangeDisplay(rangeDisplay) {
  const s = String(rangeDisplay ?? "").trim().toLowerCase();
  if (!s || s === "%" || s === "soc" || s === "percent" || s === "percentage" || s === "battery") {
    return false;
  }
  return s === "range" || s === "mi" || s === "km" || s === "miles" || s === "distance" || s.includes("range");
}

const STATUS_COLORS = {
  RED: "red",
  YELLOW: "yellow",
  ORANGE: "orange",
  AMBER: "goldenrod",
  GOLD: "gold",
  GREEN: "limegreen",
  BLUE: "dodgerblue",
  WHITE: "white"
};

function statusColorToCss(color) {
  const raw = String(color || "").trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
    return raw;
  }
  return STATUS_COLORS[raw.toUpperCase()] || null;
}

module.exports = { vinKey, payloadIsForInstance, wantsRangeDisplay, statusColorToCss };
