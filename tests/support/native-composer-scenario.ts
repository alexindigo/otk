// SPDX-License-Identifier: LGPL-3.0-only
import { serve } from "./http.ts";
import { resources } from "./resources.ts";
import type { OpencodeTest } from "./opencode.ts";

/** Suppress only native reporting; the real native still owns send/defaults. */
export function nativeComposerScenario(oc: OpencodeTest) {
  const bodies: Record<string, unknown>[] = [];
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (
        request.method === "POST" && url.pathname.endsWith("/prompt_async")
      ) bodies.push(await request.clone().json());
      const response = await fetch(
        new Request(oc.url + url.pathname + url.search, request),
      );
      if (
        request.method !== "GET" || url.pathname !== "/config"
      ) return response;
      const config = await response.json();
      delete config.model;
      return Response.json(config);
    },
  );
  resources().defer("native default reporting proxy", () => proxy.shutdown());
  return {
    port: proxy.addr.port,
    url: `http://127.0.0.1:${proxy.addr.port}`,
    observe: () => ({ bodies }),
    release() {},
    control(_action: "hold" | "release" | "freeze" | "thaw", _id?: string) {
      throw new Error("No control for native reporting proxy");
    },
  };
}
