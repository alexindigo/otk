// SPDX-License-Identifier: LGPL-3.0-only
import { type APIRequestContext, expect } from "@playwright/test";

/** Auth journeys own auth facts and credential secrecy, not bootstrap inventory. */
export async function expectPublicSession(
  request: APIRequestContext,
  url: string,
  expected: {
    authenticated: boolean;
    setupRequired: boolean;
    authType: string;
  },
  secrets: readonly string[] = [],
) {
  const response = await request.get(new URL("api/session", url).href);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body).toMatchObject(expected);
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/"(?:password|totpkey|secretkey)"\s*:/i);
  for (const secret of secrets) expect(text).not.toContain(secret);
}
