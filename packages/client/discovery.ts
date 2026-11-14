// SPDX-License-Identifier: LGPL-3.0-only
import { clientRequestPolicyFrom, PROTOCOL_VERSION } from "@otk/protocol";
import type { AuthStatus } from "./auth.ts";
import { type Feedback, FeedbackFailure, RequestFailure } from "./failures.ts";
import { createState, type StateFactory } from "./state.ts";
import { HttpReadFailure } from "./http-requests.ts";

export type DiscoveryStepKey = "connecting" | "identity" | "sign-in";
export interface DiscoveryStep {
  key: DiscoveryStepKey;
  label: string;
  elapsedMs: number;
  result?: { kind: "ok" | "error" | "cancelled"; text: string };
}
export interface DiscoveryState {
  target: string;
  pending: boolean;
  steps: DiscoveryStep[];
}
export type DiscoveryOutcome =
  | { kind: "ready" | "login-required" | "setup-required"; auth: AuthStatus }
  | { kind: "failed" | "cancelled"; feedback: Feedback };
export interface Discovery {
  readonly state: DiscoveryState;
  subscribe(listener: (state: DiscoveryState) => void): () => void;
  start(): Promise<DiscoveryOutcome>;
  cancel(): Promise<void>;
}
/** Safe feature-owned facts, shared by result rows and ordinary failure feedback. */
export function discoveryFailure(
  target: string,
  reason: string,
  next: string,
): FeedbackFailure {
  return new FeedbackFailure({
    kind: "error",
    text: `Could not check OTK at ${target}: ${reason}. ${next}`,
  });
}
export function authStatus(value: unknown, target: string): AuthStatus {
  const invalid = () =>
    discoveryFailure(
      target,
      "OTK returned invalid sign-in data",
      "Check that the server and this page run matching OTK versions, then reload",
    );
  if (!value || typeof value !== "object") {
    throw invalid();
  }
  const auth = value as AuthStatus;
  if (
    typeof auth.authenticated !== "boolean" ||
    typeof auth.setupRequired !== "boolean" ||
    typeof auth.authType !== "string" || typeof auth.principal !== "string" ||
    !auth.requests || typeof auth.requests.window?.id !== "string" ||
    !Number.isFinite(auth.requests.window.expiresAt)
  ) throw invalid();
  try {
    clientRequestPolicyFrom(auth.requests.policy);
  } catch {
    throw invalid();
  }
  return auth;
}
/** A read-only discovery attempt. Elapsed time is publication, never a deadline.
 * Cancellation joins the owned header/body/session work before releasing callers. */
