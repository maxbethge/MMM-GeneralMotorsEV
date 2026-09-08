"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { withJitter, is429Error, fetchWithBackoff } = require("./backoff");

describe("withJitter", () => {
  it("stays within ±spread of the base delay", () => {
    const random = () => 0.5;
    assert.equal(withJitter(1000, 0.2, random), 1000);
    assert.equal(withJitter(1000, 0.2, () => 0), 800);
    assert.equal(withJitter(1000, 0.2, () => 1), 1200);
  });
});

describe("is429Error", () => {
  it("detects status 429 on the error or wrapped response", () => {
    assert.equal(is429Error({ getResponse: () => ({ status: 429 }) }), true);
    assert.equal(is429Error({ response: { status: 429 } }), true);
    assert.equal(is429Error({ message: "nope" }), false);
  });
});

describe("fetchWithBackoff", () => {
  it("returns the first successful result", async () => {
    const waits = [];
    const value = await fetchWithBackoff(async () => 7, {
      retries: 3,
      sleep: async (ms) => {
        waits.push(ms);
      }
    });
    assert.equal(value, 7);
    assert.deepEqual(waits, []);
  });

  it("retries 429s with increasing delay", async () => {
    let n = 0;
    const waits = [];
    const value = await fetchWithBackoff(
      async () => {
        n += 1;
        if (n < 3) {
          const err = new Error("Request Failed with status 429 - Too Many Requests");
          err.getResponse = () => ({ status: 429 });
          throw err;
        }
        return "ok";
      },
      {
        retries: 3,
        delay: 1000,
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        }
      }
    );
    assert.equal(value, "ok");
    assert.deepEqual(waits, [1000, 2000]);
  });

  it("does not in-loop retry when Retry-After is longer than maxDelay", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        fetchWithBackoff(
          async () => {
            n += 1;
            const err = new Error("429");
            err.getResponse = () => ({ status: 429, headers: { "retry-after": "1800" } });
            throw err;
          },
          { retries: 3, maxDelay: 30000, sleep: async () => {} }
        ),
      /429/
    );
    assert.equal(n, 1);
  });

  it("does not retry non-429 errors", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        fetchWithBackoff(
          async () => {
            n += 1;
            throw new Error("boom");
          },
          { retries: 3, sleep: async () => {} }
        ),
      /boom/
    );
    assert.equal(n, 1);
  });
});
