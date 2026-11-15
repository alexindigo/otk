// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { resources } from "./resources.ts";
import type { NativeFixture } from "./native-fixture.ts";

/** Source-backed envelopes, not fabricated native endpoints. The legacy config
 * envelope and HTTP 400 wrapper are in stock 2.2.6 app/runtime/server/errors.test.ts
 * (lines 43-52, 118-119). That app explicitly supports the V1 named-error shape.
 * Model HTTP 404 and its complete tagged body use stock v1.19.3
 * opencode/src/server/routes/instance/httpapi/errors.ts:80-89; suggestion values
 * use app/src/utils/server-errors.test.ts:120-126. The tagged UnauthorizedError and
 * HTTP 401 are protocol/src/errors.ts:41-45. No raw config or provider body is sent. */
export const submitRejections = {
  // Stock server/src/location.ts:36-45 and protocol/src/errors.ts:65-71.
  unavailable: {
    status: 503,
    body: {
      _tag: "ServiceUnavailableError",
      message: "Location plugins did not finish activating",
      service: "plugin",
    },
  },
  config: {
    status: 400,
    body: {
      name: "ConfigInvalidError",
      data: {
        path: "opencode.config.ts",
        issues: [{ path: ["settings", "host"], message: "Required" }, {
          path: ["mode"],
          message: "Invalid",
        }],
      },
    },
  },
  model: {
    status: 404,
    body: {
      _tag: "ModelNotFoundError",
      message: "Model not found: x/y",
      providerID: "x",
      modelID: "y",
      suggestions: ["x/y2", "x/y3"],
    },
  },
  auth: {
    status: 401,
    body: { _tag: "UnauthorizedError", message: "Unauthorized" },
  },
} as const;
export type SubmitRejection = keyof typeof submitRejections;

/** Only POST submit is replaced. All discovery, sessions, SSE, snapshots and
 * storage run against the stock native. The rejected body never reaches it. */
export function submitFailureScenario(native: Pick<NativeFixture, "url">) {
  let kind: SubmitRejection = "config", rejected = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const url = new URL(request.url);
      if (
        request.method === "POST" &&
        /\/session\/[^/]+\/(?:prompt|prompt_async)$/.test(url.pathname)
      ) {
        rejected++;
        const fixture = submitRejections[kind];
        return Response.json(fixture.body, { status: fixture.status });
      }
      return fetch(
        new Request(new URL(url.pathname + url.search, native.url), request),
      );
    },
  );
  resources().defer(
    "submit rejection fixture",
    () => server.shutdown(),
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    release() {},
    observe: () => ({ rejected, kind }),
    control(action: string) {
      if (action === "fail") action = "model";
      if (!(action in submitRejections)) {
        throw new Error("Unknown submit rejection");
      }
      kind = action as SubmitRejection;
    },
  };
}

/** A test-owned registration copy, leaving the managed native registration intact. */
export async function failureEndpoint(native: NativeFixture, url: string) {
  if (native.kind !== "opencode-v2-server") return { ...native, url };
  const state = join(native.root, "failure-discovery");
  await Deno.mkdir(join(state, "opencode"), { recursive: true });
  const registration = JSON.parse(
    await Deno.readTextFile(
      join(native.discoveryEnv.XDG_STATE_HOME, "opencode/service.json"),
    ),
  );
  await Deno.writeTextFile(
    join(state, "opencode/service.json"),
    JSON.stringify({ ...registration, url }),
    { mode: 0o600 },
  );
  return {
    ...native,
    url,
    discoveryEnv: { ...native.discoveryEnv, XDG_STATE_HOME: state },
  };
}
