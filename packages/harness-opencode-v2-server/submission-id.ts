// SPDX-License-Identifier: LGPL-3.0-only
import { ascendingID } from "@otk/protocol";
/** V2 accepts a caller-owned inbox identity, retained as the prompt identity. */
export function submissionID(): string {
  return ascendingID("msg");
}
