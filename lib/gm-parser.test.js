"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const parser = require("./gm-parser");

const evSample = {
  status: "success",
  response: {
    data: {
      success: true,
      results: [
        {
          lat: 35.14096,
          lng: -89.90398,
          cplug: "unplugged",
          cstate: "UNCONNECTED",
          ign: "off",
          odo: 8783.15625,
          ravg: 317.98,
          soc: 70,
          kwh: 59.61,
          temp: 23,
          cmode: "immediate",
          tcl: 80,
          ceta: "2025-10-11T18:30:00.000-05:00"
        }
      ]
    }
  }
};

const diagnosticsSample = {
  response: {
    data: {
      name: "HEALTH_STATUS",
      diagnostics: [
        {
          name: "ODOMETER",
          diagnosticElements: [{ name: "ODOMETER", value: "4821", uom: "KM" }]
        },
        {
          name: "OIL LIFE",
          diagnosticElements: [{ name: "OIL LIFE", value: "88", uom: "%" }]
        },
        {
          name: "EV BATTERY LEVEL",
          diagnosticElements: [{ name: "EV BATTERY LEVEL", value: "72", uom: "%" }]
        },
        {
          name: "VEHICLE RANGE",
          diagnosticElements: [{ name: "EV RANGE", value: "399", uom: "KM" }]
        },
        {
          name: "INTERM VOLT BATT VOLT",
          diagnosticElements: [{ name: "INTERM VOLT BATT VOLT", value: "12.6", uom: "V" }]
        },
        {
          name: "EV PLUG VOLTAGE",
          diagnosticElements: [{ name: "EV PLUG VOLTAGE", value: "240", uom: "V" }]
        },
        {
          name: "EV SCHEDULED CHARGE START",
          diagnosticElements: [{ name: "EV SCHEDULED CHARGE START", value: "2026-09-01T04:00:00.000Z" }]
        },
        {
          name: "TIRE PRESSURE",
          diagnosticElements: [
            { name: "TIRE PRESSURE LF", value: "42", uom: "psi" },
            { name: "TIRE PRESSURE RF", value: "41", uom: "psi" },
            { name: "TIRE PRESSURE LR", value: "40", uom: "psi" },
            { name: "TIRE PRESSURE RR", value: "39", uom: "psi" }
          ]
        }
      ]
    }
  }
};

describe("gm-parser", () => {
  it("reads EV metrics including charge target and GPS", () => {
    const ev = parser.parseEvMetrics(evSample);
    assert.equal(ev.batteryLevel, 70);
    assert.equal(ev.chargeTarget, 80);
    assert.equal(ev.latitude, 35.14096);
    assert.equal(ev.longitude, -89.90398);
    assert.equal(ev.pluggedIn, false);
  });

  it("reads diagnostics and ignores oil life", () => {
    const diag = parser.parseDiagnostics(parser.unwrapResult(diagnosticsSample));
    assert.equal(diag.odometerKm, 4821);
    assert.equal(diag.battery12v, 12.6);
    assert.equal(diag.tires.count, 4);
    assert.equal(diag.tires.fl, 42);
    assert.equal(diag.tires.rr, 39);
    assert.equal(diag.plugVoltage, 240);
    assert.equal(diag.scheduledChargeStart, "2026-09-01T04:00:00.000Z");
    assert.equal(diag.oilLife, undefined);
  });

  it("omits unset plug voltage and scheduled charge start", () => {
    const diag = parser.parseDiagnostics({
      diagnostics: [
        {
          name: "EV PLUG VOLTAGE",
          diagnosticElements: [{ name: "EV PLUG VOLTAGE", value: "0", uom: "V" }]
        },
        {
          name: "EV SCHEDULED CHARGE START",
          diagnosticElements: [{ name: "EV SCHEDULED CHARGE START", value: "NA" }]
        }
      ]
    });
    assert.equal(diag.plugVoltage, undefined);
    assert.equal(diag.scheduledChargeStart, undefined);
  });

  it("lets EV charge target replace oil-life-style fields when merging", () => {
    const state = parser.parseAll({ diagnostics: diagnosticsSample, evMetrics: evSample });
    assert.equal(state.chargeTarget, 80);
    assert.equal(state.battery12v, 12.6);
    assert.equal(state.tires.count, 4);
    assert.equal(state.oilLife, undefined);
    assert.equal(state.latitude, 35.14096);
  });
});
