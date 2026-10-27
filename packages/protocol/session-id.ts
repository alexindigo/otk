// SPDX-License-Identifier: LGPL-3.0-only
/** Provider-qualified session identity; message, request and task IDs are separate. */
export function isSessionID(value: unknown): value is string {
  return typeof value === "string" &&
    /^[a-z]{3}v[0-9]+-[A-Za-z0-9_-]+$/.test(value);
}
