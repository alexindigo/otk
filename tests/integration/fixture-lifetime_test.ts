// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { browserFixture } from "../support/browser-fixture.ts";
import { resources, test, withResources } from "../support/resources.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { serve } from "../support/http.ts";

async function closed(url: string) {
  await assertRejects(() => fetch(url, { signal: AbortSignal.timeout(1000) }));
}

test("failed native preparation unwinds its provider and removes its TMPDIR workspace before rejecting", async () => {
  let root = "";
  const failure = new Error("forced native preparation failure");
  assertEquals(
    await assertRejects(() =>
      browserFixture(undefined, {
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

test("forced browser body and evidence failures retain the body error and close every service", async () => {
  let root = "", provider = "", native = "", sidecar = "";
  let disposed = false;
  const failure = new Error("forced body failure after all acquisitions");
  const result = await assertRejects(
    () =>
      withResources("forced full fixture failure", async () => {
        const f = await browserFixture();
        root = f.oc.root;
        provider = `http://127.0.0.1:${f.fake.port}`;
        native = f.oc.url;
        const server = await f.sidecar();
        sidecar = server.url;
        const browser = await f.browser(server.url);
        browser.evaluate = () =>
          Promise.reject(new Error("forced evidence capture failure"));
        resources().defer("later cleanup still runs", () => {
          disposed = true;
        });
        resources().defer("forced disposer failure", () => {
          throw new Error("forced disposer failure");
        });
        throw failure;
      }),
    AggregateError,
  );
  assertEquals(result.errors[0], failure);
  assert(disposed);
  await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  for (const url of [provider, native, sidecar]) await closed(url);
});

test("failed native restart terminates its newly acquired process before rejecting", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === oc.url && url.pathname === "/experimental/tool/ids"
      ? Promise.resolve(new Response("forced restart failure", { status: 503 }))
      : originalFetch(input, init);
  };
  try {
    await assertRejects(() => oc.restart(), Error, "forced restart failure");
  } finally {
    globalThis.fetch = originalFetch;
  }
  await closed(oc.url);
});

test("pre-populated packages serve independent native tools and complete provider replies with registry requests denied", async () => {
  let requests = 0;
  const registry = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      requests++;
      return new Response("registry deliberately unavailable", { status: 503 });
    },
  );
  resources().defer("denied registry", () => registry.shutdown());
  const address = `http://127.0.0.1:${(registry.addr as Deno.NetAddr).port}`;
  for (let i = 0; i < 2; i++) {
    await withResources(`offline isolated native ${i}`, async () => {
      const f = await browserFixture({}, {
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
      const session = await f.oc.request<{ id: string }>("/session", {
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
});
