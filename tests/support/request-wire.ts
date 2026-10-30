// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ClientFrame,
  ClientRequestPolicy,
  PublicFailure,
} from "@otk/protocol";
import type { Rpc } from "@otk/client";
export const fixtureRequestPolicy: ClientRequestPolicy = {
  livenessms: 30000,
  stoppingms: 10000,
  httpms: 15000,
  pingms: 20000,
  silencems: 60000,
  retrybase: 1000,
  retrymax: 30000,
  resumebatch: 64,
  maxpending: 512,
  inputbytes: 67108864,
};
export const fixtureRequests = () => ({
  window: { id: crypto.randomUUID(), expiresAt: Date.now() + 86400000 },
  policy: fixtureRequestPolicy,
  principal: "fixture",
});
export function connectRequests(rpc: Rpc): void {
  const value = fixtureRequests();
  rpc.requests.connect(value.window, value.policy.resumebatch, value.principal);
}
export type FixtureRequest = Extract<ClientFrame, { t: "request" }>;
export function replyRequest(
  rpc: Rpc,
  frame: FixtureRequest,
  result: unknown,
  error?: PublicFailure,
): void {
  rpc.receive({
    t: "request.accepted",
    ref: frame.ref,
    seq: 1,
    acceptedAt: Date.now(),
    retentionUntil: Date.now() + 86400000,
    replayed: false,
  });
  rpc.receive({
    t: "request.result",
    ref: frame.ref,
    seq: 2,
    outcome: error ? { ok: false, error } : { ok: true, result },
  });
}
export const fixtureFailure = (code = "fixture"): PublicFailure => ({
  code,
  retry: "new-intent",
  diagnosticID: crypto.randomUUID(),
});
export function originFetch(base: string): typeof fetch {
  return (input, options) => {
    const headers = new Headers(options?.headers);
    headers.set("Origin", new URL(base).origin);
    return fetch(input, { ...options, headers });
  };
}
/** Memory-only HTTP transport fixture; acceptance and result remain separate exchanges. */
export function bootstrapFetch(
  result: unknown = {
    authenticated: true,
    setupRequired: false,
    authType: "none",
    principal: "fixture",
    requests: fixtureRequests(),
  },
): typeof fetch {
  const results = new Map<string, unknown>();
  return (input, options) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    const body = typeof options?.body === "string"
      ? JSON.parse(options.body)
      : undefined;
    const ref = body?.ref ??
      JSON.parse(new Headers(options?.headers).get("X-OTK-Request")!);
    const acceptance = {
      t: "request.accepted",
      ref,
      seq: 1,
      acceptedAt: Date.now(),
      retentionUntil: Date.now() + 86400000,
      replayed: false,
    };
    if (path.endsWith("request-events")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(acceptance) + "\n" +
            JSON.stringify({
              t: "request.result",
              ref,
              seq: 2,
              outcome: { ok: true, result: results.get(ref.key) },
            }) + "\n",
        ),
      );
    }
    results.set(ref.key, result);
    return Promise.resolve(Response.json(acceptance, { status: 202 }));
  };
}
