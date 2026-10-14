// SPDX-License-Identifier: LGPL-3.0-only
export function summarizePaste(text: string, enabled: boolean): boolean {
  return enabled &&
    (text.trim().split("\n").length >= 3 || text.trim().length > 150);
}
