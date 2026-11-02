// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Cdp } from "./cdp.ts";
import { messagesScenario } from "./messages-scenario.ts";
import type { Json, Profile, TestLease } from "./fixture-control.ts";
import type { AssistantMessage, Message, Part } from "@otk/protocol";
import { fixture } from "./config.ts";
import { coreBackendFixture } from "./core-backend.ts";
import { WsClient } from "./ws-client.ts";
import type { Capabilities } from "@otk/harness";

export const visualText = (id: string, text: string): Part => ({
  id,
  kind: "text",
  synthetic: false,
  blocks: [{ b: "paragraph", inline: [{ i: "text", text }] }],
});
export const visualReply = (
  id: string,
  parts: Part[],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  id,
  sessionID: "tstv1-core",
  role: "assistant",
  replyTo: "prompt",
  agent: "build",
  model: { provider: "fake", model: "scripted" },
  time: { created: 2000, completed: 6000 },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0,
  interrupted: false,
  parts,
  ...extra,
});
/** Fixed external-backend V snapshots; no replay of the transferred native journey. */
export async function legacyStaticMessages(
  theme: string,
  build: (root: string) => Message[],
  run: (scene: {
    b: Cdp;
    root: string;
    set(key: string, value: Json): Promise<void>;
    replace(messages: Message[]): Promise<void>;
    status(value: "busy" | "idle"): void;
    capture(name: string): Promise<void>;
  }) => Promise<void>,
  options: {
    capabilities?: Capabilities;
    configure?(f: Awaited<ReturnType<typeof coreBackendFixture>>): void;
  } = {},
) {
  const root = await fixture();
  let messages = build(root);
  const f = await coreBackendFixture(root, options.capabilities),
    client = new WsClient(f.url);
  options.configure?.(f);
  f.app.backend.core.listMessages = (_id, opts) =>
    Promise.resolve(f.page(messages, opts.before));
  const b = await Cdp.launch(root);
  try {
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.goto(f.url + "/#/local/tstv1-core");
    await b.poll(
      "Number(document.querySelector('.otk-message-flow')?.dataset.messageCount)>0",
    );
    await run({
      b,
      root,
      set: async (key, value) => {
        await client.rpc("prefs.set", { key, value });
      },
      replace: async (next) => {
        messages = next;
        await b.reload();
        await b.poll(
          "Number(document.querySelector('.otk-message-flow')?.dataset.messageCount)>0",
        );
      },
      status: (status) =>
        f.app.index.upsert({ ...f.app.index.get("tstv1-core")!, status }),
      capture: async (name) => {
        await b.evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(root, `${theme}-${name}.png`));
      },
    });
    assertEquals(b.errors, []);
  } catch (error) {
    await Deno.writeTextFile(
      join(root, "failed-scene.html"),
      await b.evaluate<string>("document.documentElement.outerHTML"),
    );
    await Deno.writeTextFile(
      join(root, "failed-scene-frames.json"),
      JSON.stringify(b.events),
    );
    await b.screenshot(join(root, "failed-scene.png"));
    throw error;
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
}
/** T2's temporary fixed-state V owner. Journeys live in Playwright; T3 removes this. */
export async function legacyMessageScene(
  profile: Profile,
  theme: string,
  run: (
    scene: {
      b: Cdp;
      url: string;
      root: string;
      set(key: string, value: Json): Promise<void>;
      layout(params: Json): Promise<void>;
      capture(name: string): Promise<void>;
      mutate(action: "release" | "succeed" | "fail"): Promise<void>;
    },
  ) => Promise<void>,
  sessionID = "tstv1-core",
) {
  const scene = await messagesScenario(profile),
    lease = await scene.dispatch({
      v: 1,
      id: "begin",
      command: "beginTest",
      params: { identity: "legacy-visual" },
    }) as TestLease;
  const rpc = async (method: string, params: Json) =>
    await scene.dispatch({
      v: 1,
      id: crypto.randomUUID(),
      command: "productRpc",
      params: { lease: lease.lease, method, params },
    });
  const b = await Cdp.launch(scene.info.root);
  try {
    await rpc("prefs.set", { key: "theme", value: theme });
    await rpc("prefs.set", { key: "animationsOff", value: true });
    await b.goto(scene.info.url + "/#/local/" + sessionID);
    await b.poll(
      `document.documentElement.dataset.otkTheme===${
        JSON.stringify(theme)
      }&&!!document.querySelector('.otk-message-flow')`,
    );
    await run({
      b,
      url: scene.info.url,
      root: scene.info.root,
      set: async (key, value) => {
        await rpc("prefs.set", { key, value });
      },
      layout: async (params) => {
        await rpc("layout.patch", params);
      },
      capture: async (name) => {
        await b.evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(scene.info.root, `${theme}-${name}.png`));
      },
      mutate: async (action) => {
        await scene.dispatch({
          v: 1,
          id: crypto.randomUUID(),
          command: "scenario",
          params: { lease: lease.lease, action },
        });
      },
    });
    assertEquals(b.errors, []);
  } finally {
    await b.close();
    await scene.dispatch({
      v: 1,
      id: "end",
      command: "endTest",
      params: { lease: lease.lease },
    });
    await scene.dispatch({ v: 1, id: "stop", command: "stop", params: {} });
  }
}
