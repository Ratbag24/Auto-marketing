import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/web/rate-limit.js";

describe("token bucket", () => {
  test("allows a burst up to capacity, then refuses", () => {
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1 });
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      assert.equal(limiter.take("a", now), true, `request ${i + 1} should pass`);
    }
    assert.equal(limiter.take("a", now), false, "the 6th should be refused");
  });

  test("refills over time at the configured rate", () => {
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1 });
    const now = 1_000_000;
    for (let i = 0; i < 5; i += 1) limiter.take("a", now);
    assert.equal(limiter.take("a", now), false);

    // One second buys exactly one more request.
    assert.equal(limiter.take("a", now + 1000), true);
    assert.equal(limiter.take("a", now + 1000), false);
    // Three more seconds, three more requests.
    assert.equal(limiter.take("a", now + 4000), true);
    assert.equal(limiter.take("a", now + 4000), true);
    assert.equal(limiter.take("a", now + 4000), true);
    assert.equal(limiter.take("a", now + 4000), false);
  });

  test("never refills beyond capacity", () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
    const now = 1_000_000;
    limiter.take("a", now);
    // An hour of idleness must not bank an hour of requests.
    let allowed = 0;
    for (let i = 0; i < 20; i += 1) {
      if (limiter.take("a", now + 3_600_000)) allowed += 1;
    }
    assert.equal(allowed, 3);
  });

  test("keys are limited independently", () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 });
    const now = 1_000_000;
    assert.equal(limiter.take("a", now), true);
    assert.equal(limiter.take("a", now), true);
    assert.equal(limiter.take("a", now), false);
    // One noisy visitor must not block everyone else.
    assert.equal(limiter.take("b", now), true);
    assert.equal(limiter.take("b", now), true);
  });

  test("reports how long to wait", () => {
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 0.5 });
    const now = 1_000_000;
    limiter.take("a", now);
    limiter.take("a", now);
    assert.equal(limiter.retryAfter("a", now), 2); // 1 token at 0.5/s
    assert.equal(limiter.retryAfter("a", now + 2000), 0);
    // An unseen key never needs to wait.
    assert.equal(limiter.retryAfter("never-seen", now), 0);
  });
});

describe("memory bounds", () => {
  // The limiter must not become the denial of service it exists to prevent.
  test("stays bounded under a flood of distinct keys", () => {
    const limiter = new RateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      maxEntries: 100,
    });
    for (let i = 0; i < 5000; i += 1) {
      limiter.take(`key_${i}`, 1_000_000 + i);
    }
    assert.ok(
      limiter.size <= 100,
      `expected at most 100 tracked keys, got ${limiter.size}`,
    );
  });

  test("eviction does not let an active abuser through", () => {
    const limiter = new RateLimiter({
      capacity: 3,
      refillPerSecond: 0.0001, // effectively no refill during the test
      maxEntries: 50,
    });
    const now = 1_000_000;

    // Spend the abuser's budget.
    for (let i = 0; i < 3; i += 1) limiter.take("abuser", now);
    assert.equal(limiter.take("abuser", now), false);

    // Flood with other keys to force eviction sweeps.
    for (let i = 0; i < 500; i += 1) limiter.take(`other_${i}`, now);

    // The abuser is still active, so it should not have been evicted ahead of
    // the idle entries.
    assert.equal(limiter.take("abuser", now), false);
  });
});
