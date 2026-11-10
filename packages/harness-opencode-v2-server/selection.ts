// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef, OperationContext } from "@otk/protocol";
import { OperationFailure } from "@otk/protocol";
import type { V2Client } from "./client.ts";
import type { NativeSession } from "./messages.ts";

/** Resolve neutral applied defaults before any native selection mutation.
 * V2 stops applying an agent's model defaults once a session model is selected. */
export async function selectionModel(
  client: V2Client,
  session: NativeSession,
  input: { agent?: string; model?: ModelRef; variant?: string },
  operation?: OperationContext,
): Promise<NativeSession["model"] | undefined> {
  if (!input.model) {
    if (input.variant === undefined) return undefined;
    if (session.model) return { ...session.model, variant: input.variant };
    throw new OperationFailure(
      "rejected",
      "native.rejected",
      new Error("A model is required to choose a variant"),
    );
  }
  let variant = input.variant;
  const agent = input.agent ?? session.agent;
  if (variant === undefined && agent) {
    const agents = await client.read(
      (api) =>
        api.agent.list({ location: session.location }, {
          signal: operation?.signal,
        }),
      operation?.signal,
    );
    const applied = agents.data.find((entry) => entry.id === agent)?.model;
    if (
      applied?.providerID === input.model.provider &&
      applied.id === input.model.model
    ) variant = applied.variant;
  }
  return {
    providerID: input.model.provider,
    id: input.model.model,
    ...(variant === undefined ? {} : { variant }),
  };
}
