// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";

Deno.test("native fixture admission joins custom-tool dependency readiness rather than HTTP health", async () => {
  const fetchNative = globalThis.fetch;
  const held = Promise.withResolvers<void>();
  const healthParsed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let released = false, probing = false, returned = false;
  let instance: OpencodeTest | undefined,
    catalog: Promise<string[]> | undefined;
  const registry = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (!released) {
        held.resolve();
        await release.promise;
      }
      const response = await fetchNative(
        "https://registry.npmjs.org" + url.pathname + url.search,
        { signal: AbortSignal.timeout(30_000) },
      );
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    },
  );
  const fake = new FakeLlm();
  const env: Record<string, string> = {
    npm_config_registry: `http://127.0.0.1:${
      (registry.addr as Deno.NetAddr).port
    }`,
  };
  // Return health only after the actual tool-registry read is blocked behind
  // controlled native dependency I/O. This fixes the execution ordering without
  // a quiet interval, artificial user message or product testing hook.
  globalThis.fetch = async (input, init) => {
    const response = await fetchNative(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/global/health" && !probing) {
      const json = response.json.bind(response);
      response.json = async () => {
        const body = await json();
        if (body.healthy && !probing) {
          probing = true;
          const target = new URL("/experimental/tool/ids", instance!.url);
          target.searchParams.set("directory", instance!.directory);
          catalog = fetchNative(target, { signal: AbortSignal.timeout(60_000) })
            .then((response) => response.json());
          await held.promise;
          healthParsed.resolve();
        }
        return body;
      };
    }
    return response;
  };
  const started = OpencodeTest.start(fake, {}, {
    env,
    async prepare(test) {
      instance = test;
      env.npm_config_cache = join(test.root, "npm-cache");
      await Deno.mkdir(join(test.directory, ".opencode/tools"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(test.directory, ".opencode/tools/readiness_probe.ts"),
        "export default {description:'Readiness probe',args:{},async execute(){return 'Ready'}};",
      );
    },
  }).then((test) => {
    returned = true;
    return test;
  });
  try {
    await healthParsed.promise;
    // A new task follows all continuations of the just-delivered health body.
    // Remaining dependency work cannot settle because the registry is held.
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
    assertEquals(
      returned,
      false,
      "HTTP health published a fixture whose tool owner was still waiting for dependencies",
    );
    released = true;
    release.resolve();
    const fixture = await started;
    assert((await catalog!).includes("readiness_probe"));
    assertEquals(
      await fixture.request<string[]>("/experimental/tool/ids"),
      await catalog!,
    );
    assertEquals(
      fake.requests,
      [],
      "Readiness must not manufacture an LLM prompt",
    );
  } finally {
    released = true;
    release.resolve();
    globalThis.fetch = fetchNative;
    await catalog;
    await started.then((test) => test.stop());
    await fake.stop();
    await registry.shutdown();
  }
});
