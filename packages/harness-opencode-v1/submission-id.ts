// SPDX-License-Identifier: LGPL-3.0-only
let clock = 0n;
/** Native sortable message IDs let provenance bind before prompt dispatch. */
export function submissionID(): string {
  const now = BigInt(Date.now()) * 0x1000n;
  clock = now > clock ? now : clock + 1n;
  return `msg_${clock.toString(16).slice(-12)}${
    crypto.randomUUID().replaceAll("-", "").slice(0, 14)
  }`;
}
