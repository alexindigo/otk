// SPDX-License-Identifier: LGPL-3.0-only
import type { OperationContext } from "@otk/protocol";
import type { V2Client } from "./client.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
/** Interrupt has its own priority and does not join the ordinary same-session prompt queue. */
export async function interrupt(
  client: V2Client,
  id: string,
  operation?: OperationContext,
): Promise<void> {
  // Omit resume: stopping an idle session is still success and must not wake control work.
  await client.effect(
    (api) => api.session.interrupt({ sessionID: ids.decode(id) }),
    operation,
  );
}
