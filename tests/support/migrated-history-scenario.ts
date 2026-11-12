// SPDX-License-Identifier: LGPL-3.0-only
import {
  mapMessage,
  type NativeMessage,
} from "@otk/harness-opencode-v2-server";
import { fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

export async function migratedHistoryScenario() {
  const fixtureData = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../packages/harness-opencode-v2-server/tests/migrated-history-fixture.json",
        import.meta.url,
      ),
    ),
  );
  const root = await fixture(), sessionID = "tstv1-otk";
  const messages = (fixtureData.v2 as unknown as NativeMessage[]).flatMap(
    (m, order) => {
      const value = mapMessage(m, sessionID, { order, replyTo: "prompt" });
      return value?.role === "assistant" ? [value] : [];
    },
  );
  const f = await inboxBrowserFixture(root, [], { [sessionID]: messages });
  const client = new WsClient(f.url);
  await client.connect(f.entries[0].directory);
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  let lease: TestLease | undefined;
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign migrated-history lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { frames: client.frames };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "stop":
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside migrated-history scenario");
      }
    },
  };
}
