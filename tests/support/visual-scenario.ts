// SPDX-License-Identifier: LGPL-3.0-only
import { fixture } from "./config.ts";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";
/** Public external-backend chrome states, preserving the legacy fixture owner. */
export async function visualScenario() {
  const root = await fixture(),
    f = await inboxBrowserFixture(root),
    c = new WsClient(f.url);
  await c.connect();
  resources().defer("visual control client", () => c.close());
  for (let n = 1; n < 12; n++) {
    f.add({
      ...f.entries[0],
      id: `tstv1-visual-${n}`,
      title: `Session ${n} with a deliberately long name`,
    });
  }
  await c.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await c.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
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
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign visual lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Visual scene already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: f.entries[0].directory,
            baseline,
          };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { entries: f.entries, frames: c.frames };
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action !== "hold") {
            throw new Error(
              "Unknown visual scene action",
            );
          }
          if (frame.params.sessionID !== undefined) {
            if (frame.params.sessionID !== "tstv1-row-action-phantom") {
              throw new Error("Unknown visual activity identity");
            }
            f.add({
              ...f.entries[0],
              id: frame.params.sessionID,
              title: "Working",
              status: "busy",
            });
            return null;
          }
          f.update("tstv1-otk", { status: "busy" });
          f.update("tstv1-atmosphera", {
            attention: { ...f.entries[1].attention, permissions: 1 },
          });
          f.update("tstv1-globnotes", { status: "busy" });
          f.update("tstv1-globnotes", { status: "idle" });
          return null;
        case "stop":
          await c.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside visual scene");
      }
    },
  };
}