export function createDiscovery(options: {
  base: URL;
  origin?: string;
  fetcher?: typeof fetch;
  signIn(signal: AbortSignal): Promise<AuthStatus>;
  clock?: { now(): number; every(tick: () => void): () => void };
}, factory: StateFactory = createState): Discovery {
  const target = options.base.href.replace(/\/api\/$/, "");
  const store = factory<DiscoveryState>({ target, pending: false, steps: [] });
  const clock = options.clock ??
    {
      now: () => Date.now(),
      every(tick: () => void) {
        const timer = setInterval(tick, 1000);
        return () => clearInterval(timer);
      },
    };
  let active: Promise<DiscoveryOutcome> | undefined,
    controller: AbortController | undefined;
  let stepStarted = 0;
  const tick = () =>
    store.update((draft) => {
      const step = draft.steps.at(-1);
      if (step && !step.result) {
        step.elapsedMs = Math.max(0, clock.now() - stepStarted);
      }
    });
  const begin = (key: DiscoveryStepKey, label: string) => {
    stepStarted = clock.now();
    store.update((draft) => {
      draft.steps.push({ key, label, elapsedMs: 0 });
    });
  };
  const end = (kind: "ok" | "error" | "cancelled", text: string) => {
    tick();
    store.update((draft) => {
      const step = draft.steps.at(-1);
      if (step && !step.result) step.result = { kind, text };
    });
  };
  return {
    state: store.state,
    subscribe: store.subscribe,
    start() {
      if (active) return active;
      const deferred = Promise.withResolvers<DiscoveryOutcome>();
      active = deferred.promise;
      const abort = controller = new AbortController();
      store.update((draft) => {
        draft.pending = true;
        draft.steps = [];
      });
      begin("connecting", "Connecting");
      const stopClock = clock.every(tick);
      const work = Promise.resolve().then(
        async (): Promise<DiscoveryOutcome> => {
          let response: Response | undefined;
          try {
            abort.signal.throwIfAborted();
            response = await (options.fetcher ?? fetch)(
              new URL("discovery", options.base),
              { credentials: "omit", cache: "no-store", signal: abort.signal },
            );
            abort.signal.throwIfAborted();
            end("ok", "Server replied");
            begin("identity", "Checking it is OTK");
            if (!response.ok) {
              throw discoveryFailure(
                target,
                `the address did not return an OTK discovery reply (HTTP ${response.status})`,
                "Check the OTK address, not the opencode address",
              );
            }
            let data: unknown;
            try {
              data = await response.json();
            } catch {
              abort.signal.throwIfAborted();
              throw discoveryFailure(
                target,
                `the reply is not OTK discovery data (HTTP ${response.status})`,
                "Check the OTK address, not the opencode address",
              );
            }
            abort.signal.throwIfAborted();
            const value = data as Record<string, unknown> | null;
            if (
              !value || value.product !== "otk" ||
              !Number.isSafeInteger(value.protocol) ||
              typeof value.version !== "string" ||
              typeof value.originAllowed !== "boolean" ||
              !["setup", "login", "none"].includes(String(value.signIn))
            ) {
              throw discoveryFailure(
                target,
                `the reply is not OTK discovery data (HTTP ${response.status})`,
                "Check the OTK address, not the opencode address",
              );
            }
            if (value.protocol !== PROTOCOL_VERSION) {
              throw discoveryFailure(
                target,
                `OTK protocol ${value.protocol} does not match this page's protocol ${PROTOCOL_VERSION}`,
                "Update OTK and reload this page together",
              );
            }
            if (!value.originAllowed) {
              throw discoveryFailure(
                target,
                `OTK has not allowed this page's origin ${
                  options.origin ?? globalThis.location?.origin ?? "(unknown)"
                }`,
                "Add that origin to [server].origins in ~/.config/otk/otk.toml on that computer, then restart OTK",
              );
            }
            end("ok", `OTK ${value.version}; page origin allowed`);
            begin("sign-in", "Sign-in");
            const auth = authStatus(await options.signIn(abort.signal), target);
            abort.signal.throwIfAborted();
            const kind = auth.setupRequired
              ? "setup-required"
              : !auth.authenticated
              ? "login-required"
              : "ready";
            end(
              "ok",
              kind === "setup-required"
                ? `Setup required at ${target}. Open OTK there to finish setup`
                : kind === "login-required"
                ? `Sign-in required at ${target}. Sign in with that server's OTK credentials`
                : "Sign-in checked; server ready",
            );
            return { kind, auth };
          } catch (cause) {
            const cancelled = abort.signal.aborted;
            const failure = cancelled
              ? new FeedbackFailure({
                kind: "info",
                text:
                  `Checking OTK at ${target} was cancelled. Edit the address or check again`,
              })
              : cause instanceof FeedbackFailure
              ? cause
              : discoveryFailure(
                target,
                cause instanceof RequestFailure
                  ? `OTK rejected the sign-in check (${cause.failure.code}); no further reason was supplied`
                  : cause instanceof HttpReadFailure
                  ? cause.reason
                  : cause instanceof DOMException &&
                      cause.name === "TimeoutError"
                  ? "the transport reported a timeout"
                  : store.state.steps.at(-1)?.key === "sign-in"
                  ? "the sign-in check stopped without a reported reason"
                  : "the browser could not connect to this address",
                "Check that OTK is running at this address and reachable from this page, then check again",
              );
            end(cancelled ? "cancelled" : "error", failure.feedback.text);
            return {
              kind: cancelled ? "cancelled" : "failed",
              feedback: failure.feedback,
            };
          } finally {
            await response?.body?.cancel().catch(() => {});
            stopClock();
            active = undefined;
            controller = undefined;
            store.update((draft) => {
              draft.pending = false;
            });
          }
        },
      );
      void work.then(deferred.resolve, deferred.reject);
      return deferred.promise;
    },
    async cancel() {
      controller?.abort();
      await active;
    },
  };
}
