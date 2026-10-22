// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_PREFS, type Preferences } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
test("prefs RPC persists across sidecar restart and broadcasts to other connections", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const clients: WsClient[] = [], servers: SidecarTest[] = [];
  try {
    const server = await SidecarTest.start(oc);
    servers.push(server);
    const a = new WsClient(server.url), b = new WsClient(server.url);
    clients.push(a, b);
    await a.connect();
    await b.connect();
    assertEquals(await a.rpc("prefs.get", {}), DEFAULT_PREFS);
    await assertRejects(() =>
      a.rpc("prefs.set", { key: "thinking", value: "minimal" })
    );
    await a.rpc("prefs.set", { key: "thinking", value: "show" });
    await b.wait((frame) =>
      frame.t === "prefs" && frame.prefs.thinking === "show"
    );
    await assertRejects(() =>
      a.rpc("prefs.set", { key: "keymap", value: ["Ctrl+j"] })
    );
    const keymap = { "palette.open": "Ctrl+j" };
    await a.rpc("prefs.set", { key: "keymap", value: keymap });
    await b.wait((frame) =>
      frame.t === "prefs" && frame.prefs.keymap["palette.open"] === "Ctrl+j"
    );
    await assertRejects(() =>
      a.rpc("prefs.set", { key: "theme", value: "invalid theme" })
    );
    await a.rpc("prefs.set", { key: "theme", value: "extra-theme" });
    await b.wait((frame) =>
      frame.t === "prefs" && frame.prefs.theme === "extra-theme"
    );
    await a.rpc("prefs.set", { key: "theme", value: "otk-light" });
    await b.wait((frame) =>
      frame.t === "prefs" && frame.prefs.theme === "otk-light"
    );
    for (
      const key of [
        "notify.toast",
        "notify.os",
        "notify.sound",
        "notify.badge",
      ] as const
    ) {
      await assertRejects(() => a.rpc("prefs.set", { key, value: "true" }));
      await a.rpc("prefs.set", { key, value: !DEFAULT_PREFS[key] });
      await b.wait((frame) =>
        frame.t === "prefs" && frame.prefs[key] === !DEFAULT_PREFS[key]
      );
    }
    // Independent connections need no observed broadcast before their next intent.
    const layout = {
      ...DEFAULT_PREFS.shellLayout,
      leftWidth: 360,
      leftCollapsed: true,
      rightCollapsed: false,
      rightWidth: 400,
      rightView: "external-view",
    };
    await Promise.all([
      a.rpc("layout.patch", { leftWidth: layout.leftWidth }),
      b.rpc("layout.patch", { leftCollapsed: layout.leftCollapsed }),
      a.rpc("layout.patch", { rightCollapsed: layout.rightCollapsed }),
      b.rpc("layout.patch", { rightWidth: layout.rightWidth }),
      a.rpc("layout.patch", { rightView: layout.rightView }),
    ]);
    for (const client of [a, b]) {
      const frame = await client.wait((frame) =>
        frame.t === "prefs" &&
        frame.prefs.shellLayout.leftWidth === layout.leftWidth &&
        frame.prefs.shellLayout.leftCollapsed === layout.leftCollapsed &&
        frame.prefs.shellLayout.rightCollapsed === layout.rightCollapsed &&
        frame.prefs.shellLayout.rightWidth === layout.rightWidth &&
        frame.prefs.shellLayout.rightView === layout.rightView
      );
      assertEquals(frame.t === "prefs" && frame.prefs.shellLayout, layout);
      assertEquals(
        (await client.rpc<Preferences>("prefs.get", {})).shellLayout,
        layout,
      );
    }
    for (
      const patch of [
        { leftWidth: 199 },
        { leftWidth: 361 },
        { leftCollapsed: "true" },
        { rightCollapsed: null },
        { unknown: true },
        { leftWidth: 200, rightCollapsed: "false" },
        { rightWidth: 279 },
        { rightWidth: 481 },
        { rightView: 1 },
        { rightView: "x".repeat(129) },
      ]
    ) {
      await assertRejects(() => a.rpc("layout.patch", patch));
      assertEquals(
        (await b.rpc<Preferences>("prefs.get", {})).shellLayout,
        layout,
        "An invalid field cannot partially save the remaining fields",
      );
    }
    await a.close();
    await b.close();
    await server.stop();
    const restarted = await SidecarTest.start(oc, {
      server: { port: server.port },
      state: { path: join(oc.root, `otk-${server.port}`) },
    });
    servers.push(restarted);
    const c = new WsClient(restarted.url);
    clients.push(c);
    await c.connect();
    assertEquals((await c.rpc<Preferences>("prefs.get", {})).thinking, "show");
    assertEquals((await c.rpc<Preferences>("prefs.get", {})).keymap, keymap);
    assertEquals(
      (await c.rpc<Preferences>("prefs.get", {})).shellLayout,
      layout,
    );
    assertEquals(
      (await c.rpc<Preferences>("prefs.get", {})).theme,
      "otk-light",
    );
    const notificationPrefs = await c.rpc<Preferences>("prefs.get", {});
    for (
      const key of [
        "notify.toast",
        "notify.os",
        "notify.sound",
        "notify.badge",
      ] as const
    ) assertEquals(notificationPrefs[key], !DEFAULT_PREFS[key]);
    const other = await SidecarTest.start(oc);
    servers.push(other);
    const d = new WsClient(other.url);
    clients.push(d);
    await d.connect();
    assertEquals(await d.rpc("prefs.get", {}), DEFAULT_PREFS);
  } finally {
    for (const client of clients) await client.close();
    for (const server of servers) await server.stop();
    await oc.stop();
    await fake.stop();
  }
});
