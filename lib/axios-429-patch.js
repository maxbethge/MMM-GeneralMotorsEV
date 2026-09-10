"use strict";

/**
 * onstarjs2 wraps axios 429s as RequestError and copies only status/statusText/data,
 * dropping Retry-After and RateLimit-* headers. Snapshot those onto the body
 * before that wrap so extractThrottle can honor them.
 */

const axios = require("axios");
const { headerValue } = require("./throttle");
const { recordAxios } = require("./api-trace");

let patched = false;

function isRateLimitHeaderName(name) {
  return /retry|rate.?limit|quota|throttle/i.test(String(name || ""));
}

function snapshotHeaders(headers) {
  const out = {};
  if (!headers) {
    return out;
  }
  const assign = (obj) => {
    if (!obj || typeof obj !== "object") {
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (value == null || value === "") {
        continue;
      }
      out[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
  };
  if (typeof headers.toJSON === "function") {
    try {
      assign(headers.toJSON());
    } catch (err) {
      // fall through
    }
  }
  if (typeof headers.forEach === "function") {
    try {
      headers.forEach((value, key) => {
        if (value == null || value === "") {
          return;
        }
        out[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
      });
    } catch (err) {
      // fall through
    }
  }
  assign(headers);
  return out;
}

function retryAfterFromHeaders(headers, all) {
  return (
    headerValue(headers, "retry-after") ??
    headerValue(headers, "x-retry-after") ??
    all["retry-after"] ??
    all["x-retry-after"] ??
    null
  );
}

function interestingHeaders(all) {
  const picked = {};
  for (const [key, value] of Object.entries(all || {})) {
    if (isRateLimitHeaderName(key) && value != null && value !== "") {
      picked[key] = value;
    }
  }
  return picked;
}

function attachRetryAfter(error) {
  const response = error && error.response;
  if (!response || Number(response.status) !== 429) {
    return error;
  }
  const all = snapshotHeaders(response.headers);
  const ra = retryAfterFromHeaders(response.headers, all);
  const bag = {
    status: 429,
    retryAfter: ra == null || ra === "" ? null : ra,
    headers: interestingHeaders(all),
    headerNames: Object.keys(all).sort()
  };
  error.gmvRetryAfter = bag.retryAfter;
  error.gmvRateLimit = bag;

  const data = response.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    data.gmvRateLimit = bag;
    if (bag.retryAfter != null && data.retryAfter == null && data.retry_after == null) {
      data.retryAfter = bag.retryAfter;
    }
  } else {
    response.data = { body: data, retryAfter: bag.retryAfter, gmvRateLimit: bag };
  }
  return error;
}

function patchClient(client) {
  if (!client || !client.interceptors || client.interceptors.response.__gmvRetryAfter) {
    return client;
  }
  client.interceptors.response.use(
    (res) => {
      recordAxios(res, null);
      return res;
    },
    (error) => {
      attachRetryAfter(error);
      recordAxios(error && error.response, error);
      return Promise.reject(error);
    }
  );
  client.interceptors.response.__gmvRetryAfter = true;
  return client;
}

function apply() {
  if (patched) {
    return axios;
  }
  patchClient(axios);
  const origCreate = axios.create.bind(axios);
  axios.create = function gmvCreate(config) {
    return patchClient(origCreate(config));
  };
  patched = true;
  return axios;
}

module.exports = {
  apply,
  attachRetryAfter,
  retryAfterFromResponse: (response) => retryAfterFromHeaders(response?.headers, snapshotHeaders(response?.headers)),
  snapshotHeaders
};
