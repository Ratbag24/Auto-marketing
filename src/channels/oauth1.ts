import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a request signing. X still requires this for posting with user
 * context, so there is no avoiding it.
 */

export interface OAuth1Credentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

/**
 * Builds the Authorization header for a signed request.
 *
 * Note: only query parameters are signed. A JSON request body is not part of
 * the OAuth 1.0a signature base string, which is what X's v2 endpoints expect.
 */
export function buildAuthHeader(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  queryParams: Record<string, string> = {},
  /** Overridable only so the signature can be tested against a known vector. */
  fixed: { nonce?: string; timestamp?: string } = {},
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: fixed.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: fixed.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  const allParams = { ...oauthParams, ...queryParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k]!)}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(
    creds.accessSecret,
  )}`;

  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };

  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k]!)}"`)
      .join(", ")
  );
}
