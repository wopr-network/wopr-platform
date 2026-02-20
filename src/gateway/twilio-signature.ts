/**
 * Twilio webhook signature verification.
 *
 * Implements Twilio's X-Twilio-Signature HMAC-SHA1 verification
 * without requiring the full twilio npm package.
 *
 * Algorithm: https://www.twilio.com/docs/usage/security#validating-requests
 * 1. Take the full URL of the request
 * 2. Sort POST parameters alphabetically by key
 * 3. Append each key-value pair (no separator) to the URL string
 * 4. HMAC-SHA1 hash the result using the auth token as the key
 * 5. Base64-encode the hash
 * 6. Compare to the X-Twilio-Signature header using timing-safe equality
 */

import crypto from "node:crypto";

/**
 * Verify a Twilio webhook signature.
 *
 * @param authToken - Twilio auth token (the signing secret)
 * @param signature - Value of the X-Twilio-Signature header
 * @param url - The full URL Twilio sent the request to
 * @param params - The POST body parameters as a flat key-value record
 * @returns true if the signature is valid
 */
export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;

  // Build the data string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");

  // Timing-safe comparison — must be same length to avoid timing oracle
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
