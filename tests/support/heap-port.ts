// SPDX-License-Identifier: LGPL-3.0-only
/** Runtime-neutral diagnostic port; browser input/navigation stays in Playwright. */
export interface HeapPort {
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  events: { method: string; params: Record<string, unknown> }[];
}
