// SPDX-License-Identifier: LGPL-3.0-only
/** V2 accepts a caller-owned inbox identity, retained as the prompt identity. */
export function submissionID(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}
