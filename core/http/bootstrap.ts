// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { OtkDb } from "@otk/store";
import {
  type ClientRequestPolicy,
  PROTOCOL_VERSION,
  requestFingerprint,
  type RequestRef,
  type RequestWindow,
  SIDECAR_VERSION,
} from "@otk/protocol";
import type { AuthState } from "../auth/state.ts";
import { allowedOrigin } from "../auth/middleware.ts";
import { clientRequestPolicy, type ServiceConfig } from "../config/schema.ts";
import { RpcRegistry } from "../ws/registry.ts";
import { object, text } from "../ws/params.ts";
import { ExecutionFailure } from "../requests/failures.ts";
import {
  metadataReceipt,
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { HttpRequestAdapter } from "./requests.ts";

interface BootstrapInput {
  origin: string;
  cookie: string | null;
  input: unknown;
}
interface Discovery {
  authenticated: boolean;
  setupRequired: boolean;
  authType: string;
  principal: string;
  requests: { window: RequestWindow; policy: ClientRequestPolicy };
}
interface Health {
  ok: true;
  version: string;
  protocol: number;
  harness: { kind: string; version: string };
  requests: { window: RequestWindow; policy: ClientRequestPolicy };
}
declare module "@otk/protocol" {
  interface RequestReceipts {
    "bootstrap-complete": { ok: true };
  }
  interface RpcMethods {
    "bootstrap.login": { params: BootstrapInput; result: { ok: true } };
    "bootstrap.setup": { params: BootstrapInput; result: { ok: true } };
    "bootstrap.logout": { params: BootstrapInput; result: { ok: true } };
    "bootstrap.session": { params: BootstrapInput; result: Discovery };
    "bootstrap.health": { params: BootstrapInput; result: Health };
  }
}
export interface BootstrapOptions {
  cfg: ServiceConfig;
  auth: AuthState;
  backend: Harness;
  store: OtkDb;
  window(): RequestWindow;
  diagnostic?(id: string, cause: unknown): void;
}
const identity = (origin: string, ref: Pick<RequestRef, "clientID" | "key">) =>
  JSON.stringify([origin, ref.clientID, ref.key]);
const complete = metadataReceipt("bootstrap-complete", (value) => {
  if (object(value).ok !== true) {
    throw new TypeError("Invalid bootstrap completion");
  }
  return { ok: true };
});
const reject = (code: string, cause?: unknown): never => {
  const error = new ExecutionFailure({ code, retry: "new-intent" });
  error.cause = cause;
  throw error;
};

/** Reflective HTTP routes select these features; they share the ordinary coordinator. */
export class BootstrapRequests {
  readonly adapter: HttpRequestAdapter;
  readonly registry: RpcRegistry;
  #cookies = new Map<string, { headers: Headers; expires: number }>();
  constructor(readonly options: BootstrapOptions) {
    const { cfg, auth, backend, store } = options;
    const registry = this.registry = new RpcRegistry(backend, store);
    const input = (p: Record<string, unknown>): BootstrapInput => {
      if (p.cookie !== null && typeof p.cookie !== "string") {
        reject("request.params");
      }
      return {
        origin: text(p, "origin")!,
        cookie: p.cookie as string | null,
        input: p.input,
      };
    };
    const cookieRequest = (p: BootstrapInput) =>
      new Request("http://bootstrap.invalid/", {
        headers: p.cookie ? { cookie: p.cookie } : undefined,
      });
    const discovery = () => ({
      window: options.window(),
      policy: clientRequestPolicy(cfg),
    });
    const cookie = (
      p: BootstrapInput,
      ref: Pick<RequestRef, "clientID" | "key">,
      value: string,
    ) => {
      this.#cookies.set(identity(p.origin, ref), {
        headers: new Headers({ "Set-Cookie": value }),
        expires: Date.now() + cfg.requests.windowms + cfg.requests.retentionms,
      });
    };
    registry.register("bootstrap.login", {
      execution: nativeExecution(() => ({ resource: "login" }), complete),
      params: (p) => {
        const parsed = input(p), values = object(parsed.input);
        return {
          ...parsed,
          input: {
            username: text(values, "username")!,
            password: text(values, "password")!,
          },
        };
      },
      handler: (ctx, p) =>
        nativeEffect(ctx, async () => {
          if (auth.setupRequired) reject("setup.required");
          if (auth.local) {
            let token: string;
            try {
              token = await auth.local.login(
                p.input.username,
                p.input.password,
              );
            } catch (cause) {
              reject("credentials", cause);
            }
            cookie(p, ctx.execution!.key, auth.cookie(token!));
          }
          return { ok: true as const };
        }, complete),
    });
    registry.register("bootstrap.setup", {
      execution: nativeExecution(() => ({ resource: "setup" }), complete),
      params: (p) => {
        const parsed = input(p),
          values = object(parsed.input),
          type = text(values, "type")!;
        if (type !== "none" && type !== "password") reject("setup.type");
        const username = text(values, "username", true),
          password = text(values, "password", true);
        if (type === "password" && (!username?.trim() || !password)) {
          reject("setup.credentials");
        }
        return { ...parsed, input: { type, username, password } };
      },
      handler: (ctx, p) =>
        nativeEffect(ctx, async () => {
          if (!auth.setupRequired) reject("setup.configured");
          try {
            await auth.setup(p.input);
            if (auth.local) {
              const token = await auth.local.login(
                p.input.username!,
                p.input.password!,
              );
              cookie(p, ctx.execution!.key, auth.cookie(token));
            }
          } catch (cause) {
            reject(
              auth.setupRequired ? "setup.rejected" : "setup.configured",
              cause,
            );
          }
          return { ok: true as const };
        }, complete),
    });
    registry.register("bootstrap.logout", {
      execution: nativeExecution(() => ({ resource: "logout" }), complete),
      params: input,
      handler: (ctx, p) =>
        nativeEffect(ctx, async () => {
          if (!await auth.authenticated(cookieRequest(p))) {
            reject("authentication.required");
          }
          cookie(p, ctx.execution!.key, auth.cookie("", true));
          return { ok: true as const };
        }, complete),
    });
    registry.register("bootstrap.session", {
      execution: readExecution(() => ({ resource: "auth-discovery" })),
      params: input,
      handler: async (_ctx, p) => ({
        authenticated: await auth.authenticated(cookieRequest(p)),
        setupRequired: auth.setupRequired,
        authType: cfg.auth.type,
        principal: await requestFingerprint(
          `principal:${cfg.auth.username.toLowerCase() || "local"}`,
        ),
        requests: discovery(),
      }),
    });
    registry.register("bootstrap.health", {
      execution: readExecution(() => ({ resource: "health" })),
      params: input,
      handler: (): Health => ({
        ok: true,
        version: SIDECAR_VERSION,
        protocol: PROTOCOL_VERSION,
        harness: { kind: backend.core.kind, version: backend.core.version },
        requests: discovery(),
      }),
    });
    this.adapter = new HttpRequestAdapter({
      registry,
      policy: cfg.requests,
      diagnostic: options.diagnostic,
      resultHeaders: (ref, _event, origin) =>
        this.#cookies.get(identity(origin, ref))?.headers,
    });
  }
  start(): Promise<void> {
    return this.adapter.start();
  }
  stop(): Promise<void> {
    this.#cookies.clear();
    return this.adapter.stop();
  }
  admit(
    method: string,
    request: Request,
    ref: RequestRef,
    input: unknown,
    secret: string,
  ): Promise<Response> {
    if (request.method !== "GET" && !allowedOrigin(request, this.options.cfg)) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    for (const [key, value] of this.#cookies) {
      if (value.expires <= Date.now()) this.#cookies.delete(key);
    }
    const origin = request.headers.get("origin") ?? new URL(request.url).origin;
    return this.adapter.admit(
      method,
      ref,
      { origin, cookie: request.headers.get("cookie"), input: input ?? null },
      secret,
      origin,
    );
  }
  events(
    request: Request,
    ref: RequestRef,
    after: number,
    secret: string,
  ): Promise<Response> {
    if (!allowedOrigin(request, this.options.cfg)) {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    return this.adapter.events(
      ref,
      after,
      secret,
      request.headers.get("origin")!,
    );
  }
}
