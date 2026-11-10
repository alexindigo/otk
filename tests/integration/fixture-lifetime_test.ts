// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { nativeFixture } from "../support/native-fixture.ts";
import { resources, test, withResources } from "../support/resources.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { serve } from "../support/http.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import { nativeBehavior } from "../support/native-testing.ts";
import { nativeKind } from "../support/native.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const v1Test = v1NativeTests(
  "V1 npm custom tools and restarted tool registry",
  [
    "tests/integration/v2-fixture-readiness_test.ts#OC2R1",
    "tests/integration/fixture-lifetime_test.ts#OC2R2",
    "tests/integration/fixture-lifetime_test.ts#OC2R3",
  ],
);

async function closed(url: string) {
  await assertRejects(() => fetch(url, { signal: AbortSignal.timeout(1000) }));
}

test("native endpoint cancellation joins pending admission without opening an upstream socket", async () => {
  const native = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let listening = true;
  const stopNative = resources().defer("unready native listener", () => {
    if (listening) native.close();
    listening = false;
  });
  let upstream: Deno.TcpConn | undefined;
  resources().defer("unexpected upstream socket", () => upstream?.close());
  const accepted = native.accept().then(
    (connection) => {
      upstream = connection;
      return true;
    },
    (error) => {
      if (
        !(error instanceof Deno.errors.BadResource ||
          error instanceof Deno.errors.Interrupted)
      ) throw error;
      return false;
    },
  );
  const ready = Promise.withResolvers<void>();
  const endpoint = new FreezeProxy((native.addr as Deno.NetAddr).port, {
    ready: ready.promise,
  });
  const client = await Deno.connect({
    hostname: "127.0.0.1",
    port: endpoint.port,
  });
  resources().defer("queued native client", () => client.close());
  await client.write(
    new TextEncoder().encode("GET /global/health HTTP/1.0\r\n\r\n"),
  );
  await waitFor(() => endpoint.connections, (count) => count >= 1);
  await endpoint.stop();
  await stopNative();
  assertEquals(
    await accepted,
    false,
    "Unready native received an early connection",
  );
  assertEquals(endpoint.connections, 0);
  await closed(`http://127.0.0.1:${endpoint.port}`);
});

test("native endpoint forwards queued bytes after readiness without changing their response", async () => {
  let admitted = false;
  const native = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      Response.json({
        admitted,
        path: new URL(request.url).pathname,
        witness: request.headers.get("x-witness"),
      }),
  );
  resources().defer("ready native listener", () => native.shutdown());
  const ready = Promise.withResolvers<void>();
  const endpoint = new FreezeProxy((native.addr as Deno.NetAddr).port, {
    ready: ready.promise,
  });
  const response = fetch(`http://127.0.0.1:${endpoint.port}/global/health`, {
    headers: { "x-witness": "queued native request" },
    signal: AbortSignal.timeout(5000),
  });
  await waitFor(() => endpoint.connections, (count) => count >= 1);
  admitted = true;
  ready.resolve();
  assertEquals(await (await response).json(), {
    admitted: true,
    path: "/global/health",
    witness: "queued native request",
  });
  await endpoint.stop();
});

test("failed native preparation unwinds its provider and removes its TMPDIR workspace before rejecting", async () => {
  let root = "";
  const failure = new Error("forced native preparation failure");
  assertEquals(
    await assertRejects(() =>
      nativeBehavior({
        prepare(oc) {
          root = oc.root;
          throw failure;
        },
      })
    ),
    failure,
  );
  await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
});

