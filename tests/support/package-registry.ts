// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { serve } from "./http.ts";
import { nativeVersion } from "./provider-cache.ts";
import { tempDir } from "./resources.ts";

/** A synthetic package source for install orchestration, not a substitute SDK.
 * Native fixture tools use plain definitions and the provider SDK is bundled in
 * opencode. Tests of the real plugin API must use the ordinary prepared cache. */
export async function packageRegistry(
  beforeReply?: () => Promise<void>,
): Promise<{
  url: string;
  requests: string[];
  unexpected: string[];
  shutdown(): Promise<void>;
}> {
  const root = await tempDir("registry-");
  await Deno.mkdir(join(root, "package"));
  const pkg = {
    name: "@opencode-ai/plugin",
    version: nativeVersion,
    type: "module",
    exports: "./index.js",
  };
  await Deno.writeTextFile(
    join(root, "package/package.json"),
    JSON.stringify(pkg),
  );
  await Deno.writeTextFile(join(root, "package/index.js"), "export {};\n");
  const packed = await new Deno.Command("/usr/bin/tar", {
    args: ["-czf", "-", "-C", root, "package"],
    signal: AbortSignal.timeout(5000),
  }).output();
  if (!packed.success) {
    throw new Error(new TextDecoder().decode(packed.stderr));
  }
  const requests: string[] = [], unexpected: string[] = [];
  const archive = `/@opencode-ai/plugin/-/plugin-${nativeVersion}.tgz`;
  const registry = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname);
      requests.push(path);
      await beforeReply?.();
      if (
        request.method === "POST" &&
        path === "/-/npm/v1/security/advisories/bulk"
      ) return Response.json({});
      if (path === archive) {
        return new Response(packed.stdout, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (path === pkg.name || path === "/" + pkg.name) {
        const version = { ...pkg, dist: { tarball: url + archive } };
        return Response.json({
          name: pkg.name,
          "dist-tags": { latest: nativeVersion },
          versions: { [nativeVersion]: version },
        });
      }
      unexpected.push(path);
      return new Response(`Unexpected fixture package request: ${path}`, {
        status: 404,
      });
    },
  );
  const url = `http://127.0.0.1:${registry.addr.port}`;
  return { url, requests, unexpected, shutdown: () => registry.shutdown() };
}
