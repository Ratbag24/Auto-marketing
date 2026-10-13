import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthHeader } from "../src/channels/oauth1.js";

/**
 * Verified against the worked example X publishes for OAuth 1.0a request
 * signing. If this breaks, every post to X fails with a 401, so it is worth
 * pinning to a known-good vector rather than trusting the implementation.
 */
test("produces the signature from X's published example", () => {
  const header = buildAuthHeader(
    "POST",
    "https://api.twitter.com/1.1/statuses/update.json",
    {
      apiKey: "xvz1evFS4wEEPTGEFPHBog",
      apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    },
    {
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      include_entities: "true",
    },
    {
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
    },
  );

  assert.match(header, /^OAuth /);
  assert.ok(
    header.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'),
    `signature did not match the published vector. Got: ${header}`,
  );
});

test("percent-encodes reserved characters per RFC 3986", () => {
  const header = buildAuthHeader(
    "GET",
    "https://api.x.com/2/tweets",
    { apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "ts" },
    { q: "a b&c=d!*'()" },
    { nonce: "n", timestamp: "1" },
  );
  // Reserved characters must never appear raw in the header.
  assert.ok(!/[!'()*]/.test(header.split("oauth_signature=")[1] ?? ""));
});

test("different nonces produce different signatures", () => {
  const creds = { apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "ts" };
  const a = buildAuthHeader("POST", "https://api.x.com/2/tweets", creds, {}, {
    nonce: "one",
    timestamp: "1",
  });
  const b = buildAuthHeader("POST", "https://api.x.com/2/tweets", creds, {}, {
    nonce: "two",
    timestamp: "1",
  });
  assert.notEqual(a, b);
});
