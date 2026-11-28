// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelRef, OperationContext } from "@otk/protocol";
import { OperationFailure } from "@otk/protocol";
import type { V2Client } from "./client.ts";
import type { NativeSession } from "./messages.ts";

/** Neutral agent/model/variant choice for one native submission. */
export interface SelectionInput {
  agent?: string;
  model?: ModelRef;
  variant?: string;
}

type Identity = { providerID: string; id: string };
const sameModel = (a?: Identity | null, b?: Identity | null) =>
  !!a && !!b && a.providerID === b.providerID && a.id === b.id;

/** The only V2 builder of a native model value. Resolve neutral applied
 * defaults before any native selection mutation: V2 stops applying an agent's
 * model defaults once a session model is selected. */
export async function selectionModel(
  client: V2Client,
  session: NativeSession,
  input: SelectionInput,
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
  const identity = { providerID: input.model.provider, id: input.model.model };
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
    if (sameModel(applied, identity)) variant = applied?.variant;
  }
  return { ...identity, ...(variant === undefined ? {} : { variant }) };
}

/** Apply an explicit agent/model choice before a native submission. Each
 * native change is followed by the caller's metadata-only checkpoint. */
export async function applySelection(
  client: V2Client,
  raw: NativeSession,
  input: SelectionInput,
  operation: OperationContext | undefined,
  checkpoint: (
    raw: NativeSession,
    change: "agent" | "model",
  ) => Promise<void>,
): Promise<NativeSession> {
  const model = await selectionModel(client, raw, input, operation);
  if (input.agent !== undefined && input.agent !== raw.agent) {
    await client.effect(
      (api) =>
        api.session.switchAgent({ sessionID: raw.id, agent: input.agent! }),
      operation,
    );
    raw = { ...raw, agent: input.agent };
    await checkpoint(raw, "agent");
  }
  if (
    model &&
    (!sameModel(model, raw.model) ||
      (model.variant ?? "default") !== (raw.model?.variant ?? "default"))
  ) {
    await client.effect(
      (api) => api.session.switchModel({ sessionID: raw.id, model }),
      operation,
    );
    raw = { ...raw, model };
    await checkpoint(raw, "model");
  }
  return raw;
}
