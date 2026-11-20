// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "@playwright/test";

export function assertCrumbCoverage(
  ancestry: readonly string[],
  shown: string[],
  omitted: string[],
) {
  expect(omitted).toEqual(ancestry.filter((id) => !shown.includes(id)));
  expect(ancestry.every((id) => shown.includes(id) || omitted.includes(id)))
    .toBe(true);
}
