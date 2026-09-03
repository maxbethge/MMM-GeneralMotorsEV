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

module.exports = { vinKey, payloadIsForInstance, wantsRangeDisplay };
