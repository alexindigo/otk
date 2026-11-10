// SPDX-License-Identifier: LGPL-3.0-only
import { serve } from "./http.ts";
import { resources } from "./resources.ts";
import { type BrowserNative, browserScenarioPath } from "./browser-native.ts";

/** Suppress only native reporting; the real native still owns send/defaults. */
export function nativeComposerScenario(oc: BrowserNative) {
  const bodies: Record<string, unknown>[] = [];
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const actual = new URL(request.url), url = new URL(request.url);
      url.pathname = browserScenarioPath(oc, url.pathname, request.method);
      if (
        request.method === "POST" && url.pathname.endsWith("/prompt_async")
      ) bodies.push(await request.clone().json());
      const response = await fetch(
        new Request(oc.url + actual.pathname + actual.search, request),
      );
      if (
        request.method !== "GET" || url.pathname !== "/config"
      ) return response;
      const config = await response.json();
      if (oc.kind === "opencode-v2-server") {
        for (const entry of config) {
          if (entry.type === "document") delete entry.info.model;
        }
      } else delete config.model;
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
