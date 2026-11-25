// SPDX-License-Identifier: LGPL-3.0-only
const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let ascendingClock = 0n;

/** Six-byte time/counter plus fourteen base62 characters, with a caller prefix.
 * Matches Identifier.ascending's encoding; one clock owns all record kinds.
 * Carry the counter on overflow or clock rollback rather than reverse order.
 */
export function ascendingID(prefix: string): string {
  const now = BigInt(Date.now()) * 0x1000n + 1n;
  ascendingClock = now > ascendingClock ? now : ascendingClock + 1n;
  const time = BigInt.asUintN(48, ascendingClock).toString(16).padStart(
    12,
    "0",
  );
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return `${prefix}_${time}${
    Array.from(bytes, (byte) => alphabet[byte % 62]).join("")
  }`;
}

/** RFC 4122 v4, including on plain HTTP. Never substitute non-random IDs. */
export function randomID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join("")).join("-");
}
