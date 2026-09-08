"use strict";

function responsePayload(err) {
  if (!err || typeof err !== "object") {
    return { status: null, data: null };
  }
  const wrapped = typeof err.getResponse === "function" ? err.getResponse() : null;
  const axiosResp = err.response || err.cause?.response || null;
  return {
    status: Number(wrapped?.status || axiosResp?.status || err.status) || null,
    data: wrapped?.data !== undefined ? wrapped.data : axiosResp?.data !== undefined ? axiosResp.data : err.data
  };
}

function httpStatus(err) {
  const fromPayload = responsePayload(err).status;
  if (fromPayload) {
    return fromPayload;
  }
  const match = String(err?.message || "").match(/status\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function errorBodyPreview(err, max = 240) {
  const data = responsePayload(err).data;
  if (data == null || data === "") {
    return "";
  }
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.replace(/\s+/g, " ").slice(0, max);
}

/**
 * Live EV telemetry wake (refreshEVChargingMetrics) is not supported on some
 * vehicles (notably Gen 1 Bolt). GM answers 400/404/422 instead of a payload.
 */
function shouldFallbackEvRefresh(err) {
  const status = httpStatus(err);
  return status === 400 || status === 404 || status === 422 || status === 501;
}

module.exports = { httpStatus, errorBodyPreview, shouldFallbackEvRefresh, responsePayload };
