// SPDX-License-Identifier: LGPL-3.0-only
export const sessionIDQualifier: string = String.raw`[a-z]{3}v[0-9]+-`;
const qualified = new RegExp(`^${sessionIDQualifier}[A-Za-z0-9_-]+$`);

/** Provider-qualified session identity; message, request and task IDs are separate. */
export function isSessionID(value: unknown): value is string {
  return typeof value === "string" &&
    qualified.test(value);
}
