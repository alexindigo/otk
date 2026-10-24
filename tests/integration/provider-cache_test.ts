// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serve } from "../support/http.ts";
import { ownedProcess } from "../support/process.ts";
import { bounded, resources, tempDir, test } from "../support/resources.ts";
import { validateProviderCache } from "../support/provider-cache.ts";
import { packageRegistry } from "../support/package-registry.ts";

test("test tasks prepare one shared native package cache on concurrent cold starts and reuse it offline", async () => {
  const root = await tempDir("provider-cache-task-");
  const cache = join(root, "packages");
  const source = await packageRegistry();
  const run = async (env: Record<string, string> = {}) => {
    const { child } = ownedProcess(Deno.execPath(), [
      "task",
      "test",
      "--filter",
      "pre-populated packages serve independent native tools",
      "tests/integration/fixture-lifetime_test.ts",
    ], {
      env: {
        ...Deno.env.toObject(),
        NO_COLOR: "1",
        OTK_TEST_PROVIDER_CACHE: cache,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (data) => output += data.toString());
    child.stderr!.on("data", (data) => output += data.toString());
    const code = await bounded(
      "native cache task",
      new Promise<number | null>((resolve) => child.once("close", resolve)),
      180_000,
    );
    return { code, output };
  };
  // Both task processes start with the same absent cache, not an inherited VM cache.
  const cold = await Promise.all([0, 1].map((id) =>
    run({
      npm_config_registry: source.url,
      npm_config_cache: join(root, `npm-${id}`),
    })
  ));
  for (const result of cold) {
    assertEquals(result.code, 0, result.output);
    assert(result.output.includes("1 passed | 0 failed"), result.output);
  }
  assertEquals(
    cold.reduce(
      (sum, result) =>
        sum + result.output.split("Preparing provider cache:").length - 1,
      0,
    ),
    1,
    "Concurrent test tasks must join one preparation",
  );
  await validateProviderCache(cache);
  assertEquals(source.unexpected, []);
  assert(source.requests.includes("/@opencode-ai/plugin"));
  assert(source.requests.some((path) => path.endsWith(".tgz")));
  const installed = JSON.parse(
    await Deno.readTextFile(join(cache, "dependencies/package-lock.json")),
  );
  assert(
    installed.packages["node_modules/@opencode-ai/plugin"].resolved
      .startsWith(source.url + "/"),
    "Cold preparation must install from this test's local source",
  );
  await source.shutdown();
  const ready = await Deno.stat(join(cache, "ready.json"));
  let requests = 0;
  const registry = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      requests++;
      return new Response("registry denied", { status: 503 });
    },
  );
  resources().defer("offline task registry", () => registry.shutdown());
  const offline = await run({
    npm_config_registry: `http://127.0.0.1:${
      (registry.addr as Deno.NetAddr).port
    }`,
    npm_config_offline: "true",
  });
  assertEquals(offline.code, 0, offline.output);
  assert(offline.output.includes("1 passed | 0 failed"), offline.output);
  assertEquals(
    requests,
    0,
    "A prepared task must not attempt package installation",
  );
  assertEquals((await Deno.stat(join(cache, "ready.json"))).mtime, ready.mtime);
});
