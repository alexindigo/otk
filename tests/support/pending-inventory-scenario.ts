// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import { startApplication } from "../../application.ts";
import { pendingInventoryFixture } from "./pending-inventory.ts";
import { cfg, fixture } from "./config.ts";
import { WsClient } from "./ws-client.ts";
import { resources } from "./resources.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

/** The shipped application consumes real adapter inventory/resync publications. */
export async function pendingInventoryScenario() {
  const root = await fixture(),
    f = await pendingInventoryFixture(root),
    settings = cfg();
  settings.auth.type = "none";
  settings.server.port = 0;
  settings.state.path = root + "/state";
  const app = await startApplication(
    settings,
    f.adapter,
    fromFileUrl(new URL("../../web/dist/", import.meta.url)),
  );
  resources().defer("pending inventory application", () => app.stop());
  // Keep the global form: its independent project-attention path must obey the
  // same fresh-only contract as session supervision without losing its payload.
  const url = `http://127.0.0.1:${app.server.addr.port}`;
  const client = new WsClient(url);
  await client.connect(f.directory);
  resources().defer("pending inventory client", () => client.close());
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root,
    url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [app.server.addr.port],
  };
  const registration = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (registration) {
    await Deno.writeTextFile(registration, JSON.stringify(info));
  }
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign pending inventory lease");
      switch (frame.command) {
        case "beginTest":
          lease = {
            lease: crypto.randomUUID(),
            directory: f.directory,
            baseline,
          };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            directory: f.directory,
            dropped: f.dropped,
            form: "opcv2-ses_form",
            permission: "opcv2-ses_permission",
            drop: "opcv2-ses_dropped",
            inboxReads:
              f.reads.filter((path) => path.endsWith("/inbox")).length,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "scenario":
          if (frame.params.action === "fail") {
            f.control.inboxStatus = 404;
            f.control.empty = new Set(["permission", "form"]);
            await f.reconnect();
            return null;
          }
          if (
            frame.params.action === "hold" || frame.params.action === "freeze"
          ) {
            const kind = frame.params.action === "hold" ? "form" : "permission";
            f.control.failure = kind;
            f.control.empty.add(kind === "form" ? "permission" : "form");
          } else if (frame.params.action === "release") {
            f.control.failure = "";
            f.control.empty = new Set(["permission", "form"]);
          } else if (frame.params.action === "succeed") {
            f.control.failure = "";
          } else if (frame.params.action === "disconnect") {
            f.control
              .locations = [];
          } else if (frame.params.action === "thaw") {
            f
              .control.locations = [
                f.directory,
                f.dropped,
              ];
          } else {throw new Error(
              "Unknown pending inventory scenario transition",
            );}
          await f.reconnect();
          return null;
        case "stop":
          await client.close();
          await app.stop();
          return null;
        default:
          throw new Error("Command outside pending inventory fixture");
      }
    },
  };
}
