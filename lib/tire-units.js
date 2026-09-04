"use strict";

/**
 * GM diagnostics often tag TPMS with uom "kPa" while the numbers are already PSI
 * (57 kPa would be a flat tire; 57 PSI is a normal truck reading). Real kPa
 * values are ~140–550. Infer from magnitude when the label and number disagree.
 */

const PSI_MAX = 120;
const KPA_MIN = 140;
const BAR_MAX = 12;

function labeledUnit(unit) {
  const u = String(unit || "").toUpperCase();
  if (/BAR/.test(u) && !/KPA/.test(u)) {
    return "bar";
  }
  if (/KPA|KILOPASCAL/.test(u)) {
    return "kpa";
  }
  if (/PSI|LB\/IN|LBF/.test(u)) {
    return "psi";
  }
  return null;
}

function numericPressures(values) {
  const list = Array.isArray(values) ? values : [values];
  return list.map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

function inferPressureUnit(values, declared) {
  const nums = numericPressures(values);
  const labeled = labeledUnit(declared);
  const max = nums.length ? Math.max(...nums) : 0;

  if (labeled === "bar" && (max === 0 || max <= BAR_MAX)) {
    return "bar";
  }
  if (max >= KPA_MIN) {
    return "kpa";
  }
  if (max > 0 && max <= PSI_MAX) {
    return "psi";
  }
  return labeled || "psi";
}

function formatTirePressure(value, unit, imperial) {
  if (value === null || value === undefined) {
    return "--";
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "--";
  }
  const kind = inferPressureUnit([n], unit);
  if (imperial) {
    if (kind === "kpa") {
      return (n / 6.89476).toFixed(0);
    }
    if (kind === "bar") {
      return (n * 14.5038).toFixed(0);
    }
    return n.toFixed(0);
  }
  if (kind === "psi") {
    return (n * 6.89476).toFixed(0);
  }
  if (kind === "bar") {
    return (n * 100).toFixed(0);
  }
  return n.toFixed(0);
}

function tireUnitLabel(unit, imperial) {
  if (imperial) {
    return "psi";
  }
  if (inferPressureUnit([], unit) === "bar" || labeledUnit(unit) === "bar") {
    return "bar";
  }
  return "kPa";
}

module.exports = {
  inferPressureUnit,
  formatTirePressure,
  tireUnitLabel,
  labeledUnit,
  PSI_MAX,
  KPA_MIN
};
