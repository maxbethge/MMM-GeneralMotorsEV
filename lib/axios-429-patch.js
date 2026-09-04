"use strict";

/**
 * onstarjs2 wraps axios 429s as RequestError and copies only status/statusText/data,
 * dropping Retry-After. Copy the header onto the body before that wrap so
 * extractThrottle can honor it.
 */

const axios = require("axios");
const { headerValue } = require("./throttle");

let patched = false;

function retryAfterFromResponse(response) {
  if (!response) {
    return null;
  }
  return headerValue(response.headers, "retry-after") ?? headerValue(response.headers, "x-retry-after") ?? null;
}

function attachRetryAfter(error) {
  const response = error && error.response;
  if (!response || Number(response.status) !== 429) {
    return error;
  }
  const ra = retryAfterFromResponse(response);
  if (ra == null || ra === "") {
    return error;
  }
  error.gmvRetryAfter = ra;
  const data = response.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.retryAfter == null && data.retry_after == null) {
      data.retryAfter = ra;
    }
  } else {
    response.data = { body: data, retryAfter: ra };
  }
  return error;
}

function patchClient(client) {
  if (!client || !client.interceptors || client.interceptors.response.__gmvRetryAfter) {
    return client;
  }
  client.interceptors.response.use(
    (res) => res,
    (error) => {
      attachRetryAfter(error);
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

module.exports = { apply, attachRetryAfter, retryAfterFromResponse };