v1Test(
  "failed native restart terminates its newly acquired process before rejecting",
  async () => {
    const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.origin === oc.nativeURL &&
          url.pathname === "/experimental/tool/ids"
        ? Promise.resolve(
          new Response("forced restart failure", { status: 503 }),
        )
        : originalFetch(input, init);
    };
    try {
      await assertRejects(() => oc.restart(), Error, "forced restart failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
    await closed(oc.url);
  },
);

v1Test(
  "pre-populated packages serve independent native tools and complete provider replies with registry requests denied",
  async () => {
    let requests = 0;
    const registry = serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      () => {
        requests++;
        return new Response("registry deliberately unavailable", {
          status: 503,
        });
      },
    );
    resources().defer("denied registry", () => registry.shutdown());
    const address = `http://127.0.0.1:${(registry.addr as Deno.NetAddr).port}`;
    for (let i = 0; i < 2; i++) {
      await withResources(`offline isolated native ${i}`, async () => {
        const f = await nativeFixture({}, {
          env: { npm_config_registry: address, npm_config_offline: "true" },
          async prepare(oc) {
            const directory = `${oc.directory}/.opencode/tools`;
            await Deno.mkdir(directory, { recursive: true });
            await Deno.writeTextFile(
              `${directory}/offline_probe.ts`,
              "export default {description:'Offline dependency probe',args:{},async execute(){return 'Ready'}};",
            );
          },
        });
        assert(
          (await f.oc.request<string[]>("/experimental/tool/ids")).includes(
            "offline_probe",
          ),
        );
        const session = await f.oc.session<{ id: string }>("/session", {
          method: "POST",
          body: { title: `Offline ${i}` },
        });
        const reply = `Offline provider reply ${i}`;
        f.fake.queue({ chunks: [reply] });
        await f.oc.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          body: { parts: [{ type: "text", text: `Offline prompt ${i}` }] },
        });
        await waitFor(
          () =>
            f.oc.request<
              {
                info: { role: string; time: { completed?: number } };
                parts: { text?: string }[];
              }[]
            >(`/session/${session.id}/message`),
          (messages) =>
            messages.some((message) =>
              message.info.role === "assistant" &&
              !!message.info.time.completed && message.parts.some((part) =>
                part.text === reply
              )
            ),
        );
        assert(
          f.fake.requests.some((request) =>
            JSON.stringify(request).includes(`Offline prompt ${i}`)
          ),
        );
      });
    }
    assertEquals(
      requests,
      0,
      "Ordinary isolated fixtures attempted live package installation",
    );
  },
);

Deno.test({
  name:
    "OC2R2 bundled providers serve independent native fixtures and complete replies with registry requests denied",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 offline provider recipe", async () => {
      let requests = 0;
      const registry = serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () => {
          requests++;
          return new Response("registry denied", { status: 503 });
        },
      );
      resources().defer("V2 denied registry", () => registry.shutdown());
      const previous = Deno.env.get("npm_config_registry");
      Deno.env.set(
        "npm_config_registry",
        `http://127.0.0.1:${registry.addr.port}`,
      );
      resources().defer("restore registry", () =>
        previous === undefined
          ? Deno.env.delete("npm_config_registry")
          : Deno.env.set("npm_config_registry", previous));
      for (let i = 0; i < 2; i++) {
        await withResources(`V2 offline native ${i}`, async () => {
          const fake = new FakeLlm(), native = await OpencodeV2Test.start(fake);
          const target = await native.createSession(`Offline V2 ${i}`),
            text = `Offline V2 reply ${i}`;
          fake.queue({ chunks: [text] });
          await native.prompt(target.id, `Offline V2 prompt ${i}`);
          await native.api.experimental.session.wait({
            sessionID: target.nativeID,
          });
          const page = await native.api.message.list({
            sessionID: target.nativeID,
            limit: 20,
            order: "desc",
          });
          assert(page.data.some((row) =>
            row.type === "assistant" && row.time.completed !== undefined &&
            row.content.some((part) =>
              part.type === "text" && part.text === text
            )
          ));
          assert(fake.requests.some((request) =>
            JSON.stringify(request).includes(`Offline V2 prompt ${i}`)
          ));
          await assertRejects(
            () =>
              Deno.stat(native.root + "/config/opencode/node_modules"),
            Deno.errors.NotFound,
          );
        });
      }
      assertEquals(
        requests,
        0,
        "Bundled providers must not install V1 plugin packages",
      );
    }),
});

Deno.test({
  name:
    "OC2R3 failed V2 catalog readiness terminates the newly acquired native listener",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 failed readiness", async () => {
      const original = globalThis.fetch;
      let endpoint = "";
      globalThis.fetch = (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname === "/api/model") {
          endpoint = url.origin;
          return Promise.resolve(
            new Response("forced V2 catalog failure", { status: 503 }),
          );
        }
        return original(input, init);
      };
      try {
        await assertRejects(() => OpencodeV2Test.start(new FakeLlm()));
      } finally {
        globalThis.fetch = original;
      }
      assert(endpoint);
      await closed(endpoint);
    }),
});
