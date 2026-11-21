// SPDX-License-Identifier: LGPL-3.0-only
import { ascendingID } from "@otk/protocol";
/** Native sortable message IDs let provenance bind before prompt dispatch. */
export function submissionID(): string {
  return ascendingID("msg");
}
